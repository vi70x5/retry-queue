// Animamesh — DHT announce / publish module
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §8 (Publish Flow)

import type { KadDHT } from "@libp2p/kad-dht";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import type { Libp2p } from "libp2p";
import { rendezvousCID, rendezvousKey } from "./dht.js";
import type { PublicProxyRecord } from "./types.js";

// ---------------------------------------------------------------------------
// DHT announce (provider record publish)
// ---------------------------------------------------------------------------

/**
 * Publish the local node as a provider for both:
 * 1. `animamesh:v1:{networkId}:all`   (cross-protocol discovery)
 * 2. `animamesh:v1:{networkId}:{protocol}` (protocol-specific discovery)
 *
 * The record itself is NOT stored in the DHT — only the provider record
 * (mapping CID → peer ID + multiaddrs) is published.  A consumer that
 * discovers this node then dials `/animamesh/proxy-record/1.0.0` to
 * retrieve the signed `PublicProxyRecord` directly.
 *
 * Errors are silently swallowed (best-effort).  Logging is the caller's
 * responsibility.
 */
export async function announceRecord(
	node: Libp2p,
	dht: KadDHT,
	record: PublicProxyRecord,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const networkId = record.networkId;
	const protocol: "vless" | "hysteria2" = record.protocol;

	const [allCID, protoCID] = await Promise.all([
		rendezvousCID(rendezvousKey(networkId, "all")),
		rendezvousCID(rendezvousKey(networkId, protocol)),
	]);

	await Promise.allSettled([
		dht.provide(allCID, options),
		dht.provide(protoCID, options),
	]);
}

// ---------------------------------------------------------------------------
// Record server — protocol handler
// ---------------------------------------------------------------------------

let _serverRunning = false;

/**
 * Register a libp2p protocol handler for `/animamesh/proxy-record/1.0.0`.
 *
 * When a consumer dials this protocol, the handler:
 * 1. Consumes any incoming data (protocol is one-way — request body is empty).
 * 2. Writes one length-prefixed JSON `PublicProxyRecord`.
 * 3. Closes the stream.
 *
 * This is a static response — the record is captured at server start time.
 * Call `stopRecordServer` to unregister the handler.
 */
export function startRecordServer(
	node: Libp2p,
	record: PublicProxyRecord,
): void {
	if (_serverRunning) {
		return;
	}

	const recordBytes = new TextEncoder().encode(JSON.stringify(record));

	node.handle("/animamesh/proxy-record/1.0.0", ({ stream }) => {
		// Send the record as a single length-prefixed JSON message.
		pipe([recordBytes], lp.encode(), stream).catch(() => {
			// Peer disconnected before reading — not an error.
		});
	});

	_serverRunning = true;
}

/**
 * Unregister the `/animamesh/proxy-record/1.0.0` protocol handler.
 */
export function stopRecordServer(node: Libp2p): void {
	if (!_serverRunning) {
		return;
	}

	node.unhandle("/animamesh/proxy-record/1.0.0");
	_serverRunning = false;
}
