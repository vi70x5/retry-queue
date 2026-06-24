import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canonicalJSONStringify,
	checkAuth,
	corsHeaders,
	type Env,
	generateHysteria2URL,
	generateSubscription,
	generateVlessURL,
	hasKV,
	kvDelete,
	kvGet,
	kvList,
	kvPut,
	memoryStore,
	type ProxyConfig,
	type PublicProxyRecord,
	ttlToSeconds,
	verifyPublicRecord,
	default as worker,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeConfig = (overrides: Partial<ProxyConfig> = {}): ProxyConfig => ({
	protocol: "vless",
	id: "test-1",
	host: "1.2.3.4",
	port: 443,
	uuid: "abc-123-def",
	createdAt: "2025-01-01T00:00:00Z",
	expiresAt: "2025-01-02T00:00:00Z",
	...overrides,
});

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
	...overrides,
});

/** Build a real Request object against our worker. */
const makeRequest = (
	path: string,
	options: RequestInit & { url?: string } = {},
) => {
	const base = options.url ?? "https://coordinator.test";
	const url = `${base}${path}`;
	const { url: _url, ...init } = options;
	return new Request(url, init);
};

const bearerHeader = (token: string) => ({
	Authorization: `Bearer ${token}`,
});

const jsonResponse = async (res: Response) => {
	const text = await res.text();
	return JSON.parse(text);
};

const toBase64 = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(
		bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
	).toString("base64");

const unsignedPayload = (record: PublicProxyRecord) => {
	const { signature: _signature, ...unsigned } = record;
	return canonicalJSONStringify(unsigned);
};

const generateMeshKeyPair = async () => {
	const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
	return { keyPair, publicKeyBase64: toBase64(publicKey) };
};

const makeUnsignedRecord = (
	overrides: Partial<PublicProxyRecord> = {},
): PublicProxyRecord => {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
	return {
		schema: "animamesh.proxy.v1",
		networkId: "animamesh-test",
		nodeId: "node-test-1",
		run: {
			repository: "owner/repo",
			runId: "123",
			runAttempt: "1",
			workflow: "proxy.yml",
			actor: "tester",
		},
		protocol: "vless",
		ingress: "cloudflared_quick",
		endpoint: {
			host: "abc.trycloudflare.com",
			port: 443,
			sni: "abc.trycloudflare.com",
			transport: "ws",
			path: "/ws",
			security: "tls",
		},
		capabilities: {
			ipv4: true,
			ipv6: false,
			udp: false,
		},
		lifecycle: {
			createdAt: now.toISOString(),
			expiresAt,
			heartbeatAt: now.toISOString(),
			ttlSeconds: 1800,
		},
		publicKeyId: "kid-test",
		signature: "",
		...overrides,
	};
};

const signRecord = async (
	record: PublicProxyRecord,
	keyPair: CryptoKeyPair,
): Promise<PublicProxyRecord> => {
	const signature = await crypto.subtle.sign(
		{ name: "Ed25519" },
		keyPair.privateKey,
		new TextEncoder().encode(unsignedPayload(record)),
	);
	return { ...record, signature: toBase64(signature) };
};

// ---------------------------------------------------------------------------
// 1. Pure function tests
// ---------------------------------------------------------------------------

describe("generateVlessURL", () => {
	it("produces correct vless URL with tcp (defaults)", () => {
		const config = makeConfig({
			protocol: "vless",
			security: "none",
			type: "tcp",
		});
		const url = generateVlessURL(config);
		expect(url).toMatch(/^vless:\/\//);
		expect(url).toContain(
			`vless://${config.uuid}@${config.host}:${config.port}`,
		);
		expect(url).toContain("security=none");
		expect(url).toContain("encryption=none");
		expect(url).toContain("type=tcp");
		expect(url).toContain("headerType=none");
		expect(url).toMatch(/#BPB-Action-test-1$/);
	});

	it("sets path param when type is ws", () => {
		const config = makeConfig({ protocol: "vless", type: "ws" });
		const url = generateVlessURL(config);
		expect(url).toContain("type=ws");
		expect(url).toContain("path=%2Fws");
	});

	it("uses custom path for ws", () => {
		const config = makeConfig({
			protocol: "vless",
			type: "ws",
			path: "/custom-ws",
		});
		const url = generateVlessURL(config);
		expect(url).toContain("path=%2Fcustom-ws");
	});

	it("defaults type to tcp when not specified", () => {
		const config = makeConfig({ protocol: "vless" });
		const url = generateVlessURL(config);
		expect(url).toContain("type=tcp");
	});

	it("includes sni param when provided", () => {
		const config = makeConfig({ protocol: "vless", sni: "example.com" });
		const url = generateVlessURL(config);
		expect(url).toContain("sni=example.com");
	});

	it("omits sni param when not provided", () => {
		const config = makeConfig({ protocol: "vless" });
		const url = generateVlessURL(config);
		expect(url).not.toContain("sni=");
	});

	it("defaults security to none when not provided", () => {
		const config = makeConfig({ protocol: "vless" });
		const url = generateVlessURL(config);
		expect(url).toContain("security=none");
	});

	it("uses tls security when set", () => {
		const config = makeConfig({ protocol: "vless", security: "tls" });
		const url = generateVlessURL(config);
		expect(url).toContain("security=tls");
	});

	it("fragment uses id", () => {
		const config = makeConfig({ protocol: "vless", id: "node-42" });
		const url = generateVlessURL(config);
		expect(url).toMatch(/#BPB-Action-node-42$/);
	});
});

describe("generateHysteria2URL", () => {
	it("produces correct hysteria2 URL", () => {
		const config = makeConfig({
			protocol: "hysteria2",
			password: "my-secret-pass",
		});
		const url = generateHysteria2URL(config);
		expect(url).toMatch(/^hysteria2:\/\//);
		expect(url).toContain(
			`hysteria2://${config.password}@${config.host}:${config.port}`,
		);
		expect(url).toContain("insecure=1");
		expect(url).toMatch(/#BPB-Action-test-1$/);
	});

	it("includes sni when provided", () => {
		const config = makeConfig({
			protocol: "hysteria2",
			password: "pass",
			sni: "my-sni.com",
		});
		const url = generateHysteria2URL(config);
		expect(url).toContain("sni=my-sni.com");
	});

	it("omits sni when not provided", () => {
		const config = makeConfig({
			protocol: "hysteria2",
			password: "pass",
		});
		const url = generateHysteria2URL(config);
		expect(url).not.toContain("sni=");
	});
});

describe("generateSubscription", () => {
	it("returns empty string for empty array", () => {
		expect(generateSubscription([])).toBe("");
	});

	it("generates single vless URL", () => {
		const config = makeConfig({ protocol: "vless" });
		const sub = generateSubscription([config]);
		expect(sub).toContain("vless://");
		expect(sub).not.toContain("hysteria2://");
	});

	it("generates single hysteria2 URL", () => {
		const config = makeConfig({ protocol: "hysteria2", password: "pw" });
		const sub = generateSubscription([config]);
		expect(sub).toContain("hysteria2://");
		expect(sub).not.toContain("vless://");
	});

	it("generates mixed subscription with newline separator", () => {
		const vless = makeConfig({ protocol: "vless", id: "v1" });
		const hy2 = makeConfig({ protocol: "hysteria2", password: "pw", id: "h1" });
		const sub = generateSubscription([vless, hy2]);
		const lines = sub.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("vless://");
		expect(lines[1]).toContain("hysteria2://");
	});

	it("filters out unknown protocol", () => {
		const config = makeConfig({ protocol: "vless" });
		// Force an unknown protocol by casting
		const unknown = makeConfig({
			protocol: "unknown" as ProxyConfig["protocol"],
			id: "bad",
		});
		const sub = generateSubscription([config, unknown]);
		expect(sub).toContain("vless://");
		// Only vless line should appear — unknown filtered out
		expect(sub.split("\n")).toHaveLength(1);
	});
});

describe("checkAuth", () => {
	it("allows all when no AUTH_TOKEN configured (dev mode)", () => {
		const req = makeRequest("/health");
		const env = makeEnv();
		expect(checkAuth(req, env)).toBe(true);
	});

	it("rejects when AUTH_TOKEN set but no Authorization header", () => {
		const req = makeRequest("/health");
		const env = makeEnv({ AUTH_TOKEN: "secret" });
		expect(checkAuth(req, env)).toBe(false);
	});

	it("accepts matching Bearer token", () => {
		const req = makeRequest("/health", {
			headers: bearerHeader("secret"),
		});
		const env = makeEnv({ AUTH_TOKEN: "secret" });
		expect(checkAuth(req, env)).toBe(true);
	});

	it("rejects mismatched Bearer token", () => {
		const req = makeRequest("/health", {
			headers: bearerHeader("wrong"),
		});
		const env = makeEnv({ AUTH_TOKEN: "secret" });
		expect(checkAuth(req, env)).toBe(false);
	});

	it("accepts raw token without Bearer prefix", () => {
		const req = makeRequest("/health", {
			headers: { Authorization: "secret" },
		});
		const env = makeEnv({ AUTH_TOKEN: "secret" });
		expect(checkAuth(req, env)).toBe(true);
	});

	it("rejects raw token that does not match", () => {
		const req = makeRequest("/health", {
			headers: { Authorization: "wrong" },
		});
		const env = makeEnv({ AUTH_TOKEN: "secret" });
		expect(checkAuth(req, env)).toBe(false);
	});
});

describe("ttlToSeconds", () => {
	it("returns 60 minimum for 0 minutes", () => {
		expect(ttlToSeconds(0)).toBe(60);
	});

	it("returns 60 minimum for 1 minute", () => {
		expect(ttlToSeconds(1)).toBe(60);
	});

	it("returns 900 for 15 minutes", () => {
		expect(ttlToSeconds(15)).toBe(900);
	});

	it("returns 3600 for 60 minutes", () => {
		expect(ttlToSeconds(60)).toBe(3600);
	});

	it("clamps negative to 60 minimum", () => {
		expect(ttlToSeconds(-10)).toBe(60);
	});
});

describe("hasKV", () => {
	it("returns true when BPB_KV is present", () => {
		const env = makeEnv({ BPB_KV: {} as KVNamespace });
		expect(hasKV(env)).toBe(true);
	});

	it("returns false when BPB_KV is absent", () => {
		const env = makeEnv();
		expect(hasKV(env)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. KV store tests (in-memory fallback)
// ---------------------------------------------------------------------------

describe("KV store (in-memory fallback)", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv(); // No BPB_KV → uses memoryStore
	});

	it("put + get roundtrip", async () => {
		await kvPut(env, "test-key", "hello", 60);
		const val = await kvGet(env, "test-key");
		expect(val).toBe("hello");
	});

	it("get returns null for missing key", async () => {
		const val = await kvGet(env, "nonexistent");
		expect(val).toBeNull();
	});

	it("get returns null for expired key", async () => {
		vi.useFakeTimers();
		try {
			await kvPut(env, "exp-key", "data", 1); // 1 second TTL
			vi.advanceTimersByTime(2000); // advance past expiry
			const val = await kvGet(env, "exp-key");
			expect(val).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("delete removes existing key", async () => {
		await kvPut(env, "del-key", "bye", 60);
		await kvDelete(env, "del-key");
		const val = await kvGet(env, "del-key");
		expect(val).toBeNull();
	});

	it("list filters by prefix", async () => {
		await kvPut(env, "proxy:a", "{}", 60);
		await kvPut(env, "proxy:b", "{}", 60);
		await kvPut(env, "other:c", "{}", 60);
		const keys = await kvList(env, "proxy:");
		expect(keys).toEqual(expect.arrayContaining(["proxy:a", "proxy:b"]));
		expect(keys).not.toContain("other:c");
	});

	it("list cleans up expired keys", async () => {
		vi.useFakeTimers();
		try {
			await kvPut(env, "proxy:expired", "old", 1); // 1s TTL
			await kvPut(env, "proxy:live", "new", 600);
			vi.advanceTimersByTime(2000);
			const keys = await kvList(env, "proxy:");
			expect(keys).toEqual(["proxy:live"]);
			// expired key should have been deleted from the store
			expect(memoryStore.has("proxy:expired")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("put overwrites existing key", async () => {
		await kvPut(env, "key", "first", 60);
		await kvPut(env, "key", "second", 60);
		const val = await kvGet(env, "key");
		expect(val).toBe("second");
	});
});

// ---------------------------------------------------------------------------
// 3. Fetch router tests
// ---------------------------------------------------------------------------

describe("fetch router", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv({ AUTH_TOKEN: "test-token" });
	});

	// -- OPTIONS (CORS preflight) --

	describe("OPTIONS", () => {
		it("returns CORS headers with 200", async () => {
			const res = await worker.fetch(
				makeRequest("/", { method: "OPTIONS" }),
				env,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
			expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
				"GET, POST, DELETE, OPTIONS",
			);
			expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
				"Content-Type, Authorization",
			);
		});
	});

	// -- GET /health --

	describe("GET /health", () => {
		it("returns ok with in-memory kv indicator", async () => {
			const res = await worker.fetch(makeRequest("/health"), env);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.status).toBe("ok");
			expect(body.kv).toBe("in-memory");
			expect(body.service).toBe("BPB Action Coordinator");
		});

		it("returns connected when KV is available", async () => {
			const kvEnv = makeEnv({
				BPB_KV: {} as KVNamespace,
				AUTH_TOKEN: "test-token",
			});
			const res = await worker.fetch(makeRequest("/health"), kvEnv);
			const body = await jsonResponse(res);
			expect(body.kv).toBe("connected");
		});
	});

	// -- POST /register --

	describe("POST /register", () => {
		const validConfig = {
			protocol: "vless" as const,
			id: "node-1",
			host: "5.6.7.8",
			port: 443,
			uuid: "uuid-1",
			createdAt: "2025-01-01T00:00:00Z",
			expiresAt: "2025-01-02T00:00:00Z",
		};

		it("returns 401 without auth", async () => {
			const res = await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(validConfig),
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("returns 400 for missing required fields", async () => {
			const res = await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ protocol: "vless" }), // missing id, host, port
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toContain("Missing required fields");
		});

		it("returns 200 with subscription URL and default TTL", async () => {
			const res = await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(validConfig),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.success).toBe(true);
			expect(body.subscriptionUrl).toContain("/sub/all");
			// No expiresAt → remaining > 0 check reads the expiresAt field
			// The config has expiresAt in the past relative to test time,
			// but the code checks data.expiresAt which is on the input body.
			// Since we pass expiresAt string, the remaining may be negative → defaults to 3600
			expect(body.ttlSeconds).toBeDefined();
		});

		it("calculates TTL from future expiresAt with +300 buffer, capped at 7200", async () => {
			const futureDate = new Date(Date.now() + 1800 * 1000).toISOString(); // 30 min from now
			const res = await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ ...validConfig, expiresAt: futureDate }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			// remaining ~1800 + 300 buffer = ~2100
			expect(body.ttlSeconds).toBeLessThanOrEqual(7200);
			expect(body.ttlSeconds).toBeGreaterThan(1500);
		});

		it("defaults TTL to 3600 when expiresAt is in the past", async () => {
			const pastDate = new Date(Date.now() - 60000).toISOString(); // 1 min ago
			const res = await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ ...validConfig, expiresAt: pastDate }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			// remaining <= 0 → ttlSeconds stays 3600, then +300 buffer, capped at 7200
			expect(body.ttlSeconds).toBe(3900); // 3600 + 300
		});

		it("stores proxy in KV", async () => {
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(validConfig),
				}),
				env,
			);
			const stored = await kvGet(env, "proxy:node-1");
			expect(stored).not.toBeNull();
		});
	});

	// -- POST /heartbeat --

	describe("POST /heartbeat", () => {
		it("returns 401 without auth", async () => {
			const res = await worker.fetch(
				makeRequest("/heartbeat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "x" }),
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("returns 400 for missing id", async () => {
			const res = await worker.fetch(
				makeRequest("/heartbeat", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({}),
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Missing id");
		});

		it("returns 404 when proxy not found", async () => {
			const res = await worker.fetch(
				makeRequest("/heartbeat", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ id: "nonexistent" }),
				}),
				env,
			);
			expect(res.status).toBe(404);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Proxy not found");
		});

		it("returns 200 with refreshed TTL for existing proxy", async () => {
			// Register first
			const config = {
				protocol: "vless" as const,
				id: "hb-1",
				host: "1.2.3.4",
				port: 443,
				uuid: "uuid-x",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			// Heartbeat without expiresAt
			const res = await worker.fetch(
				makeRequest("/heartbeat", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ id: "hb-1" }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.success).toBe(true);
			expect(body.ttlSeconds).toBe(3600); // default
		});

		it("calculates TTL from expiresAt with +300 buffer", async () => {
			// Register first
			const config = {
				protocol: "vless" as const,
				id: "hb-2",
				host: "1.2.3.4",
				port: 443,
				uuid: "uuid-y",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			const futureDate = new Date(Date.now() + 600 * 1000).toISOString(); // 10 min
			const res = await worker.fetch(
				makeRequest("/heartbeat", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ id: "hb-2", expiresAt: futureDate }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			// remaining ~600 + 300 buffer = ~900
			expect(body.ttlSeconds).toBeGreaterThan(500);
			expect(body.ttlSeconds).toBeLessThanOrEqual(1100);
		});
	});

	describe("V3 mesh routes", () => {
		const meshEnv = async () => {
			const { keyPair, publicKeyBase64 } = await generateMeshKeyPair();
			const env = makeEnv({
				AUTH_TOKEN: "test-token",
				NETWORK_ID: "animamesh-test",
				VLESS_UUID: "env-vless-uuid",
				HY2_PASSWORD: "env-hy2-password",
				MESH_PUBLIC_KEYS: JSON.stringify({ "kid-test": publicKeyBase64 }),
				MESH_PUBLIC_KEY_ID: "kid-test",
				BOOTSTRAP_PEERS: "/ip4/127.0.0.1/tcp/4001/p2p/test",
			});
			return { env, keyPair };
		};

		// Test 1: Rejects unsigned /mesh/register
		it("rejects unsigned /mesh/register", async () => {
			const { env } = await meshEnv();
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record: makeUnsignedRecord() }),
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Missing signature");
		});

		// Test 2: Rejects expired record
		it("rejects expired record", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(
				makeUnsignedRecord({
					lifecycle: {
						createdAt: "2026-01-01T00:00:00.000Z",
						expiresAt: "2026-01-01T00:10:00.000Z",
						heartbeatAt: "2026-01-01T00:00:00.000Z",
						ttlSeconds: 600,
					},
				}),
				keyPair,
			);
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Record expired");
		});

		// Test 3: Rejects wrong networkId
		it("rejects wrong networkId", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(
				makeUnsignedRecord({ networkId: "other-network" }),
				keyPair,
			);
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Wrong networkId");
		});

		// Test 4: Rejects invalid endpoint host (private IP with non-n2n ingress)
		it("rejects private endpoint host with non-n2n ingress", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(
				makeUnsignedRecord({
					endpoint: {
						host: "10.0.0.1",
						port: 443,
						sni: "10.0.0.1",
						security: "tls",
					},
				}),
				keyPair,
			);
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			expect(res.status).toBe(400);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Invalid endpoint host");
		});

		// Test 5: Accepts n2n ingress with private IP
		it("accepts n2n ingress with private IP", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(
				makeUnsignedRecord({
					ingress: "n2n",
					endpoint: {
						host: "10.10.10.1",
						port: 443,
						sni: "mesh.local",
						security: "none",
					},
				}),
				keyPair,
			);
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.success).toBe(true);
		});

		// Test 6: Accepts valid signed record
		it("accepts valid signed record", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(makeUnsignedRecord(), keyPair);
			const res = await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.success).toBe(true);
			expect(body.message).toBe("Mesh record registered");
			expect(body.subscriptionUrl).toContain("/sub/all");
			expect(body.ttlSeconds).toBeGreaterThan(0);
		});

		// Test 7: /sub/all renders env-derived VLESS and Hy2 links
		it("/sub/all renders env-derived VLESS and Hy2 links", async () => {
			const { env, keyPair } = await meshEnv();
			const vless = await signRecord(makeUnsignedRecord(), keyPair);
			const hy2 = await signRecord(
				makeUnsignedRecord({
					nodeId: "node-hy2-1",
					protocol: "hysteria2",
					endpoint: {
						host: "hy2.trycloudflare.com",
						port: 443,
						sni: "hy2.trycloudflare.com",
						security: "tls",
					},
				}),
				keyPair,
			);
			for (const record of [vless, hy2]) {
				const res = await worker.fetch(
					makeRequest("/mesh/register", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...bearerHeader("test-token"),
						},
						body: JSON.stringify({ record }),
					}),
					env,
				);
				expect(res.status).toBe(200);
			}
			// Records have no uuid/password - Worker fills from env
			const sub = await worker.fetch(makeRequest("/sub/all"), env);
			const text = await sub.text();
			expect(text).toContain(
				"vless://env-vless-uuid@abc.trycloudflare.com:443",
			);
			expect(text).toContain(
				"hysteria2://env-hy2-password@hy2.trycloudflare.com:443",
			);
		});

		// Test 8: /proxies and /mesh/status do not expose secrets
		it("/proxies and /mesh/status do not expose secrets", async () => {
			const { env, keyPair } = await meshEnv();
			const record = await signRecord(makeUnsignedRecord(), keyPair);
			await worker.fetch(
				makeRequest("/mesh/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify({ record }),
				}),
				env,
			);
			const proxies = await (
				await worker.fetch(makeRequest("/proxies"), env)
			).text();
			const status = await (
				await worker.fetch(makeRequest("/mesh/status"), env)
			).text();
			// No secrets should leak into public endpoints
			expect(proxies).not.toContain("env-vless-uuid");
			expect(proxies).not.toContain("env-hy2-password");
			expect(proxies).not.toContain("test-token");
			expect(status).not.toContain("env-vless-uuid");
			expect(status).not.toContain("env-hy2-password");
			expect(status).not.toContain("test-token");
			expect(JSON.parse(status).activeNodes).toBe(1);
		});

		it("returns bootstrap peers", async () => {
			const { env } = await meshEnv();
			const res = await worker.fetch(makeRequest("/bootstrap/peers"), env);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.peers).toEqual(["/ip4/127.0.0.1/tcp/4001/p2p/test"]);
		});
	});

	// -- GET /sub/all --

	describe("GET /sub/all", () => {
		it("returns subscription text for all proxies", async () => {
			const config = {
				protocol: "vless" as const,
				id: "sub-1",
				host: "10.0.0.1",
				port: 443,
				uuid: "uuid-sub",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			const res = await worker.fetch(makeRequest("/sub/all"), env);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/plain");
			const text = await res.text();
			expect(text).toContain("vless://");
			expect(text).toContain("BPB-Action-sub-1");
		});

		it("returns empty string when no proxies", async () => {
			const res = await worker.fetch(makeRequest("/sub/all"), env);
			const text = await res.text();
			expect(text).toBe("");
		});
	});

	// -- GET /sub/{id} --

	describe("GET /sub/{id}", () => {
		it("returns 404 for unknown proxy", async () => {
			const res = await worker.fetch(makeRequest("/sub/unknown"), env);
			expect(res.status).toBe(404);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Proxy not found");
		});

		it("returns subscription for specific proxy", async () => {
			const config = {
				protocol: "hysteria2" as const,
				id: "sub-spec",
				host: "10.0.0.2",
				port: 8443,
				password: "hy2pass",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			const res = await worker.fetch(makeRequest("/sub/sub-spec"), env);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toContain("hysteria2://");
			expect(text).toContain("BPB-Action-sub-spec");
		});
	});

	// -- GET /proxies --

	describe("GET /proxies", () => {
		it("returns JSON array of proxies", async () => {
			const config = {
				protocol: "vless" as const,
				id: "list-1",
				host: "10.0.0.3",
				port: 443,
				uuid: "uuid-list",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			const res = await worker.fetch(makeRequest("/proxies"), env);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(Array.isArray(body)).toBe(true);
			expect(body).toHaveLength(1);
			expect(body[0].id).toBe("list-1");
			expect(body[0].protocol).toBe("vless");
			expect(body[0].host).toBe("10.0.0.3");
		});

		it("returns empty array when no proxies", async () => {
			const res = await worker.fetch(makeRequest("/proxies"), env);
			const body = await jsonResponse(res);
			expect(body).toEqual([]);
		});
	});

	// -- DELETE /delete/{id} --

	describe("DELETE /delete/{id}", () => {
		it("returns 401 without auth", async () => {
			const res = await worker.fetch(
				makeRequest("/delete/x", { method: "DELETE" }),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("deletes proxy and returns 200", async () => {
			// Register
			const config = {
				protocol: "vless" as const,
				id: "del-1",
				host: "10.0.0.4",
				port: 443,
				uuid: "uuid-del",
				createdAt: "2025-01-01T00:00:00Z",
				expiresAt: "2025-01-02T00:00:00Z",
			};
			await worker.fetch(
				makeRequest("/register", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...bearerHeader("test-token"),
					},
					body: JSON.stringify(config),
				}),
				env,
			);

			const res = await worker.fetch(
				makeRequest("/delete/del-1", {
					method: "DELETE",
					headers: bearerHeader("test-token"),
				}),
				env,
			);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.success).toBe(true);
			expect(body.message).toBe("Proxy deleted");

			// Verify gone
			const stored = await kvGet(env, "proxy:del-1");
			expect(stored).toBeNull();
		});
	});

	// -- Unknown path → API index --

	describe("Unknown path", () => {
		it("returns API index JSON", async () => {
			const res = await worker.fetch(makeRequest("/"), env);
			expect(res.status).toBe(200);
			const body = await jsonResponse(res);
			expect(body.name).toBe("BPB Action Coordinator");
			expect(body.version).toBe("1.2.0");
			expect(body.endpoints).toBeDefined();
		});
	});

	// -- Error handling (500) --

	describe("Error handling", () => {
		it("returns 500 when handler throws", async () => {
			// Force an error by making request.json() throw
			const badReq = makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: "not-json{{",
			});
			const res = await worker.fetch(badReq, env);
			expect(res.status).toBe(500);
			const body = await jsonResponse(res);
			expect(body.error).toBe("Internal server error");
		});
	});

	// -- CORS headers on all responses --

	describe("CORS headers", () => {
		it("are present on health response", async () => {
			const res = await worker.fetch(makeRequest("/health"), env);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		});

		it("are present on API index response", async () => {
			const res = await worker.fetch(makeRequest("/"), env);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		});
	});
});

// ---------------------------------------------------------------------------
// 4. corsHeaders constant
// ---------------------------------------------------------------------------

describe("corsHeaders", () => {
	it("has expected keys", () => {
		expect(corsHeaders["Access-Control-Allow-Origin"]).toBe("*");
		expect(corsHeaders["Access-Control-Allow-Methods"]).toBe(
			"GET, POST, DELETE, OPTIONS",
		);
		expect(corsHeaders["Access-Control-Allow-Headers"]).toBe(
			"Content-Type, Authorization",
		);
	});
});

// ---------------------------------------------------------------------------
// 5. KV store with real KVNamespace mock
// ---------------------------------------------------------------------------

describe("KV store (with KVNamespace)", () => {
	let mockKV: KVNamespace;
	let kvEnv: Env;

	beforeEach(() => {
		memoryStore.clear();
		mockKV = {
			put: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockResolvedValue(null),
			delete: vi.fn().mockResolvedValue(undefined),
			list: vi.fn().mockResolvedValue({ keys: [] }),
		} as unknown as KVNamespace;
		kvEnv = makeEnv({ BPB_KV: mockKV });
	});

	it("put delegates to KVNamespace", async () => {
		await kvPut(kvEnv, "key", "value", 60);
		expect(mockKV.put).toHaveBeenCalledWith("key", "value", {
			expirationTtl: 60,
		});
	});

	it("get delegates to KVNamespace", async () => {
		mockKV.get = vi.fn().mockResolvedValue("kv-value");
		const val = await kvGet(kvEnv, "key");
		expect(mockKV.get).toHaveBeenCalledWith("key");
		expect(val).toBe("kv-value");
	});

	it("delete delegates to KVNamespace", async () => {
		await kvDelete(kvEnv, "key");
		expect(mockKV.delete).toHaveBeenCalledWith("key");
	});

	it("list delegates to KVNamespace and extracts names", async () => {
		mockKV.list = vi.fn().mockResolvedValue({
			keys: [{ name: "proxy:a" }, { name: "proxy:b" }],
		});
		const keys = await kvList(kvEnv, "proxy:");
		expect(mockKV.list).toHaveBeenCalledWith({ prefix: "proxy:" });
		expect(keys).toEqual(["proxy:a", "proxy:b"]);
	});

	it("hasKV returns true for mocked KV", () => {
		expect(hasKV(kvEnv)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. Register edge cases
// ---------------------------------------------------------------------------

describe("POST /register edge cases", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv({ AUTH_TOKEN: "test-token" });
	});

	it("returns 400 when id is missing", async () => {
		const res = await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify({
					protocol: "vless",
					host: "1.2.3.4",
					port: 443,
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: "2025-01-02T00:00:00Z",
				}),
			}),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonResponse(res);
		expect(body.error).toContain("Missing required fields");
	});

	it("returns 400 when host is missing", async () => {
		const res = await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify({
					protocol: "vless",
					id: "test",
					port: 443,
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: "2025-01-02T00:00:00Z",
				}),
			}),
			env,
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when port is missing", async () => {
		const res = await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify({
					protocol: "vless",
					id: "test",
					host: "1.2.3.4",
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: "2025-01-02T00:00:00Z",
				}),
			}),
			env,
		);
		expect(res.status).toBe(400);
	});

	it("caps TTL at 7200 when remaining time is very large", async () => {
		const farFuture = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24h from now
		const res = await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify({
					protocol: "vless",
					id: "cap-1",
					host: "1.2.3.4",
					port: 443,
					uuid: "uuid-cap",
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: farFuture,
				}),
			}),
			env,
		);
		expect(res.status).toBe(200);
		const body = await jsonResponse(res);
		// remaining ~86400 + 300 = 86700, capped at 7200
		expect(body.ttlSeconds).toBe(7200);
	});
});

// ---------------------------------------------------------------------------
// 7. Heartbeat edge cases
// ---------------------------------------------------------------------------

describe("POST /heartbeat edge cases", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv({ AUTH_TOKEN: "test-token" });
	});

	it("returns 200 with default TTL when expiresAt is in the past", async () => {
		// Register first
		const config = {
			protocol: "vless" as const,
			id: "hb-past",
			host: "1.2.3.4",
			port: 443,
			uuid: "uuid-past",
			createdAt: "2025-01-01T00:00:00Z",
			expiresAt: "2025-01-02T00:00:00Z",
		};
		await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify(config),
			}),
			env,
		);

		// Heartbeat with past expiresAt
		const pastDate = new Date(Date.now() - 60000).toISOString();
		const res = await worker.fetch(
			makeRequest("/heartbeat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify({ id: "hb-past", expiresAt: pastDate }),
			}),
			env,
		);
		expect(res.status).toBe(200);
		const body = await jsonResponse(res);
		// remaining <= 0 → ttlSeconds stays 3600
		expect(body.ttlSeconds).toBe(3600);
	});
});

// ---------------------------------------------------------------------------
// 8. Subscription with mixed protocols
// ---------------------------------------------------------------------------

describe("GET /sub/all with mixed protocols", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv({ AUTH_TOKEN: "test-token" });
	});

	it("returns both vless and hysteria2 URLs", async () => {
		const vlessConfig = {
			protocol: "vless" as const,
			id: "mix-v",
			host: "1.2.3.4",
			port: 443,
			uuid: "uuid-mix",
			createdAt: "2025-01-01T00:00:00Z",
			expiresAt: "2025-01-02T00:00:00Z",
		};
		const hy2Config = {
			protocol: "hysteria2" as const,
			id: "mix-h",
			host: "5.6.7.8",
			port: 8443,
			password: "hy2-mix",
			createdAt: "2025-01-01T00:00:00Z",
			expiresAt: "2025-01-02T00:00:00Z",
		};
		await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify(vlessConfig),
			}),
			env,
		);
		await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify(hy2Config),
			}),
			env,
		);

		const res = await worker.fetch(makeRequest("/sub/all"), env);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("vless://");
		expect(text).toContain("hysteria2://");
		expect(text).toContain("BPB-Action-mix-v");
		expect(text).toContain("BPB-Action-mix-h");
	});
});

// ---------------------------------------------------------------------------
// 9. API index structure
// ---------------------------------------------------------------------------

describe("API index endpoint", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv();
	});

	it("lists all expected endpoints", async () => {
		const res = await worker.fetch(makeRequest("/"), env);
		expect(res.status).toBe(200);
		const body = await jsonResponse(res);
		expect(body.name).toBe("BPB Action Coordinator");
		expect(body.version).toBe("1.2.0");
		expect(body.endpoints).toEqual({
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
			"POST /mesh/n2n-join": "Get full n2n config with key (auth required)",
			"GET /sub/all": "Get subscription for all proxies",
			"GET /sub/{id}": "Get subscription for specific proxy",
			"GET /proxies": "List all active proxies",
			"DELETE /delete/{id}": "Delete a proxy (auth required)",
			"GET /health": "Health check",
		});
	});
});

// ---------------------------------------------------------------------------
// 10. CORS preflight on various paths
// ---------------------------------------------------------------------------

describe("CORS preflight on various paths", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv();
	});

	it("returns CORS headers for OPTIONS on /register", async () => {
		const res = await worker.fetch(
			makeRequest("/register", { method: "OPTIONS" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("returns CORS headers for OPTIONS on /sub/all", async () => {
		const res = await worker.fetch(
			makeRequest("/sub/all", { method: "OPTIONS" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("returns CORS headers for OPTIONS on /health", async () => {
		const res = await worker.fetch(
			makeRequest("/health", { method: "OPTIONS" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

// ---------------------------------------------------------------------------
// 11. Proxies list excludes sensitive fields
// ---------------------------------------------------------------------------

describe("GET /proxies excludes sensitive fields", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv({ AUTH_TOKEN: "test-token" });
	});

	it("does not expose uuid or password in list", async () => {
		const config = {
			protocol: "vless" as const,
			id: "priv-1",
			host: "1.2.3.4",
			port: 443,
			uuid: "secret-uuid",
			createdAt: "2025-01-01T00:00:00Z",
			expiresAt: "2025-01-02T00:00:00Z",
		};
		await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeader("test-token"),
				},
				body: JSON.stringify(config),
			}),
			env,
		);

		const res = await worker.fetch(makeRequest("/proxies"), env);
		const body = await jsonResponse(res);
		expect(body).toHaveLength(1);
		expect(body[0]).not.toHaveProperty("uuid");
		expect(body[0]).not.toHaveProperty("password");
		expect(body[0]).toHaveProperty("id", "priv-1");
	});
});

// ---------------------------------------------------------------------------
// 12. Dev mode (no AUTH_TOKEN) allows register
// ---------------------------------------------------------------------------

describe("Dev mode (no AUTH_TOKEN)", () => {
	let env: Env;

	beforeEach(() => {
		memoryStore.clear();
		env = makeEnv(); // No AUTH_TOKEN
	});

	it("allows register without auth header", async () => {
		const res = await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					protocol: "vless",
					id: "dev-1",
					host: "1.2.3.4",
					port: 443,
					uuid: "uuid-dev",
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: "2025-01-02T00:00:00Z",
				}),
			}),
			env,
		);
		expect(res.status).toBe(200);
		const body = await jsonResponse(res);
		expect(body.success).toBe(true);
	});

	it("allows delete without auth header", async () => {
		// Register first
		await worker.fetch(
			makeRequest("/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					protocol: "vless",
					id: "dev-2",
					host: "1.2.3.4",
					port: 443,
					uuid: "uuid-dev2",
					createdAt: "2025-01-01T00:00:00Z",
					expiresAt: "2025-01-02T00:00:00Z",
				}),
			}),
			env,
		);

		const res = await worker.fetch(
			makeRequest("/delete/dev-2", { method: "DELETE" }),
			env,
		);
		expect(res.status).toBe(200);
		const body = await jsonResponse(res);
		expect(body.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 13. verifyPublicRecord pure function tests
// ---------------------------------------------------------------------------

describe("verifyPublicRecord", () => {
	let keyPair: CryptoKeyPair;
	let publicKeyBase64: string;
	let env: Env;

	beforeEach(async () => {
		memoryStore.clear();
		const generated = await generateMeshKeyPair();
		keyPair = generated.keyPair;
		publicKeyBase64 = generated.publicKeyBase64;
		env = makeEnv({
			AUTH_TOKEN: "test-token",
			NETWORK_ID: "animamesh-test",
			MESH_PUBLIC_KEYS: JSON.stringify({ "kid-test": publicKeyBase64 }),
		});
	});

	it("returns ok for a valid signed record", async () => {
		const record = await signRecord(makeUnsignedRecord(), keyPair);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(true);
	});

	it("rejects missing record", async () => {
		const result = await verifyPublicRecord(
			null as unknown as PublicProxyRecord,
			env,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Missing record");
	});

	it("rejects wrong schema", async () => {
		const record = makeUnsignedRecord({
			schema: "wrong.v1",
		} as PublicProxyRecord);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Unsupported schema");
	});

	it("rejects wrong networkId", async () => {
		const record = await signRecord(
			makeUnsignedRecord({ networkId: "other-network" }),
			keyPair,
		);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Wrong networkId");
	});

	it("accepts n2n ingress with private IP host", async () => {
		const record = await signRecord(
			makeUnsignedRecord({
				ingress: "n2n",
				endpoint: {
					host: "10.10.10.1",
					port: 443,
					sni: "mesh.local",
					security: "none",
				},
			}),
			keyPair,
		);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(true);
	});

	it("rejects private IP with non-n2n ingress", async () => {
		const record = await signRecord(
			makeUnsignedRecord({
				endpoint: {
					host: "10.0.0.1",
					port: 443,
					sni: "10.0.0.1",
					security: "tls",
				},
			}),
			keyPair,
		);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Invalid endpoint host");
	});

	it("rejects expired records", async () => {
		const record = await signRecord(
			makeUnsignedRecord({
				lifecycle: {
					createdAt: "2026-01-01T00:00:00.000Z",
					expiresAt: "2026-01-01T00:10:00.000Z",
					heartbeatAt: "2026-01-01T00:00:00.000Z",
					ttlSeconds: 600,
				},
			}),
			keyPair,
		);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Record expired");
	});

	it("rejects records without signature", async () => {
		const record = makeUnsignedRecord(); // signature: ""
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Missing signature");
	});

	it("rejects bad signature", async () => {
		const record = { ...makeUnsignedRecord(), signature: "AAAA" };
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Bad signature");
	});

	it("rejects unknown publicKeyId", async () => {
		const record = await signRecord(
			{ ...makeUnsignedRecord(), publicKeyId: "unknown-key" },
			keyPair,
		);
		const result = await verifyPublicRecord(record, env);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("Unknown publicKeyId");
	});
});

// ---------------------------------------------------------------------------
// 14. canonicalJSONStringify
// ---------------------------------------------------------------------------

describe("canonicalJSONStringify", () => {
	it("sorts object keys", () => {
		const result = canonicalJSONStringify({ z: 1, a: 2, m: 3 });
		expect(result).toBe('{"a":2,"m":3,"z":1}');
	});

	it("sorts nested object keys recursively", () => {
		const result = canonicalJSONStringify({ outer: { z: 1, a: 2 } });
		expect(result).toBe('{"outer":{"a":2,"z":1}}');
	});

	it("handles arrays without reordering", () => {
		const result = canonicalJSONStringify({ items: [3, 1, 2] });
		expect(result).toBe('{"items":[3,1,2]}');
	});

	it("strips undefined values", () => {
		const result = canonicalJSONStringify({ a: 1, b: undefined, c: 3 });
		expect(result).toBe('{"a":1,"c":3}');
	});
});
