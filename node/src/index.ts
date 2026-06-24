#!/usr/bin/env node
/**
 * Animamesh — libp2p DHT mesh node entry point.
 *
 * This is a run-on-import script designed to be executed directly with `tsx`:
 *
 *   tsx src/index.ts
 *
 * It reads environment variables, creates a signed PublicProxyRecord,
 * joins the DHT mesh, announces itself, serves the record over a libp2p
 * protocol handler, and runs a periodic heartbeat loop.
 *
 * Environment variables — see README for full documentation.
 *
 * Signals:
 *   SIGINT / SIGTERM — graceful shutdown (drain + stop libp2p).
 */

import crypto from "node:crypto";
import process from "node:process";
import {
	announceRecord,
	startRecordServer,
	stopRecordServer,
} from "./announce.js";
import { shutdownNode, startNode } from "./dht.js";
import { createPublicProxyRecord } from "./record.js";
import { generateKeyPair, keyFromSecret, signRecord } from "./signing.js";
import type { MeshIngress, MeshNodeConfig, MeshProtocol } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

function getEnv(name: string, fallback = ""): string {
	return process.env[name] ?? fallback;
}

function getEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** Parse BOOTSTRAP_PEERS — accepts JSON array or comma-separated list. */
function parseBootstrapPeers(): string[] {
	const raw = getEnv("BOOTSTRAP_PEERS");
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		// Not JSON — treat as comma-separated
	}

	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Build the MeshNodeConfig from environment variables. */
function configFromEnv(): MeshNodeConfig {
	const protocol = getEnv("PROXY_PROTOCOL", "vless") as MeshProtocol;
	let ingress = getEnv("PROXY_INGRESS", "cloudflared_quick") as MeshIngress;
	// Auto-detect n2n ingress when tunnel type is n2n
	if (getEnv("TUNNEL_TYPE") === "n2n") {
		ingress = "n2n";
	}
	const ttlMinutes = getEnvNumber("TTL_MINUTES", 45);

	const config: MeshNodeConfig = {
		networkId: getEnv("NETWORK_ID", "animamesh-main"),
		protocol,
		proxyHost: getEnv("PROXY_HOST", "127.0.0.1"),
		proxyPort: getEnvNumber("PROXY_PORT", 0),
		ingress,
		ttlMinutes,
		bootstrapPeers: parseBootstrapPeers(),
		signingPrivateKey: getEnv("MESH_SIGNING_PRIVATE_KEY") || undefined,
		publicKeyId: getEnv("MESH_PUBLIC_KEY_ID") || undefined,
		vlessUuid: getEnv("VLESS_UUID") || undefined,
		hysteria2Password: getEnv("HY2_PASSWORD") || undefined,
		coordinatorUrl: getEnv("COORDINATOR_URL") || undefined,
		authToken: getEnv("AUTH_TOKEN") || undefined,
		listenAddresses: undefined,
	};

	// If TUNNEL_HOST / TUNNEL_PORT are set, they override PROXY_HOST/PORT
	// for the endpoint that goes into the record (cloudflared tunnel address).
	const tunnelHost = getEnv("TUNNEL_HOST");
	const tunnelPort = getEnvNumber("TUNNEL_PORT", 0);
	if (tunnelHost) {
		config.proxyHost = tunnelHost;
		if (tunnelPort > 0) config.proxyPort = tunnelPort;
	}

	// GitHub Actions run context
	const repo = getEnv("GITHUB_REPOSITORY");
	const runId = getEnv("GITHUB_RUN_ID");
	const runAttempt = getEnv("GITHUB_RUN_ATTEMPT");
	const workflow = getEnv("GITHUB_WORKFLOW");

	if (repo && runId && runAttempt && workflow) {
		config.runContext = {
			repository: repo,
			runId,
			runAttempt,
			workflow,
			actor: getEnv("GITHUB_ACTOR") || undefined,
		};
	}

	return config;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

interface ResolvedKeys {
	privateKey: string;
	publicKey: string;
	keyId: string;
}

/**
 * Resolve the signing key pair.
 *
 * 1. If `MESH_SIGNING_PRIVATE_KEY` is set, derive the public key from it.
 * 2. Otherwise generate a fresh key pair (useful for development / indexer
 *    nodes that don't need to match a coordinator-registered key).
 *
 * This lets ephemeral GHA runners share a single org-secret key, while
 * allowing independent nodes to self-generate.
 */
async function resolveKeys(config: MeshNodeConfig): Promise<ResolvedKeys> {
	if (config.signingPrivateKey) {
		// Decode the raw private key bytes (handles PEM stipping via keyFromSecret)
		const rawPrivateKeyBytes = keyFromSecret(config.signingPrivateKey);

		// Build a KeyObject — raw 32-byte Ed25519 private keys use format:"der" type:"raw"
		// but @types/node may not include this overload, so we handle both cases via PKCS8
		let privateKey: crypto.KeyObject;
		if (rawPrivateKeyBytes.length === 32) {
			// Raw 32-byte Ed25519 seed — Node.js 18+ supports format:"raw" but
			// @types/node v20 doesn't include the overload yet.
			privateKey = crypto.createPrivateKey({
				key: rawPrivateKeyBytes,
				format: "raw",
				type: "raw",
			} as unknown as crypto.PrivateKeyInput);
		} else {
			// Assume PKCS8 DER
			privateKey = crypto.createPrivateKey({
				key: rawPrivateKeyBytes,
				format: "der",
				type: "pkcs8",
			});
		}

		// Export private key as PKCS8 DER base64 for the signing module
		const privateKeyB64 = privateKey
			.export({ type: "pkcs8", format: "der" })
			.toString("base64");

		// Derive the public key and export raw 32-byte Ed25519 public key
		const publicKey = crypto.createPublicKey(privateKey);
		// Export as SPKI DER, then extract the trailing 32 raw key bytes
		const spkiDer: Buffer = publicKey.export({ type: "spki", format: "der" });
		const rawPublicKey = spkiDer.subarray(-32);
		const publicKeyRaw = rawPublicKey.toString("base64");

		// keyId defaults to hex of first 8 bytes of the raw public key
		const keyId =
			config.publicKeyId || rawPublicKey.subarray(0, 8).toString("hex");

		return {
			privateKey: privateKeyB64,
			publicKey: publicKeyRaw,
			keyId,
		};
	}

	// No key provided — generate one
	console.log(
		"[node] No MESH_SIGNING_PRIVATE_KEY set — generating ephemeral key pair",
	);
	const generated = await generateKeyPair();
	return {
		privateKey: generated.privateKey,
		publicKey: generated.publicKey,
		keyId: generated.keyId,
	};
}

// ---------------------------------------------------------------------------
// Record creation and signing
// ---------------------------------------------------------------------------

/** Create the initial unsigned PublicProxyRecord from config and sign it. */
function createAndSignRecord(
	config: MeshNodeConfig,
	keys: ResolvedKeys,
	heartbeatAt?: string,
): ReturnType<typeof createPublicProxyRecord> {
	const record = createPublicProxyRecord(config, heartbeatAt);
	// Override nodeId to ensure it matches the config-derived value
	// createPublicProxyRecord already handles this, but we ensure consistency
	const signed = signRecord(record, keys.privateKey);
	return signed;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

let _currentRecord: ReturnType<typeof createPublicProxyRecord> | null = null;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Perform a single heartbeat cycle:
 * 1. Create a fresh (re-signed) record with updated timestamps.
 * 2. Re-announce on DHT (re-publish provider records).
 * 3. Restart the record server so dialers get the freshest heartbeat.
 */
async function doHeartbeat(
	node: Parameters<typeof announceRecord>[0],
	dht: Parameters<typeof announceRecord>[1],
	config: MeshNodeConfig,
	keys: ResolvedKeys,
): Promise<void> {
	const record = createAndSignRecord(config, keys, new Date().toISOString());
	_currentRecord = record;

	await announceRecord(node, dht, record).catch((err: unknown) => {
		console.error(
			"[node] Announce failed:",
			err instanceof Error ? err.message : err,
		);
	});

	// Restart the record server so the static response carries the new heartbeat
	stopRecordServer(node);
	startRecordServer(node, record);

	const ttlM = config.ttlMinutes;
	console.log(
		`[node] Heartbeat OK — expires in ${ttlM} min at ${record.lifecycle.expiresAt}`,
	);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(
	node: Parameters<typeof shutdownNode>[0],
): Promise<void> {
	console.log("\n[node] Shutting down...");

	if (_heartbeatTimer !== null) {
		clearInterval(_heartbeatTimer);
		_heartbeatTimer = null;
	}

	stopRecordServer(node);
	await shutdownNode(node);
	console.log("[node] Goodbye");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("[node] Animamesh DHT mesh node starting");

	// 1. Configuration
	const config = configFromEnv();
	console.log(`[node] Network:  ${config.networkId}`);
	console.log(`[node] Protocol: ${config.protocol}`);
	console.log(`[node] Endpoint: ${config.proxyHost}:${config.proxyPort}`);
	console.log(`[node] TTL:      ${config.ttlMinutes} min`);

	if (config.bootstrapPeers.length > 0) {
		console.log(`[node] Bootstrap: ${config.bootstrapPeers.length} peer(s)`);
	} else {
		console.warn(
			"[node] WARNING: No bootstrap peers — DHT discovery will be limited",
		);
	}

	// 2. Keys
	const keys = await resolveKeys(config);
	console.log(`[node] Key ID: ${keys.keyId}`);

	// 3. Create and sign the initial record
	const record = createAndSignRecord(config, keys);
	_currentRecord = record;
	console.log(`[node] Node ID: ${record.nodeId}`);

	// 4. Start libp2p node
	console.log("[node] Starting libp2p...");
	const { node, dht, stop } = await startNode({
		listenAddresses: config.listenAddresses,
		bootstrapPeers: config.bootstrapPeers,
		isClient: true,
	});
	console.log(`[node] libp2p peer ID: ${node.peerId.toString()}`);

	// 5. Announce on DHT
	console.log("[node] Announcing on DHT...");
	await announceRecord(node, dht, record).catch((err: unknown) => {
		console.error(
			"[node] Initial announce failed:",
			err instanceof Error ? err.message : err,
		);
	});

	// 6. Start record server
	startRecordServer(node, record);
	console.log(
		"[node] Record server listening on /animamesh/proxy-record/1.0.0",
	);

	// 7. Heartbeat loop
	_heartbeatTimer = setInterval(() => {
		doHeartbeat(node, dht, config, keys).catch((err: unknown) => {
			console.error(
				"[node] Heartbeat error:",
				err instanceof Error ? err.message : err,
			);
		});
	}, HEARTBEAT_INTERVAL_MS);

	// 8. Signal handling
	const shutdownHandler = () => {
		shutdown(node)
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	};

	process.on("SIGINT", shutdownHandler);
	process.on("SIGTERM", shutdownHandler);

	console.log(
		"[node] Ready — listening for DHT queries and proxy record requests",
	);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
	console.error(
		"[node] Fatal error:",
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
});
