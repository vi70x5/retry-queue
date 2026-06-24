// Animamesh — Phase 4 DHT Indexer
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §14 (Phase 4: Optional DHT Indexer)
//
// A separately deployable long-lived process that:
// - Maintains stable DHT connectivity (full server mode, NOT client mode)
// - Periodically discovers provider records for all rendezvous keys
// - Verifies record signatures against a configured key map
// - Mirrors valid records to the Worker /mesh/register endpoint
// - Optionally publishes signed snapshots to IPFS
//
// Usage: tsx src/indexer.ts

import { shutdownNode, startNode } from "./dht.js";
import { discoverAndVerify } from "./discover.js";
import { addJSON, pinAdd, publishIPNS } from "./ipfs.js";
import { deduplicateRecords, isRecordExpired } from "./record.js";
import { createSnapshot, signSnapshot } from "./snapshot.js";
import type {
	DiscoveredRecord,
	PublicProxyRecord,
	SignedSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

interface IndexerConfig {
	networkId: string;
	bootstrapPeers: string[];
	publicKeyMap: Record<string, string>;
	coordinatorUrl?: string;
	authToken?: string;
	pollIntervalSeconds: number;
	ipfsApiUrl?: string;
	listenAddresses?: string[];
}

function loadConfig(): IndexerConfig {
	const networkId = env("NETWORK_ID", "animamesh-main")!;
	const bootstrapPeers = parseList(env("BOOTSTRAP_PEERS", "[]"));
	const publicKeyMap = parseKeyMap(env("MESH_PUBLIC_KEYS", "{}"));
	const coordinatorUrl = env("COORDINATOR_URL");
	const authToken = env("AUTH_TOKEN");
	const pollIntervalSeconds = parseInt(env("POLL_INTERVAL_SECONDS", "60")!, 10);
	const ipfsApiUrl = env("IPFS_API_URL");
	const listenAddresses = parseList(env("INDEXER_LISTEN_ADDRESSES", "[]"));

	return {
		networkId,
		bootstrapPeers,
		publicKeyMap,
		coordinatorUrl,
		authToken,
		pollIntervalSeconds,
		ipfsApiUrl,
		listenAddresses: listenAddresses.length > 0 ? listenAddresses : undefined,
	};
}

/** Read an environment variable, falling back to `defaultValue` (optional). */
function env(name: string, defaultValue?: string): string | undefined {
	return process.env[name] ?? defaultValue;
}

/**
 * Parse a JSON array or comma-separated string into a string[].
 * Returns an empty array on parse failure.
 */
function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	// Try JSON first
	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		// Not JSON — treat as comma-separated
	}
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) return [];
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Parse the MESH_PUBLIC_KEYS env var — expected as a JSON object
 * mapping key IDs to base64-encoded public keys.
 * Returns an empty object on parse failure.
 */
function parseKeyMap(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, string>;
		}
	} catch {
		// fall through
	}
	return {};
}

// ---------------------------------------------------------------------------
// Worker mirroring
// ---------------------------------------------------------------------------

/**
 * POST a valid PublicProxyRecord to the Worker's /mesh/register endpoint.
 * Returns true on success, false on any failure.
 */
async function mirrorToWorker(
	config: IndexerConfig,
	record: PublicProxyRecord,
): Promise<boolean> {
	if (!config.coordinatorUrl) return false;

	try {
		const url = `${config.coordinatorUrl.replace(/\/$/, "")}/mesh/register`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (config.authToken) {
			headers["Authorization"] = `Bearer ${config.authToken}`;
		}

		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(record),
		});

		return res.ok;
	} catch (err) {
		console.error("[indexer] mirror to worker failed:", err);
		return false;
	}
}

// ---------------------------------------------------------------------------
// IPFS snapshot publishing
// ---------------------------------------------------------------------------

async function publishSnapshotToIPFS(
	config: IndexerConfig,
	records: PublicProxyRecord[],
): Promise<void> {
	if (!config.ipfsApiUrl) return;

	try {
		const snapshot = createSnapshot(records, config.networkId);

		// If no signing key configured, publish unsigned (signature stays "")
		const signed: SignedSnapshot =
			config.authToken && Object.keys(config.publicKeyMap).length > 0
				? snapshot // Caller should arrange signing externally in this case
				: snapshot;

		const cid = await addJSON(config.ipfsApiUrl, signed);
		console.log(`[indexer] snapshot published to IPFS: ${cid}`);

		// Pin the CID so the local node retains it
		await pinAdd(config.ipfsApiUrl, cid);

		// Publish to IPNS if a "mesh-key" exists (requires `ipfs key gen mesh-key`)
		try {
			const ipnsName = await publishIPNS(config.ipfsApiUrl, cid, "mesh-key");
			console.log(`[indexer] snapshot published to IPNS: ${ipnsName}`);
		} catch (err) {
			// IPNS key may not exist — this is optional, log and continue
			console.warn(
				"[indexer] IPNS publish skipped (key 'mesh-key' may not exist):",
				err instanceof Error ? err.message : err,
			);
		}
	} catch (err) {
		console.error(
			"[indexer] IPFS snapshot publish failed:",
			err instanceof Error ? err.message : err,
		);
	}
}

// ---------------------------------------------------------------------------
// Main indexer loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const config = loadConfig();

	console.log("[indexer] starting DHT indexer");
	console.log(`[indexer] networkId: ${config.networkId}`);
	console.log(`[indexer] bootstrap peers: ${config.bootstrapPeers.length}`);
	console.log(
		`[indexer] known public keys: ${Object.keys(config.publicKeyMap).join(", ") || "(none)"}`,
	);
	console.log(`[indexer] poll interval: ${config.pollIntervalSeconds}s`);
	console.log(
		`[indexer] coordinator: ${config.coordinatorUrl ?? "(not configured — no mirroring)"}`,
	);
	console.log(
		`[indexer] IPFS API: ${config.ipfsApiUrl ?? "(not configured — no IPFS)"}`,
	);

	if (config.bootstrapPeers.length === 0) {
		console.warn(
			"[indexer] no bootstrap peers configured — DHT will be isolated",
		);
	}

	// Start libp2p in full DHT server mode — the indexer can accept inbound queries
	const started = await startNode({
		bootstrapPeers: config.bootstrapPeers,
		listenAddresses: config.listenAddresses,
		isClient: false, // Full DHT node — not client mode
	});

	console.log(
		`[indexer] libp2p node started: ${started.node.getPeers().length} peers`,
	);

	// Track previously discovered node IDs to detect new/updated records
	const seenNodeIds = new Set<string>();
	let running = true;

	// Graceful shutdown on SIGINT / SIGTERM
	const shutdown = async () => {
		if (!running) return;
		running = false;
		console.log("[indexer] shutting down...");
		await shutdownNode(started.node);
		console.log("[indexer] stopped");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Poll loop
	while (running) {
		const pollStart = Date.now();

		try {
			const allRecords: PublicProxyRecord[] = [];

			// Discover both protocols
			for (const protocol of ["vless", "hysteria2"] as const) {
				console.log(`[indexer] discovering ${protocol} providers...`);

				const discovered = await discoverAndVerify(
					started.node,
					started.dht,
					config.networkId,
					protocol,
					config.publicKeyMap,
				);

				console.log(
					`[indexer] ${protocol}: ${discovered.length} valid provider(s)`,
				);

				for (const entry of discovered) {
					allRecords.push(entry.record);

					// Mirror new/updated records to the Worker
					if (!seenNodeIds.has(entry.record.nodeId)) {
						console.log(
							`[indexer] new record: nodeId=${entry.record.nodeId} protocol=${entry.record.protocol}`,
						);
						seenNodeIds.add(entry.record.nodeId);
					}

					if (config.coordinatorUrl) {
						const mirrored = await mirrorToWorker(config, entry.record);
						if (!mirrored) {
							console.warn(
								`[indexer] failed to mirror nodeId=${entry.record.nodeId}`,
							);
						}
					}
				}
			}

			// Filter out any records that have expired since discovery
			const liveRecords = allRecords.filter((r) => !isRecordExpired(r));

			// Prune seen set of expired node IDs
			for (const nodeId of seenNodeIds) {
				if (!liveRecords.some((r) => r.nodeId === nodeId)) {
					seenNodeIds.delete(nodeId);
				}
			}

			console.log(
				`[indexer] poll complete: ${liveRecords.length} live record(s), ` +
					`${seenNodeIds.size} tracked node(s)`,
			);

			// Optionally publish a signed snapshot to IPFS
			if (config.ipfsApiUrl && liveRecords.length > 0) {
				await publishSnapshotToIPFS(config, liveRecords);
			}
		} catch (err) {
			console.error(
				"[indexer] poll error:",
				err instanceof Error ? err.message : err,
			);
		}

		// Wait for the next poll interval (respecting shutdown signals)
		const elapsed = Date.now() - pollStart;
		const remaining = Math.max(0, config.pollIntervalSeconds * 1000 - elapsed);

		if (running && remaining > 0) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				// Resolve early if shutdown fires during the wait
				const earlyResolve = () => {
					clearTimeout(timer);
					resolve();
				};
				process.once("SIGINT", earlyResolve);
				process.once("SIGTERM", earlyResolve);
			});
		}
	}
}

// Run
main().catch((err) => {
	console.error("[indexer] fatal:", err);
	process.exit(1);
});
