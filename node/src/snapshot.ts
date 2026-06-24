// Animamesh — Signed snapshot creation and verification
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §13 (Optional IPFS/IPNS Mirror)
//
// Creates SignedSnapshot objects for IPFS mirroring, and signs/verifies them
// using the same canonical JSON + Ed25519 pattern as PublicProxyRecord signing.

import crypto from "node:crypto";
import { canonicalize, canonicalJSONStringify } from "./record.js";
import { keyFromSecret } from "./signing.js";
import type { PublicProxyRecord, SignedSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

/**
 * Create an unsigned SignedSnapshot from a list of verified records.
 *
 * The snapshot captures:
 * - schema: always "animamesh.snapshot.v1"
 * - networkId: the mesh network identifier
 * - generatedAt: ISO-8601 timestamp of creation
 * - expiresAt: earliest record expiry, or generatedAt + 15 min as fallback
 * - records: sorted by nodeId for deterministic ordering
 * - publicKeyId: empty string (filled by signSnapshot)
 * - signature: empty string (filled by signSnapshot)
 */
export function createSnapshot(
	records: PublicProxyRecord[],
	networkId: string,
): SignedSnapshot {
	const generatedAt = new Date().toISOString();

	// Earliest expiry across all records — the snapshot is only valid while
	// at least one record is still live.
	let expiresAt: string;
	if (records.length > 0) {
		const earliestExpiry = records.reduce((min, rec) => {
			const t = new Date(rec.lifecycle.expiresAt).getTime();
			return t < min ? t : min;
		}, Infinity);
		expiresAt = new Date(earliestExpiry).toISOString();
	} else {
		// No records — default 15 min TTL
		expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
	}

	// Sort records by nodeId for deterministic snapshot content
	const sortedRecords = [...records].sort((a, b) =>
		a.nodeId.localeCompare(b.nodeId),
	);

	return {
		schema: "animamesh.snapshot.v1",
		networkId,
		generatedAt,
		expiresAt,
		records: sortedRecords,
		publicKeyId: "",
		signature: "",
	};
}

// ---------------------------------------------------------------------------
// Snapshot signing
// ---------------------------------------------------------------------------

/**
 * Sign a SignedSnapshot using an Ed25519 private key.
 *
 * Follows the same canonical JSON + sign pattern as PublicProxyRecord:
 * 1. Strip the `signature` field.
 * 2. Canonicalize (sorted keys, no undefined values).
 * 3. Sign the UTF-8 canonical JSON with Ed25519.
 * 4. Return a new snapshot with `signature` and `publicKeyId` filled.
 *
 * @param snapshot         The unsigned (or previously signed) snapshot.
 * @param privateKeyBase64 Ed25519 private key — raw base64 (32 bytes) or PEM/DER.
 * @param publicKeyId      The key ID to embed in the snapshot.
 * @returns A new SignedSnapshot with `signature` and `publicKeyId` set.
 */
export function signSnapshot(
	snapshot: SignedSnapshot,
	privateKeyBase64: string,
	publicKeyId: string,
): SignedSnapshot {
	// Strip signature for signing payload — same pattern as recordSigningPayload
	const { signature: _sig, ...unsigned } = snapshot;
	unsigned.publicKeyId = publicKeyId;

	const payload = canonicalJSONStringify(unsigned);
	const keyBytes = keyFromSecret(privateKeyBase64);

	const privateKey =
		keyBytes.length === 32
			? (crypto.createPrivateKey as (o: unknown) => crypto.KeyObject)({
					key: keyBytes,
					type: "raw",
					format: "raw",
				})
			: crypto.createPrivateKey({
					key: keyBytes,
					format: "der",
					type: "pkcs8",
				});

	const sig = crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey);

	return {
		...snapshot,
		publicKeyId,
		signature: sig.toString("base64"),
	};
}

// ---------------------------------------------------------------------------
// Snapshot verification
// ---------------------------------------------------------------------------

/**
 * Verify the Ed25519 signature on a SignedSnapshot.
 *
 * Re-computes the canonical signing payload (snapshot minus signature, sorted
 * keys) and checks it against the stored signature using the provided public key.
 *
 * @param snapshot         A signed snapshot (must have `signature` populated).
 * @param publicKeyBase64  Ed25519 public key — raw base64 (32 bytes) or PEM/SPKI DER.
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifySnapshotSignature(
	snapshot: SignedSnapshot,
	publicKeyBase64: string,
): Promise<boolean> {
	try {
		const { signature: sigStr, ...unsigned } = snapshot;
		const payload = canonicalJSONStringify(unsigned);
		const keyBytes = keyFromSecret(publicKeyBase64);

		const publicKey =
			keyBytes.length === 32
				? (crypto.createPublicKey as (o: unknown) => crypto.KeyObject)({
						key: keyBytes,
						type: "raw",
						format: "raw",
					})
				: crypto.createPublicKey({
						key: keyBytes,
						format: "der",
						type: "spki",
					});

		const signature = Buffer.from(sigStr, "base64");

		return crypto.verify(
			null,
			Buffer.from(payload, "utf-8"),
			publicKey,
			signature,
		);
	} catch {
		return false;
	}
}
