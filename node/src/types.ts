// Animamesh — Data models for the DHT mesh node
// Mirrors the spec at SPEC-V3-ANIMAMESH-BACKEND.md §6

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

export interface DiscoveredRecord {
	/** The libp2p peer ID of the discovered node. */
	peerId: string;
	/** Multiaddrs the peer is listening on. */
	multiaddrs: string[];
	/** The parsed and optionally verified PublicProxyRecord. */
	record: PublicProxyRecord;
	/** ISO-8601 timestamp of when this record was discovered. */
	discoveredAt: string;
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

/** Runtime configuration for the mesh node, populated from environment variables. */
export interface MeshNodeConfig {
	/** libp2p listen addresses (default /ip4/0.0.0.0/tcp/0) */
	listenAddresses?: string[];
	/** Bootstrap peer multiaddrs */
	bootstrapPeers: string[];
	/** Network identifier */
	networkId: string;
	/** Proxy protocol */
	protocol: MeshProtocol;
	/** Proxy endpoint host */
	proxyHost: string;
	/** Proxy endpoint port */
	proxyPort: number;
	/** Proxy ingress type */
	ingress: MeshIngress;
	/** VLESS UUID (local only, never shared over DHT) */
	vlessUuid?: string;
	/** Hysteria2 password (local only, never shared over DHT) */
	hysteria2Password?: string;
	/** Ed25519 private key (base64 or PEM) for signing */
	signingPrivateKey?: string;
	/** Public key ID for the signing key */
	publicKeyId?: string;
	/** TTL in minutes */
	ttlMinutes: number;
	/** Coordinator URL for Worker registration */
	coordinatorUrl?: string;
	/** Auth token for Worker registration */
	authToken?: string;
	/** GitHub Actions run context */
	runContext?: {
		repository: string;
		runId: string;
		runAttempt: string;
		workflow: string;
		actor?: string;
	};
	/** Enable DHT client mode (default true — no inbound DHT queries) */
	dhtEnabled?: boolean;
	/** Enable IPFS mirror */
	ipfsEnabled?: boolean;
}
