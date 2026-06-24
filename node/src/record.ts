import crypto from "node:crypto";
import type { PublicProxyRecord } from "../../worker/src/index.js";
import type { DiscoveredRecord, MeshNodeConfig } from "./types.js";

/**
 * Create a deterministic node ID from GHA run context and proxy endpoint.
 * Matches the spec: sha256("{repository}:{runId}:{runAttempt}:{protocol}:{endpoint.host}")
 */
export function createNodeId(
	repository: string,
	runId: string,
	runAttempt: string,
	protocol: string,
	host: string,
): string {
	const input = `${repository}:${runId}:${runAttempt}:${protocol}:${host}`;
	return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Build a PublicProxyRecord from the mesh node config.
 * Record is unsigned (signature = "") — call signRecord() from signing.ts after.
 */
export function createPublicProxyRecord(
	config: MeshNodeConfig,
	heartbeatAt?: string,
): PublicProxyRecord {
	const now = new Date();
	const createdAt = now.toISOString();
	const hb = heartbeatAt ?? createdAt;
	const ttlSeconds = config.ttlMinutes * 60;
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

	const record: PublicProxyRecord = {
		schema: "animamesh.proxy.v1",
		networkId: config.networkId,
		nodeId: createNodeId(
			config.runContext?.repository ?? "",
			config.runContext?.runId ?? "",
			config.runContext?.runAttempt ?? "",
			config.protocol,
			config.proxyHost,
		),
		protocol: config.protocol,
		ingress: config.ingress,
		endpoint: {
			host: config.proxyHost,
			port: config.proxyPort,
		},
		lifecycle: {
			createdAt,
			expiresAt,
			heartbeatAt: hb,
			ttlSeconds,
		},
		publicKeyId: config.publicKeyId ?? "",
		signature: "",
	};

	// Conditionally add the run context block (canonicalization drops undefined fields)
	if (config.runContext) {
		const run: {
			repository: string;
			runId: string;
			runAttempt: string;
			workflow: string;
			actor?: string;
		} = {
			repository: config.runContext.repository,
			runId: config.runContext.runId,
			runAttempt: config.runContext.runAttempt,
			workflow: config.runContext.workflow,
		};
		if (config.runContext.actor !== undefined) {
			run.actor = config.runContext.actor;
		}
		record.run = run;
	}

	return record;
}

// ---------------------------------------------------------------------------
// Canonical JSON — must match worker/src/index.ts exactly
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Matches the Worker's canonicalize() implementation so records and snapshots
 * signed on either side produce identical signing payloads.
 */
export function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) sorted[key] = canonicalize(child);
		}
		return sorted;
	}
	return value;
}

/**
 * Deterministic JSON stringify with sorted keys.
 * Strips undefined values (they never appear in the output).
 */
export function canonicalJSONStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/**
 * Produce the canonical signing payload for a PublicProxyRecord.
 * Strips the `signature` field before serializing, matching the Worker's
 * recordSigningPayload().
 */
export function recordSigningPayload(record: PublicProxyRecord): string {
	const { signature: _signature, ...unsigned } = record;
	return canonicalJSONStringify(unsigned);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Check whether a record's expiresAt timestamp is in the past. */
export function isRecordExpired(record: PublicProxyRecord): boolean {
	return new Date(record.lifecycle.expiresAt) <= new Date();
}

/**
 * Basic structural validation of a PublicProxyRecord.
 * Checks schema, required fields, and types — does NOT verify the cryptographic
 * signature (use verifyRecordSignature from signing.ts for that).
 */
export function isRecordValid(record: PublicProxyRecord): boolean {
	if (!record || typeof record !== "object") return false;
	if (record.schema !== "animamesh.proxy.v1") return false;
	if (typeof record.networkId !== "string" || !record.networkId) return false;
	if (typeof record.nodeId !== "string" || !record.nodeId) return false;
	if (record.protocol !== "vless" && record.protocol !== "hysteria2")
		return false;
	if (!record.ingress) return false;
	if (!record.endpoint || typeof record.endpoint !== "object") return false;
	if (typeof record.endpoint.host !== "string" || !record.endpoint.host)
		return false;
	if (
		!Number.isInteger(record.endpoint.port) ||
		record.endpoint.port < 1 ||
		record.endpoint.port > 65535
	)
		return false;
	if (!record.lifecycle || typeof record.lifecycle !== "object") return false;
	if (
		typeof record.lifecycle.createdAt !== "string" ||
		!record.lifecycle.createdAt
	)
		return false;
	if (
		typeof record.lifecycle.expiresAt !== "string" ||
		!record.lifecycle.expiresAt
	)
		return false;
	if (
		typeof record.lifecycle.heartbeatAt !== "string" ||
		!record.lifecycle.heartbeatAt
	)
		return false;
	if (
		!Number.isInteger(record.lifecycle.ttlSeconds) ||
		record.lifecycle.ttlSeconds < 60 ||
		record.lifecycle.ttlSeconds > 7200
	)
		return false;
	if (typeof record.publicKeyId !== "string") return false;
	if (typeof record.signature !== "string") return false;
	return true;
}

/**
 * Deduplicate an array of DiscoveredRecords, keeping the one with the most
 * recent heartbeatAt timestamp per nodeId.
 */
export function deduplicateRecords(
	records: DiscoveredRecord[],
): DiscoveredRecord[] {
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
