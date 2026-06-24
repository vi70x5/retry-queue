import crypto from "node:crypto";
import type { PublicProxyRecord } from "../../worker/src/index.js";
import { recordSigningPayload } from "./record.js";

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Decode a base64 or PEM-encoded Ed25519 key into raw bytes.
 *
 * Handles:
 * - Plain base64-encoded raw key (32 bytes)
 * - PEM-encoded key (strips headers)
 * - DER-encoded base64 (PKCS8 / SPKI wrapper)
 *
 * Matching the Worker's base64ToBytes() logic:
 * 1. Strip PEM header/footer lines
 * 2. Strip all whitespace
 * 3. base64-decode the remaining payload
 */
export function keyFromSecret(secret: string): Buffer {
	const normalized = secret
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	return Buffer.from(normalized, "base64");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a PublicProxyRecord with an Ed25519 private key.
 *
 * Produces the canonical signing payload (record minus signature, sorted keys),
 * signs it, and returns a new record with the `signature` field filled.
 *
 * @param record   The unsigned (or previously signed) record.
 * @param privateKeyBase64  Ed25519 private key — raw base64 (32 bytes) or PEM/DER.
 * @returns A new PublicProxyRecord with the `signature` field set.
 */
export function signRecord(
	record: PublicProxyRecord,
	privateKeyBase64: string,
): PublicProxyRecord {
	const payload = recordSigningPayload(record);
	const keyBytes = keyFromSecret(privateKeyBase64);
	const privateKey = createPrivateKeyObject(keyBytes);

	const signature = crypto.sign(
		null,
		Buffer.from(payload, "utf-8"),
		privateKey,
	);

	return { ...record, signature: signature.toString("base64") };
}

/**
 * Verify the Ed25519 signature on a PublicProxyRecord.
 *
 * Re-computes the canonical signing payload and checks it against the stored
 * signature using the provided public key.
 *
 * @param record  A signed record (must have `signature` populated).
 * @param publicKeyBase64  Ed25519 public key — raw base64 (32 bytes) or PEM/SPKI DER.
 */
export async function verifyRecordSignature(
	record: PublicProxyRecord,
	publicKeyBase64: string,
): Promise<boolean> {
	const payload = recordSigningPayload(record);
	const keyBytes = keyFromSecret(publicKeyBase64);
	const publicKey = createPublicKeyObject(keyBytes);

	const signature = Buffer.from(record.signature, "base64");

	return crypto.verify(
		null,
		Buffer.from(payload, "utf-8"),
		publicKey,
		signature,
	);
}

/**
 * Generate a new Ed25519 keypair.
 *
 * @returns An object containing:
 *   - publicKey:  raw base64-encoded 32-byte public key
 *   - privateKey: raw base64-encoded 32-byte private key
 *   - keyId:      hex-encoded first 8 bytes of the public key
 */
export async function generateKeyPair(): Promise<{
	publicKey: string;
	privateKey: string;
	keyId: string;
}> {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "raw", format: "raw" },
		privateKeyEncoding: { type: "raw", format: "raw" },
	});

	const publicKeyB64 = Buffer.from(publicKey).toString("base64");
	const privateKeyB64 = Buffer.from(privateKey).toString("base64");
	const keyId = Buffer.from(publicKey).subarray(0, 8).toString("hex");

	return {
		publicKey: publicKeyB64,
		privateKey: privateKeyB64,
		keyId,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers — KeyObject construction
// ---------------------------------------------------------------------------

/**
 * Create a Node.js KeyObject from raw Ed25519 private key bytes.
 * Handles both raw 32-byte keys and PKCS8 DER-encoded keys.
 */
function createPrivateKeyObject(keyBytes: Buffer): crypto.KeyObject {
	if (keyBytes.length === 32) {
		return crypto.createPrivateKey({
			key: keyBytes,
			type: "raw",
			format: "raw",
		});
	}
	// Assume PKCS8 DER format
	return crypto.createPrivateKey({
		key: keyBytes,
		format: "der",
		type: "pkcs8",
	});
}

/**
 * Create a Node.js KeyObject from raw Ed25519 public key bytes.
 * Handles both raw 32-byte keys and SPKI DER-encoded keys.
 */
function createPublicKeyObject(keyBytes: Buffer): crypto.KeyObject {
	if (keyBytes.length === 32) {
		return crypto.createPublicKey({
			key: keyBytes,
			type: "raw",
			format: "raw",
		});
	}
	// Assume SPKI DER format
	return crypto.createPublicKey({
		key: keyBytes,
		format: "der",
		type: "spki",
	});
}
