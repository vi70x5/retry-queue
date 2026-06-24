// Animamesh — DHT discovery and record fetching module
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §8 (Discover Flow)

import type { KadDHT } from "@libp2p/kad-dht";
import type { PeerId } from "@libp2p/peer-id";
import { peerIdFromString } from "@libp2p/peer-id";
import type { Multiaddr } from "@multiformats/multiaddr";
import { multiaddr } from "@multiformats/multiaddr";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import type { Libp2p } from "libp2p";
import { rendezvousCID, rendezvousKey } from "./dht.js";
import { isRecordExpired } from "./record.js";
import { verifyRecordSignature } from "./signing.js";
import type { DiscoveredRecord, PublicProxyRecord } from "./types.js";

// ---------------------------------------------------------------------------
// DHT provider discovery
// ---------------------------------------------------------------------------

export interface DiscoverProvidersOptions {
	/** Maximum time (ms) to wait for providers before returning. */
	timeout?: number;
	/** Optional AbortSignal to cancel the operation. */
	signal?: AbortSignal;
}

/**
 * Discover peers that have announced themselves as providers for the given
 * rendezvous key via the DHT.
 *
 * Calls `dht.findProviders()` on the CID derived from the rendezvous key
 * `animamesh:v1:{networkId}:{protocol}` and returns a list of `DiscoveredRecord`
 * entries containing peer identity and multiaddrs (without the actual
 * `PublicProxyRecord` — use `fetchRecord` to retrieve that).
 *
 * Times out after `options.timeout` ms (default 30 000) to avoid hanging
 * on sparse DHTs.
 */
export async function discoverProviders(
	node: Libp2p,
	dht: KadDHT,
	networkId: string,
	protocol: "vless" | "hysteria2" | "all",
	options?: DiscoverProvidersOptions,
): Promise<DiscoveredRecord[]> {
	const key = rendezvousKey(networkId, protocol);
	const cid = await rendezvousCID(key);

	const discoveredAt = new Date().toISOString();
	const peers: DiscoveredRecord[] = [];

	try {
		const timeout = options?.timeout ?? 30_000;

		// findProviders yields PeerInfo as they arrive
		for await (const peerInfo of dht.findProviders(cid, {
			signal: options?.signal,
			timeout,
		})) {
			if (!peerInfo.id) continue;

			peers.push({
				peerId: peerInfo.id.toString(),
				multiaddrs: peerInfo.multiaddrs.map((ma: Multiaddr) => ma.toString()),
				record: null as unknown as PublicProxyRecord, // placeholder; caller fetches
				discoveredAt,
			});
		}
	} catch (err: unknown) {
		// Timeout or abort — return whatever we found so far
		if (err instanceof Error && err.name === "AbortError") {
			// intentional abort, not an error
		}
	}

	return peers;
}

// ---------------------------------------------------------------------------
// Record fetching — dial and read
// ---------------------------------------------------------------------------

export interface FetchRecordOptions {
	/** Optional AbortSignal to cancel the operation. */
	signal?: AbortSignal;
}

/**
 * Dial a peer and fetch its `PublicProxyRecord` over the
 * `/animamesh/proxy-record/1.0.0` protocol.
 *
 * 1. Opens a stream to the peer using the given multiaddrs.
 * 2. Reads one length-prefixed JSON message.
 * 3. Parses and returns the `PublicProxyRecord`.
 *
 * Returns `null` on any error (dial failure, timeout, parse error) —
 * callers should treat null as "peer unreachable or misbehaving".
 */
export async function fetchRecord(
	node: Libp2p,
	peerId: PeerId,
	multiaddrs: Multiaddr[],
	options?: FetchRecordOptions,
): Promise<PublicProxyRecord | null> {
	try {
		const stream = await node.dialProtocol(
			peerId,
			["/animamesh/proxy-record/1.0.0"],
			{
				signal: options?.signal,
			},
		);

		const record = await pipe(stream, lp.decode(), async (source) => {
			for await (const buf of source) {
				const text = new TextDecoder().decode(buf.subarray());
				try {
					return JSON.parse(text) as PublicProxyRecord;
				} catch {
					return null;
				}
			}
			return null;
		});

		return record;
	} catch {
		// Dial failure, protocol not supported, timeout, etc.
		return null;
	}
}

// ---------------------------------------------------------------------------
// Combined discovery + fetch + verify
// ---------------------------------------------------------------------------

export interface DiscoverAndVerifyOptions {
	/** Maximum time (ms) to wait for providers. */
	timeout?: number;
	/** Optional AbortSignal to cancel the entire operation. */
	signal?: AbortSignal;
}

/**
 * Full discovery pipeline:
 *
 * 1. `discoverProviders` — find DHT provider records for the rendezvous key.
 * 2. `fetchRecord` — dial each provider and retrieve the signed record.
 * 3. Verify — validate the record's Ed25519 signature against the provided
 *    `publicKeyMap` ({ keyId → base64 public key }).
 *
 * Results are **deduplicated** by `nodeId` — for duplicate node IDs the
 * record with the most recent `heartbeatAt` is kept.
 *
 * Only records with all of the following are returned:
 * - Valid JSON `PublicProxyRecord` schema
 * - Not expired (`lifecycle.expiresAt` in the future)
 * - Correct `networkId`
 * - Correct `protocol`
 * - Matching public key ID in `publicKeyMap`
 * - Valid Ed25519 signature
 *
 * @param networkId     Expected network ID (records with mismatched IDs are
 *                      filtered out).
 * @param protocol      Expected protocol ("vless" | "hysteria2").
 * @param publicKeyMap  Map of trusted public key IDs to their base64-encoded
 *                      Ed25519 public keys.
 */
export async function discoverAndVerify(
	node: Libp2p,
	dht: KadDHT,
	networkId: string,
	protocol: string,
	publicKeyMap: Record<string, string>,
	options?: DiscoverAndVerifyOptions,
): Promise<DiscoveredRecord[]> {
	const providers = await discoverProviders(
		node,
		dht,
		networkId,
		protocol as "vless" | "hysteria2" | "all",
		options,
	);

	if (providers.length === 0) return [];

	const signal = options?.signal;
	const discoveredAt = new Date().toISOString();

	// Fetch records from all discovered providers concurrently
	const results = await Promise.allSettled(
		providers.map(async (p) => {
			if (signal?.aborted) return null;

			const peerId = parsePeerId(p.peerId);
			if (!peerId) return null;

			const addrs = p.multiaddrs.map((ma: string) => multiaddrFromString(ma));
			const record = await fetchRecord(node, peerId, addrs, { signal });
			return { ...p, record, discoveredAt } as DiscoveredRecord;
		}),
	);

	// Filter and verify results
	const valid: DiscoveredRecord[] = [];

	for (const result of results) {
		if (result.status !== "fulfilled" || !result.value?.record) continue;

		const entry = result.value;
		const rec = entry.record;

		// Structural checks
		if (rec.schema !== "animamesh.proxy.v1") continue;
		if (rec.networkId !== networkId) continue;
		if (rec.protocol !== protocol) continue;
		if (isRecordExpired(rec)) continue;

		// Signature verification
		const publicKey = publicKeyMap[rec.publicKeyId];
		if (!publicKey) continue;

		const verified = await verifyRecordSignature(rec, publicKey);
		if (!verified) continue;

		valid.push(entry);
	}

	// Deduplicate by nodeId — keep the newest heartbeat
	return deduplicateByNodeId(valid);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of DiscoveredRecords by `nodeId`, keeping the entry
 * with the most recent `heartbeatAt`.
 */
function deduplicateByNodeId(records: DiscoveredRecord[]): DiscoveredRecord[] {
	const map = new Map<string, DiscoveredRecord>();

	for (const entry of records) {
		const existing = map.get(entry.record.nodeId);
		if (
			!existing ||
			entry.record.lifecycle.heartbeatAt > existing.record.lifecycle.heartbeatAt
		) {
			map.set(entry.record.nodeId, entry);
		}
	}

	return Array.from(map.values());
}

/**
 * Parse a peer ID string into a PeerId object.
 * Returns null for invalid strings.
 */
function parsePeerId(id: string): PeerId | null {
	try {
		return peerIdFromString(id);
	} catch {
		return null;
	}
}

/**
 * Parse a multiaddr string into a Multiaddr object.
 * Throws on parse failure (dials will fail gracefully).
 */
function multiaddrFromString(ma: string): Multiaddr {
	return multiaddr(ma);
}
