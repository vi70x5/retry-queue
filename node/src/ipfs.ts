// Animamesh — IPFS HTTP API wrapper for publishing snapshots
// Spec: SPEC-V3-ANIMAMESH-BACKEND.md §13 (Optional IPFS/IPNS Mirror)
//
// Thin wrapper around the IPFS HTTP API (default: http://127.0.0.1:5001).
// Uses native fetch — no external IPFS SDK dependencies needed (Node 18+).

/**
 * Add a JSON object to IPFS via the HTTP API.
 *
 * POST /api/v0/add with the JSON serialized to a file named "snapshot.json".
 * Returns the CID of the pinned object.
 *
 * @param ipfsApiUrl  Base URL of the IPFS HTTP API (e.g. "http://127.0.0.1:5001").
 * @param data        JSON-serializable data to add.
 * @returns The CID string returned by the IPFS node.
 */
export async function addJSON(
	ipfsApiUrl: string,
	data: unknown,
): Promise<string> {
	const body = new FormData();
	const json = JSON.stringify(data);
	body.append(
		"file",
		new File([json], "snapshot.json", { type: "application/json" }),
	);

	const res = await fetch(`${ipfsApiUrl}/api/v0/add`, {
		method: "POST",
		body,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`IPFS add failed (${res.status}): ${text}`);
	}

	const result = (await res.json()) as { Hash: string };
	return result.Hash;
}

/**
 * Publish a CID to IPNS under a given key.
 *
 * POST /api/v0/name/publish?arg={cid}&key={key}
 * Returns the IPNS name that the CID was published under.
 *
 * @param ipfsApiUrl  Base URL of the IPFS HTTP API.
 * @param cid         The CID to publish.
 * @param key         The IPNS key name (created via `ipfs key gen`).
 * @returns The IPNS name string (e.g. "/ipns/Qm...").
 */
export async function publishIPNS(
	ipfsApiUrl: string,
	cid: string,
	key: string,
): Promise<string> {
	const url = `${ipfsApiUrl}/api/v0/name/publish?arg=${encodeURIComponent(cid)}&key=${encodeURIComponent(key)}`;

	const res = await fetch(url, { method: "POST" });

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`IPNS publish failed (${res.status}): ${text}`);
	}

	const result = (await res.json()) as { Name: string };
	return result.Name;
}

/**
 * Pin a CID to the local IPFS node.
 *
 * POST /api/v0/pin/add?arg={cid}
 * Ensures the object referenced by the CID is not garbage-collected.
 *
 * @param ipfsApiUrl  Base URL of the IPFS HTTP API.
 * @param cid         The CID to pin.
 */
export async function pinAdd(ipfsApiUrl: string, cid: string): Promise<void> {
	const url = `${ipfsApiUrl}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`;

	const res = await fetch(url, { method: "POST" });

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`IPFS pin add failed (${res.status}): ${text}`);
	}
}
