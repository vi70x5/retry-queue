/**
 * BPB Action Panel - Cloudflare Worker Coordinator
 *
 * Coordinates between GitHub Actions runners and end users.
 * Receives proxy configs from runners, serves Hiddify subscriptions.
 *
 * Auth: AUTH_TOKEN secret must be set. Runners pass it as Bearer token.
 * Storage: KV (persistent) or in-memory (fallback, resets on redeploy).
 */

export interface Env {
	BPB_KV?: KVNamespace;
	AUTH_TOKEN?: string;
	NETWORK_ID?: string;
	VLESS_UUID?: string;
	HY2_PASSWORD?: string;
	MESH_PUBLIC_KEYS?: string;
	MESH_SIGNING_PUBLIC_KEY?: string;
	MESH_PUBLIC_KEY_ID?: string;
	BOOTSTRAP_PEERS?: string;
	// n2n coordinator config
	N2N_COMMUNITY?: string;
	N2N_KEY?: string;
	N2N_SUPERNODE?: string;
}

// ----- KV wrappers with in-memory fallback -----

export const memoryStore = new Map<
	string,
	{ value: string; expires: number }
>();

export function hasKV(env: Env): boolean {
	return !!env.BPB_KV;
}

export async function kvPut(
	env: Env,
	key: string,
	value: string,
	ttlSeconds: number,
) {
	const kv = env.BPB_KV;
	if (kv) {
		return kv.put(key, value, { expirationTtl: ttlSeconds });
	}
	memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

export async function kvGet(env: Env, key: string): Promise<string | null> {
	const kv = env.BPB_KV;
	if (kv) {
		return kv.get(key);
	}
	const entry = memoryStore.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expires) {
		memoryStore.delete(key);
		return null;
	}
	return entry.value;
}

export async function kvDelete(env: Env, key: string) {
	const kv = env.BPB_KV;
	if (kv) {
		return kv.delete(key);
	}
	memoryStore.delete(key);
}

export async function kvList(env: Env, prefix: string): Promise<string[]> {
	const kv = env.BPB_KV;
	if (kv) {
		const list = await kv.list({ prefix });
		return list.keys.map((k) => k.name);
	}
	const now = Date.now();
	// Clean expired + collect live keys
	const keys: string[] = [];
	for (const [k, v] of memoryStore) {
		if (now > v.expires) {
			memoryStore.delete(k);
		} else if (k.startsWith(prefix)) {
			keys.push(k);
		}
	}
	return keys;
}

// ----- Auth -----

export function checkAuth(request: Request, env: Env): boolean {
	// If no AUTH_TOKEN is configured, allow all (dev mode)
	if (!env.AUTH_TOKEN) return true;

	const auth = request.headers.get("Authorization");
	if (!auth) return false;

	// Support "Bearer <token>" and "<token>" formats
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
	return token === env.AUTH_TOKEN;
}

// ----- Types -----

export interface ProxyConfig {
	protocol: "vless" | "hysteria2";
	id: string;
	host: string;
	port: number;
	password?: string;
	uuid?: string;
	tls?: boolean;
	sni?: string;
	type?: "tcp" | "ws";
	path?: string;
	security?: "none" | "tls";
	createdAt: string;
	expiresAt: string;
	networkId?: string;
	nodeId?: string;
	publicRecord?: PublicProxyRecord;
}

export type MeshProtocol = "vless" | "hysteria2";
export type MeshIngress =
	| "cloudflared_quick"
	| "cloudflared_named"
	| "ngrok"
	| "bore"
	| "direct"
	| "n2n";

export interface PublicProxyRecord {
	schema: "animamesh.proxy.v1";
	networkId: string;
	nodeId: string;
	run?: {
		repository: string;
		runId: string;
		runAttempt: string;
		workflow: string;
		actor?: string;
	};
	protocol: MeshProtocol;
	ingress: MeshIngress;
	endpoint: {
		host: string;
		port: number;
		sni?: string;
		transport?: "tcp" | "ws";
		path?: string;
		security?: "tls" | "none";
	};
	capabilities?: {
		ipv4: boolean;
		ipv6: boolean;
		udp: boolean;
		alpn?: string[];
	};
	lifecycle: {
		createdAt: string;
		expiresAt: string;
		heartbeatAt: string;
		ttlSeconds: number;
	};
	publicKeyId: string;
	signature: string;
}

export interface SignedSnapshot {
	schema: "animamesh.snapshot.v1";
	networkId: string;
	generatedAt: string;
	expiresAt: string;
	records: PublicProxyRecord[];
	publicKeyId: string;
	signature: string;
}

// ----- Subscription generators -----

export function generateVlessURL(config: ProxyConfig): string {
	const params = new URLSearchParams({
		security: config.security || "none",
		encryption: "none",
		headerType: "none",
		type: config.type || "tcp",
	});
	if (config.type === "ws") {
		params.set("path", config.path || "/ws");
	}
	if (config.sni) params.set("sni", config.sni);
	return `vless://${config.uuid}@${config.host}:${config.port}?${params.toString()}#BPB-Action-${config.id}`;
}

export function generateHysteria2URL(config: ProxyConfig): string {
	const params = new URLSearchParams({ insecure: "1" });
	if (config.sni) params.set("sni", config.sni);
	return `hysteria2://${config.password}@${config.host}:${config.port}?${params.toString()}#BPB-Action-${config.id}`;
}

function configWithEnvSecrets(config: ProxyConfig, env?: Env): ProxyConfig {
	if (config.protocol === "vless" && !config.uuid && env?.VLESS_UUID) {
		return { ...config, uuid: env.VLESS_UUID };
	}
	if (
		config.protocol === "hysteria2" &&
		!config.password &&
		env?.HY2_PASSWORD
	) {
		return { ...config, password: env.HY2_PASSWORD };
	}
	return config;
}

export function generateSubscription(
	configs: ProxyConfig[],
	env?: Env,
): string {
	return configs
		.map((c) => {
			const config = configWithEnvSecrets(c, env);
			if (config.protocol === "vless" && config.uuid) {
				return generateVlessURL(config);
			}
			if (config.protocol === "hysteria2" && config.password) {
				return generateHysteria2URL(config);
			}
			return "";
		})
		.filter((u) => u.length > 0)
		.join("\n");
}

// ----- Duration helper -----

export function ttlToSeconds(ttlMinutes: number): number {
	// KV TTL is 60s minimum, max 30 days. Proxy TTL is 15-60 min.
	return Math.max(60, ttlMinutes * 60);
}

function jsonHeaders(status = 200) {
	return {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), jsonHeaders(status));
}

function ttlFromExpiresAt(expiresAt: string): number {
	const remaining = Math.floor(
		(new Date(expiresAt).getTime() - Date.now()) / 1000,
	);
	return Math.max(60, Math.min((remaining > 0 ? remaining : 3600) + 300, 7200));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) sorted[key] = canonicalize(child);
		}
		return sorted;
	}
	return value;
}

export function canonicalJSONStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function recordSigningPayload(record: PublicProxyRecord): string {
	const { signature: _signature, ...unsigned } = record;
	return canonicalJSONStringify(unsigned);
}

function base64ToBytes(value: string): Uint8Array {
	const normalized = value
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function configuredPublicKeys(env: Env): Record<string, string> {
	const keys: Record<string, string> = {};
	if (env.MESH_PUBLIC_KEYS) {
		try {
			Object.assign(keys, JSON.parse(env.MESH_PUBLIC_KEYS));
		} catch {
			return keys;
		}
	}
	if (env.MESH_SIGNING_PUBLIC_KEY) {
		keys[env.MESH_PUBLIC_KEY_ID || "default"] = env.MESH_SIGNING_PUBLIC_KEY;
	}
	return keys;
}

async function verifyEd25519(
	publicKeyMaterial: string,
	signature: string,
	payload: string,
): Promise<boolean> {
	const publicKeyBytes = base64ToBytes(publicKeyMaterial);
	const importFormat = publicKeyBytes.length === 32 ? "raw" : "spki";
	const key = await crypto.subtle.importKey(
		importFormat,
		publicKeyBytes,
		{ name: "Ed25519" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		{ name: "Ed25519" },
		key,
		base64ToBytes(signature),
		new TextEncoder().encode(payload),
	);
}

function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
	const nums = parts.map(Number);
	if (nums.some((n) => n < 0 || n > 255)) return false;
	const [a, b] = nums;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

/**
 * Validate an endpoint host. Rejects private IPs, localhost, and malformed
 * hostnames. n2n ingress is allowed to use virtual private IPs (e.g. 10.x.x.x)
 * because the n2n overlay makes them reachable.
 */
function isValidEndpointHost(host: string, ingress?: MeshIngress): boolean {
	if (!host || host.length > 253) return false;
	if (host.includes("/") || host.includes(":") || /\s/.test(host)) return false;
	const lower = host.toLowerCase();
	if (lower === "localhost" || lower.endsWith(".localhost")) return false;
	// n2n ingress uses virtual IPs in the n2n overlay — these are valid
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const nums = host.split(".").map(Number);
		if (nums.some((n) => n < 0 || n > 255)) return false;
		if (ingress === "n2n") return true; // virtual IPs are expected
		return !isPrivateIpv4(host);
	}
	if (isPrivateIpv4(host)) return false;
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
		host,
	);
}

export async function verifyPublicRecord(
	record: PublicProxyRecord,
	env: Env,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!record || typeof record !== "object")
		return { ok: false, error: "Missing record" };
	if (record.schema !== "animamesh.proxy.v1")
		return { ok: false, error: "Unsupported schema" };
	if (env.NETWORK_ID && record.networkId !== env.NETWORK_ID) {
		return { ok: false, error: "Wrong networkId" };
	}
	if (!record.nodeId || !/^[A-Za-z0-9._:-]+$/.test(record.nodeId)) {
		return { ok: false, error: "Invalid nodeId" };
	}
	if (record.protocol !== "vless" && record.protocol !== "hysteria2") {
		return { ok: false, error: "Unsupported protocol" };
	}
	if (
		!record.endpoint ||
		!isValidEndpointHost(record.endpoint.host, record.ingress)
	) {
		return { ok: false, error: "Invalid endpoint host" };
	}
	if (
		!Number.isInteger(record.endpoint.port) ||
		record.endpoint.port < 1 ||
		record.endpoint.port > 65535
	) {
		return { ok: false, error: "Invalid endpoint port" };
	}
	const expiresAt = new Date(record.lifecycle?.expiresAt || "").getTime();
	const heartbeatAt = new Date(record.lifecycle?.heartbeatAt || "").getTime();
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
		return { ok: false, error: "Record expired" };
	}
	if (expiresAt - Date.now() > 2 * 60 * 60 * 1000) {
		return { ok: false, error: "Record expires too far in the future" };
	}
	if (!Number.isFinite(heartbeatAt))
		return { ok: false, error: "Invalid heartbeatAt" };
	if (
		!Number.isInteger(record.lifecycle.ttlSeconds) ||
		record.lifecycle.ttlSeconds < 60 ||
		record.lifecycle.ttlSeconds > 7200
	) {
		return { ok: false, error: "Invalid ttlSeconds" };
	}
	if (!record.publicKeyId || !record.signature) {
		return { ok: false, error: "Missing signature" };
	}
	const publicKeys = configuredPublicKeys(env);
	const publicKey = publicKeys[record.publicKeyId];
	if (!publicKey) return { ok: false, error: "Unknown publicKeyId" };
	try {
		const verified = await verifyEd25519(
			publicKey,
			record.signature,
			recordSigningPayload(record),
		);
		return verified ? { ok: true } : { ok: false, error: "Bad signature" };
	} catch {
		return { ok: false, error: "Bad signature" };
	}
}

export function sanitizePublicRecord(
	record: PublicProxyRecord,
): PublicProxyRecord {
	return JSON.parse(JSON.stringify(record));
}

export function deriveProxyConfigFromRecord(
	record: PublicProxyRecord,
): ProxyConfig {
	return {
		id: record.nodeId,
		protocol: record.protocol,
		host: record.endpoint.host,
		port: record.endpoint.port,
		sni: record.endpoint.sni,
		type: record.endpoint.transport,
		path: record.endpoint.path,
		security: record.endpoint.security,
		createdAt: record.lifecycle.createdAt,
		expiresAt: record.lifecycle.expiresAt,
		networkId: record.networkId,
		nodeId: record.nodeId,
		publicRecord: sanitizePublicRecord(record),
	};
}

async function listProxyConfigs(env: Env): Promise<ProxyConfig[]> {
	const keys = await kvList(env, "proxy:");
	const configs: ProxyConfig[] = [];
	for (const key of keys) {
		const data = await kvGet(env, key);
		if (data) configs.push(JSON.parse(data));
	}
	return configs;
}

async function listMeshRecords(env: Env): Promise<PublicProxyRecord[]> {
	const keys = await kvList(env, "mesh:");
	const records: PublicProxyRecord[] = [];
	for (const key of keys) {
		const data = await kvGet(env, key);
		if (data) records.push(JSON.parse(data));
	}
	return records;
}

function sanitizedProxy(config: ProxyConfig) {
	return {
		id: config.id,
		protocol: config.protocol,
		host: config.host,
		port: config.port,
		sni: config.sni,
		type: config.type,
		path: config.path,
		security: config.security,
		networkId: config.networkId,
		nodeId: config.nodeId,
		createdAt: config.createdAt,
		expiresAt: config.expiresAt,
	};
}

function meshStatus(records: PublicProxyRecord[]) {
	const protocols = { vless: 0, hysteria2: 0 };
	for (const record of records) protocols[record.protocol]++;
	return {
		status: "ok",
		activeNodes: records.length,
		protocols,
		nodes: records.map((record) => ({
			nodeId: record.nodeId,
			networkId: record.networkId,
			protocol: record.protocol,
			ingress: record.ingress,
			host: record.endpoint.host,
			port: record.endpoint.port,
			expiresAt: record.lifecycle.expiresAt,
			heartbeatAt: record.lifecycle.heartbeatAt,
			registration: "worker",
		})),
	};
}

// ----- Main handler -----

export const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Health check — no auth required
			if (path === "/health") {
				return new Response(
					JSON.stringify({
						status: "ok",
						service: "BPB Action Coordinator",
						version: "1.2.0",
						kv: hasKV(env) ? "connected" : "in-memory",
					}),
					{ headers: { "Content-Type": "application/json", ...corsHeaders } },
				);
			}

			// Register proxy (requires auth)
			if (path === "/register" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return new Response(JSON.stringify({ error: "Unauthorized" }), {
						status: 401,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}

				const data = (await request.json()) as ProxyConfig;
				if (!data.id || !data.host || !data.port) {
					return new Response(
						JSON.stringify({
							error: "Missing required fields: id, host, port",
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json", ...corsHeaders },
						},
					);
				}

				// Calculate TTL: expiresAt minus now, default 1 hour
				let ttlSeconds = 3600;
				if (data.expiresAt) {
					const expires = new Date(data.expiresAt).getTime();
					const remaining = Math.floor((expires - Date.now()) / 1000);
					if (remaining > 0) ttlSeconds = remaining;
					// Add 5 min buffer so record outlives the runner slightly
					ttlSeconds = Math.min(ttlSeconds + 300, 7200);
				}

				await kvPut(env, `proxy:${data.id}`, JSON.stringify(data), ttlSeconds);

				return new Response(
					JSON.stringify({
						success: true,
						message: "Proxy registered",
						subscriptionUrl: `${url.origin}/sub/all`,
						ttlSeconds,
					}),
					{ headers: { "Content-Type": "application/json", ...corsHeaders } },
				);
			}

			// Heartbeat — runner pings to keep its KV record alive (re-registers with fresh TTL)
			if (path === "/heartbeat" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return new Response(JSON.stringify({ error: "Unauthorized" }), {
						status: 401,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}

				const data = (await request.json()) as {
					id: string;
					expiresAt?: string;
				};
				if (!data.id) {
					return new Response(JSON.stringify({ error: "Missing id" }), {
						status: 400,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}

				const existing = await kvGet(env, `proxy:${data.id}`);
				if (!existing) {
					return new Response(JSON.stringify({ error: "Proxy not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}

				// Refresh TTL
				const config: ProxyConfig = JSON.parse(existing);
				let ttlSeconds = 3600;
				if (data.expiresAt) {
					const remaining = Math.floor(
						(new Date(data.expiresAt).getTime() - Date.now()) / 1000,
					);
					if (remaining > 0) ttlSeconds = remaining + 300;
				}
				await kvPut(
					env,
					`proxy:${data.id}`,
					JSON.stringify(config),
					ttlSeconds,
				);

				return new Response(JSON.stringify({ success: true, ttlSeconds }), {
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			}

			if (path === "/mesh/register" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return jsonResponse({ error: "Unauthorized" }, 401);
				}

				const data = (await request.json()) as { record?: PublicProxyRecord };
				if (!data.record) return jsonResponse({ error: "Missing record" }, 400);

				const validation = await verifyPublicRecord(data.record, env);
				if (!validation.ok)
					return jsonResponse({ error: validation.error }, 400);

				const meshKey = `mesh:${data.record.networkId}:${data.record.nodeId}`;
				const existing = await kvGet(env, meshKey);
				if (existing) {
					const previous = JSON.parse(existing) as PublicProxyRecord;
					if (
						new Date(previous.lifecycle.heartbeatAt).getTime() >
						new Date(data.record.lifecycle.heartbeatAt).getTime()
					) {
						return jsonResponse({ error: "Stale heartbeat" }, 409);
					}
				}

				const ttlSeconds = ttlFromExpiresAt(data.record.lifecycle.expiresAt);
				await kvPut(
					env,
					meshKey,
					JSON.stringify(sanitizePublicRecord(data.record)),
					ttlSeconds,
				);
				await kvPut(
					env,
					`proxy:${data.record.nodeId}`,
					JSON.stringify(deriveProxyConfigFromRecord(data.record)),
					ttlSeconds,
				);

				return jsonResponse({
					success: true,
					message: "Mesh record registered",
					subscriptionUrl: `${url.origin}/sub/all`,
					ttlSeconds,
				});
			}

			if (path === "/mesh/heartbeat" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return jsonResponse({ error: "Unauthorized" }, 401);
				}

				const data = (await request.json()) as {
					record?: PublicProxyRecord;
					networkId?: string;
					nodeId?: string;
					expiresAt?: string;
				};

				if (data.record) {
					const validation = await verifyPublicRecord(data.record, env);
					if (!validation.ok)
						return jsonResponse({ error: validation.error }, 400);
					const meshKey = `mesh:${data.record.networkId}:${data.record.nodeId}`;
					const ttlSeconds = ttlFromExpiresAt(data.record.lifecycle.expiresAt);
					await kvPut(
						env,
						meshKey,
						JSON.stringify(sanitizePublicRecord(data.record)),
						ttlSeconds,
					);
					await kvPut(
						env,
						`proxy:${data.record.nodeId}`,
						JSON.stringify(deriveProxyConfigFromRecord(data.record)),
						ttlSeconds,
					);
					return jsonResponse({ success: true, ttlSeconds });
				}

				const networkId = data.networkId || env.NETWORK_ID;
				if (!networkId || !data.nodeId) {
					return jsonResponse({ error: "Missing networkId or nodeId" }, 400);
				}

				const meshKey = `mesh:${networkId}:${data.nodeId}`;
				const existing = await kvGet(env, meshKey);
				if (!existing)
					return jsonResponse({ error: "Mesh record not found" }, 404);

				const record = JSON.parse(existing) as PublicProxyRecord;
				const ttlSeconds = ttlFromExpiresAt(
					data.expiresAt || record.lifecycle.expiresAt,
				);
				await kvPut(env, meshKey, existing, ttlSeconds);
				const proxy = await kvGet(env, `proxy:${data.nodeId}`);
				if (proxy) await kvPut(env, `proxy:${data.nodeId}`, proxy, ttlSeconds);
				return jsonResponse({ success: true, ttlSeconds });
			}

			if (path === "/mesh/deregister" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return jsonResponse({ error: "Unauthorized" }, 401);
				}
				const data = (await request.json()) as {
					networkId?: string;
					nodeId?: string;
				};
				const networkId = data.networkId || env.NETWORK_ID;
				if (!networkId || !data.nodeId) {
					return jsonResponse({ error: "Missing networkId or nodeId" }, 400);
				}
				await kvDelete(env, `mesh:${networkId}:${data.nodeId}`);
				await kvDelete(env, `proxy:${data.nodeId}`);
				return jsonResponse({ success: true, message: "Mesh record deleted" });
			}

			if (path === "/mesh/status" && request.method === "GET") {
				const records = (await listMeshRecords(env)).filter(
					(record) => !env.NETWORK_ID || record.networkId === env.NETWORK_ID,
				);
				return jsonResponse(meshStatus(records));
			}

			if (path === "/bootstrap/peers" && request.method === "GET") {
				let peers: string[] = [];
				if (env.BOOTSTRAP_PEERS) {
					try {
						const parsed = JSON.parse(env.BOOTSTRAP_PEERS);
						if (Array.isArray(parsed))
							peers = parsed.filter((p) => typeof p === "string");
					} catch {
						peers = env.BOOTSTRAP_PEERS.split(/[\n,]/)
							.map((peer) => peer.trim())
							.filter(Boolean);
					}
				}
				return jsonResponse({ peers });
			}

			// n2n coordinator — public join info (no secret key)
			if (path === "/mesh/n2n-config" && request.method === "GET") {
				if (!env.N2N_COMMUNITY) {
					return jsonResponse({ error: "n2n not configured" }, 404);
				}
				return jsonResponse({
					community: env.N2N_COMMUNITY,
					supernode: env.N2N_SUPERNODE || "supernode.ntop.org:7777",
					// Key is NOT returned publicly — use /mesh/n2n-join with auth
				});
			}

			// n2n coordinator — full join config including key (requires auth)
			if (path === "/mesh/n2n-join" && request.method === "POST") {
				if (!checkAuth(request, env)) {
					return jsonResponse({ error: "Unauthorized" }, 401);
				}
				if (!env.N2N_COMMUNITY || !env.N2N_KEY) {
					return jsonResponse({ error: "n2n not configured" }, 404);
				}
				return jsonResponse({
					community: env.N2N_COMMUNITY,
					key: env.N2N_KEY,
					supernode: env.N2N_SUPERNODE || "supernode.ntop.org:7777",
					example: {
						linux: `sudo edge -c ${env.N2N_COMMUNITY} -k <KEY> -a 10.10.10.2 -l ${env.N2N_SUPERNODE || "supernode.ntop.org:7777"}`,
					},
				});
			}

			if (path === "/mesh/snapshot" && request.method === "GET") {
				const records = (await listMeshRecords(env)).filter(
					(record) => !env.NETWORK_ID || record.networkId === env.NETWORK_ID,
				);
				const generatedAt = new Date().toISOString();
				const expiresAt =
					records.map((record) => record.lifecycle.expiresAt).sort()[0] ||
					new Date(Date.now() + 15 * 60 * 1000).toISOString();
				const snapshot: SignedSnapshot = {
					schema: "animamesh.snapshot.v1",
					networkId: env.NETWORK_ID || records[0]?.networkId || "default",
					generatedAt,
					expiresAt,
					records: records.map(sanitizePublicRecord),
					publicKeyId: env.MESH_PUBLIC_KEY_ID || "unsigned",
					signature: "",
				};
				return jsonResponse(snapshot);
			}

			// Subscription — all proxies (no auth, public)
			if (path === "/sub/all" && request.method === "GET") {
				const configs = await listProxyConfigs(env);
				let subscription = generateSubscription(configs, env);

				// If n2n proxies are active, prepend setup instructions
				const hasN2n = configs.some(
					(c) =>
						c.publicRecord?.ingress === "n2n" ||
						(c.host && /^10\./.test(c.host)),
				);
				if (hasN2n && env.N2N_COMMUNITY) {
					const n2nHint = [
						"# ⚠ n2n P2P network proxy detected!",
						"# First join the n2n network on your device:",
						`#   sudo edge -c ${env.N2N_COMMUNITY} -k <N2N_KEY> -a 10.10.10.2 -l ${env.N2N_SUPERNODE || "supernode.ntop.org:7777"}`,
						"# Then use the subscription links below.",
						"# Get the key via: POST /mesh/n2n-join (auth required)",
						"",
					].join("\n");
					subscription = n2nHint + subscription;
				}

				return new Response(subscription, {
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"Cache-Control": "no-cache",
						...corsHeaders,
					},
				});
			}

			// Subscription — specific proxy
			if (path.startsWith("/sub/") && request.method === "GET") {
				const id = path.replace("/sub/", "");
				if (id === "all") {
					// Handled above, but just in case
					return new Response(
						generateSubscription(await listProxyConfigs(env), env),
						{
							headers: {
								"Content-Type": "text/plain; charset=utf-8",
								...corsHeaders,
							},
						},
					);
				}

				const data = await kvGet(env, `proxy:${id}`);
				if (!data) {
					return new Response(JSON.stringify({ error: "Proxy not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}
				return new Response(generateSubscription([JSON.parse(data)], env), {
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						...corsHeaders,
					},
				});
			}

			// List active proxies (JSON, no auth for now)
			if (path === "/proxies" && request.method === "GET") {
				const proxies = (await listProxyConfigs(env)).map(sanitizedProxy);
				return new Response(JSON.stringify(proxies, null, 2), {
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			}

			// Delete proxy (requires auth)
			if (path.startsWith("/delete/") && request.method === "DELETE") {
				if (!checkAuth(request, env)) {
					return new Response(JSON.stringify({ error: "Unauthorized" }), {
						status: 401,
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
				}
				const id = path.replace("/delete/", "");
				await kvDelete(env, `proxy:${id}`);
				return new Response(
					JSON.stringify({ success: true, message: "Proxy deleted" }),
					{ headers: { "Content-Type": "application/json", ...corsHeaders } },
				);
			}

			// API index
			return new Response(
				JSON.stringify({
					name: "BPB Action Coordinator",
					version: "1.2.0",
					endpoints: {
						"POST /register": "Register a new proxy (auth required)",
						"POST /heartbeat": "Refresh proxy TTL (auth required)",
						"POST /mesh/register":
							"Register signed public mesh metadata (auth required)",
						"POST /mesh/heartbeat":
							"Refresh signed mesh metadata TTL (auth required)",
						"POST /mesh/deregister": "Delete mesh metadata (auth required)",
						"GET /mesh/status": "Get mesh health summary",
						"GET /mesh/snapshot": "Get public mesh snapshot",
						"GET /bootstrap/peers": "Get bootstrap multiaddrs",
						"GET /mesh/n2n-config":
							"Get public n2n join info (community + supernode)",
						"POST /mesh/n2n-join":
							"Get full n2n config with key (auth required)",
						"GET /sub/all": "Get subscription for all proxies",
						"GET /sub/{id}": "Get subscription for specific proxy",
						"GET /proxies": "List all active proxies",
						"DELETE /delete/{id}": "Delete a proxy (auth required)",
						"GET /health": "Health check",
					},
				}),
				{ headers: { "Content-Type": "application/json", ...corsHeaders } },
			);
		} catch (error) {
			console.error("Error:", error);
			return new Response(JSON.stringify({ error: "Internal server error" }), {
				status: 500,
				headers: { "Content-Type": "application/json", ...corsHeaders },
			});
		}
	},
};
