// Animamesh — libp2p DHT rendezvous provider module
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §8

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { type KadDHT, kadDHT } from "@libp2p/kad-dht";
import { tcp } from "@libp2p/tcp";
import { createLibp2p, type Libp2p } from "libp2p";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// ---------------------------------------------------------------------------
// Rendezvous key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic rendezvous content key string.
 *
 * The DHT uses provider records keyed by this string (hashed to a CID).
 *
 * @param networkId  Logical mesh network (e.g. "animamesh-main").
 * @param protocol   "vless", "hysteria2", or "all" for cross-protocol discovery.
 */
export function rendezvousKey(
	networkId: string,
	protocol: "vless" | "hysteria2" | "all",
): string {
	return `animamesh:v1:${networkId}:${protocol}`;
}

/**
 * Convert a rendezvous key string into a CID for libp2p DHT operations.
 *
 * Uses SHA-256 of the UTF-8-encoded key string, then wraps it in a V1 CID
 * with the `raw` multicodec (0x00).
 */
export async function rendezvousCID(key: string): Promise<CID> {
	const bytes = new TextEncoder().encode(key);
	const hash = await sha256.digest(bytes);
	return CID.createV1(0x00, hash);
}

// ---------------------------------------------------------------------------
// libp2p node lifecycle
// ---------------------------------------------------------------------------

export interface StartNodeConfig {
	/** Multiaddrs to listen on (defaults to `/ip4/0.0.0.0/tcp/0`). */
	listenAddresses?: string[];
	/** Bootstrap peer multiaddrs for DHT bootstrapping. */
	bootstrapPeers: string[];
	/**
	 * When true, the node does NOT handle inbound DHT queries.
	 * Use for ephemeral GHA runners that cannot accept inbound traffic.
	 * @default true
	 */
	isClient?: boolean;
}

export interface StartedNode {
	/** The running libp2p node. */
	node: Libp2p;
	/** The Kademlia DHT service instance. */
	dht: KadDHT;
	/** Gracefully stop the node and all services. */
	stop: () => Promise<void>;
}

/**
 * Create and start a libp2p node configured for the Animamesh DHT mesh.
 *
 * Sets up:
 * - TCP transport (WebSocket transport is not included — add if needed)
 * - Noise encryption
 * - Yamux stream multiplexing
 * - Bootstrap peer discovery (peers from config)
 * - Kademlia DHT (client or full mode)
 * - Identify protocol
 *
 * After `start()`, the function waits up to 10 s for at least one bootstrap
 * peer to be discovered, then resolves.  The DHT becomes usable once the
 * routing table has peers — `dht.findProviders` and `dht.provide` will
 * operate eventually consistent.
 */
export async function startNode(config: StartNodeConfig): Promise<StartedNode> {
	const node = await createLibp2p({
		addresses: {
			listen: config.listenAddresses ?? ["/ip4/0.0.0.0/tcp/0"],
		},
		transports: [tcp()],
		connectionEncryptors: [noise()],
		streamMuxers: [yamux()],
		peerDiscovery: [
			bootstrap({
				list: config.bootstrapPeers,
				timeout: 10_000, // ms to wait for each bootstrapper connection
			}),
		],
		services: {
			identify: identify(),
			dht: kadDHT({
				clientMode: config.isClient ?? true,
			}),
		},
	});

	const dht: KadDHT = node.services.dht;

	// Start the node (bootstraps automatically)
	await node.start();

	// Wait for at least one peer to be discovered so the routing table has
	// entries before the caller tries DHT operations.  Fall through after
	// 10 s even if no peers arrived (the DHT will become usable lazily).
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => resolve(), 10_000);

		const onPeer = () => {
			clearTimeout(timer);
			resolve();
		};

		node.addEventListener("peer:discovery", onPeer, { once: true });

		// If the node already knows peers, resolve immediately
		if (node.getPeers().length > 0) {
			clearTimeout(timer);
			node.removeEventListener("peer:discovery", onPeer);
			resolve();
		}
	});

	return {
		node,
		dht,
		stop: async () => {
			await node.stop();
		},
	};
}

/**
 * Gracefully shut down a libp2p node.
 *
 * Closes all connections, stops all services, and releases resources.
 * Safe to call multiple times (subsequent calls are no-ops).
 */
export async function shutdownNode(node: Libp2p): Promise<void> {
	await node.stop();
}
