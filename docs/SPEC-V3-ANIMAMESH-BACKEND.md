# Animamesh / BPB Action Mesh V3 Backend Specification

**Status:** Draft implementation spec  
**Date:** 2026-06-24  
**Scope:** Backend MVP for GitHub Actions proxy runners, signed mesh metadata,
optional DHT discovery, Cloudflare Worker subscription compatibility, and future
IPFS/IPNS mirroring.

This document supersedes the DHT, secret-handling, and Worker-discovery parts of
`docs/SPEC-V2-MESH.md`. It keeps the core invariant: libp2p is discovery only.
Proxy traffic flows directly over VLESS or Hysteria2, never through DHT.

## 1. Executive Summary

Animamesh turns trusted GitHub Actions runners into short-lived proxy nodes. Each
runner starts a proxy service, exposes it through a public ingress such as
cloudflared or ngrok, signs a metadata record, and advertises that record through
the most reliable available paths:

1. Cloudflare Worker registration for stock Hiddify compatibility.
2. libp2p DHT rendezvous for decentralized discovery.
3. Optional IPFS/IPNS mirror for signed public snapshots.

The Worker remains the practical compatibility layer because stock Hiddify needs
an HTTP subscription URL. DHT and IPFS are used to reduce reliance on the Worker,
not to put secrets or proxy traffic into a public overlay.

## 2. Goals and Non-Goals

### Goals

- Run VLESS or Hysteria2 nodes inside trusted GitHub Actions workflows.
- Let nodes announce endpoint metadata without publishing protocol secrets.
- Serve a Hiddify-compatible subscription from `GET /sub/all`.
- Keep the existing Worker API backward compatible.
- Make DHT discovery useful without assuming prefix scans or Worker-side libp2p.
- Provide a path to IPFS/IPNS mirroring for signed snapshots.
- Degrade gracefully: Worker-only works first; DHT improves resilience later.

### Non-Goals

- Do not modify Hiddify for the MVP.
- Do not route proxy traffic through libp2p, IPFS, or the Worker.
- Do not expose secrets in DHT or IPFS metadata.
- Do not rely on Cloudflare Workers to run a libp2p Kademlia node.
- Do not use GitHub Actions for production traffic.
- Do not support untrusted external pull requests with secret-bearing workflows.

## 3. Current Repository Assumptions

Current repository layout observed for this draft:

- `worker/src/index.ts` already implements `/register`, `/heartbeat`,
  `/sub/all`, `/sub/{id}`, `/proxies`, `/delete/{id}`, and `/health`.
- `.github/workflows/proxy.yml` already starts VLESS/Hysteria2, creates an
  ingress, registers with the Worker, and heartbeats.
- `src/` contains the dashboard.
- `scripts/` contains workflow helper CLIs.
- A `node/` package is described by project docs but is not currently present in
  the checked-out tree. V3 creates it as a new package.

## 4. Target Architecture

```
Trusted GitHub org/repo secrets
        |
        v
GitHub Actions runner
  - starts sing-box or hysteria2
  - starts cloudflared/ngrok ingress
  - creates signed PublicProxyRecord without secrets
  - POSTs Worker registration for stock Hiddify
  - optionally publishes DHT rendezvous/provider record
        |
        +--------------------+
                             |
                             v
Cloudflare Worker       libp2p DHT
  - verifies auth       - rendezvous discovery only
  - stores active       - signed public metadata only
    registrations       - no prefix scans
  - serves /sub/all
        |
        v
Stock Hiddify imports one HTTP subscription URL
        |
        v
Direct VLESS/Hy2 connection to runner ingress
```

### Core Decision

The Worker is not a DHT client in the MVP. Cloudflare Workers cannot reliably run
Kademlia because they do not expose normal long-lived TCP/UDP sockets. If DHT
records need to feed the Worker, add a separate indexer process later.

## 5. Trust and Threat Model

### Trusted

- GitHub organization/repository secrets configured by the operator.
- Workflows triggered by trusted `workflow_dispatch`, `schedule`, or protected
  branch events.
- Worker deployment and Worker secrets.
- Optional stable DHT bootstrap/indexer nodes controlled by the operator.

### Untrusted

- Public DHT participants.
- Public IPFS gateways and anyone who knows a CID/IPNS name.
- GitHub Actions logs as a potentially leaky surface.
- External pull requests and personal forks outside the trusted organization.

### Security Rules

- DHT records must not contain `uuid`, `password`, bearer tokens, or Worker auth.
- IPFS/IPNS public snapshots must not contain private subscription links unless
  the operator intentionally runs a public mesh.
- Public records are signed. Receivers reject unsigned, expired, wrong-network,
  malformed, or replayed records.
- Worker registration remains bearer-authenticated.
- Secret-bearing workflows must not run on `pull_request` from forks.

## 6. Data Models

### PublicProxyRecord

This is safe to place in DHT and IPFS.

```ts
export type MeshProtocol = "vless" | "hysteria2";
export type MeshIngress = "cloudflared_quick" | "cloudflared_named" | "ngrok";

export interface PublicProxyRecord {
  schema: "animamesh.proxy.v1";
  networkId: string;
  nodeId: string;
  run: {
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
  capabilities: {
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
```

`nodeId` should be deterministic for one workflow attempt:

```text
sha256("{repository}:{runId}:{runAttempt}:{protocol}:{endpoint.host}")
```

### PrivateSubscriptionMaterial

This never goes into DHT/IPFS. It exists as GitHub/Worker secrets or an
operator-controlled KV value.

```ts
export interface PrivateSubscriptionMaterial {
  networkId: string;
  vlessUuid?: string;
  hysteria2Password?: string;
  authToken: string;
}
```

### WorkerProxyConfig

The existing Worker accepts full proxy configs with secrets. V3 should keep this
for backward compatibility, but add a safer route that stores public metadata and
derives secrets from Worker env.

```ts
export interface WorkerProxyConfig {
  id: string;
  protocol: MeshProtocol;
  host: string;
  port: number;
  sni?: string;
  type?: "tcp" | "ws";
  path?: string;
  security?: "tls" | "none";
  createdAt: string;
  expiresAt: string;

  // Legacy path only. Do not mirror these to public DHT/IPFS records.
  uuid?: string;
  password?: string;

  // V3 public metadata fields.
  networkId?: string;
  nodeId?: string;
  publicRecord?: PublicProxyRecord;
}
```

### SignedSnapshot

Used by optional IPFS/IPNS mirroring.

```ts
export interface SignedSnapshot {
  schema: "animamesh.snapshot.v1";
  networkId: string;
  generatedAt: string;
  expiresAt: string;
  records: PublicProxyRecord[];
  publicKeyId: string;
  signature: string;
}
```

## 7. Signing Model

### MVP Signing

Use an Ed25519 key pair:

- `MESH_SIGNING_PRIVATE_KEY` in GitHub org/repo secrets for runners.
- `MESH_SIGNING_PUBLIC_KEY` in Worker secrets/config for verification.
- `MESH_PUBLIC_KEY_ID` identifies the current key.

The signature covers canonical JSON with:

- `signature` field omitted.
- keys sorted recursively.
- UTF-8 JSON with no insignificant formatting requirements beyond canonical
  serialization.

### Rotation

Worker supports:

```ts
MESH_PUBLIC_KEYS='{"kid-2026-06":"base64-public-key","kid-next":"base64-public-key"}'
```

Records include `publicKeyId`. Worker accepts only known IDs.

## 8. DHT Protocol

### What DHT Can and Cannot Do

DHT lookups are exact-key/provider lookups. Do not design around prefix scans
such as:

```text
/bpb/v2/{networkId}/*
```

Instead use rendezvous provider discovery.

### Rendezvous Keys

Each protocol has one rendezvous content key:

```text
animamesh:v1:{networkId}:vless
animamesh:v1:{networkId}:hysteria2
animamesh:v1:{networkId}:all
```

Implementation converts the string to a CID/multihash according to the libp2p JS
version in use. The important property is deterministic exact lookup, not the
text form.

### Publish Flow

1. Runner creates `PublicProxyRecord`.
2. Runner signs it.
3. Runner publishes itself as a provider for:
   - `animamesh:v1:{networkId}:all`
   - `animamesh:v1:{networkId}:{protocol}`
4. Runner exposes the signed record through a small libp2p protocol:

```text
/animamesh/proxy-record/1.0.0
```

The protocol returns one JSON `PublicProxyRecord` and closes.

### Discover Flow

1. A DHT-aware client or indexer calls `findProviders(rendezvousKey)`.
2. For each provider, it dials `/animamesh/proxy-record/1.0.0`.
3. It verifies record signature, network, protocol, endpoint shape, and expiry.
4. It deduplicates by `nodeId`, keeping the newest valid heartbeat.

This avoids unsupported prefix scans and avoids storing secrets in the DHT.

### DHT Deployment Reality

GitHub Actions runners are not reliable public DHT servers because inbound TCP
is usually unavailable. MVP DHT mode should use one of:

- DHT client mode plus stable operator bootstrap/indexer nodes.
- WebSocket-capable bootstrap nodes.
- Circuit relay through stable relays.

Do not assume `/ip4/0.0.0.0/tcp/4001` on a GitHub runner is publicly dialable.

## 9. Worker Coordinator Protocol

The Worker remains the stock-Hiddify bridge. Preserve existing routes:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | Bearer | Legacy full proxy registration |
| POST | `/heartbeat` | Bearer | Refresh TTL |
| GET | `/sub/all` | None or optional token | Hiddify subscription |
| GET | `/sub/{id}` | None or optional token | Single proxy subscription |
| GET | `/proxies` | None | Public sanitized proxy list |
| DELETE | `/delete/{id}` | Bearer | Remove proxy |
| GET | `/health` | None | Health check |

Add V3 routes:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/mesh/register` | Bearer | Register signed public record |
| POST | `/mesh/heartbeat` | Bearer | Refresh public record heartbeat |
| POST | `/mesh/deregister` | Bearer | Mark node as stopped |
| GET | `/mesh/status` | None | Mesh health summary |
| GET | `/bootstrap/peers` | None | Stable bootstrap multiaddrs |
| GET | `/mesh/snapshot` | Optional | Signed public snapshot JSON |

### `/mesh/register` Request

```json
{
  "record": {
    "schema": "animamesh.proxy.v1",
    "networkId": "animamesh-main",
    "nodeId": "node-sha256",
    "protocol": "hysteria2",
    "ingress": "cloudflared_quick",
    "endpoint": {
      "host": "abc.trycloudflare.com",
      "port": 443,
      "sni": "abc.trycloudflare.com",
      "security": "tls"
    },
    "lifecycle": {
      "createdAt": "2026-06-24T12:00:00.000Z",
      "expiresAt": "2026-06-24T12:45:00.000Z",
      "heartbeatAt": "2026-06-24T12:00:00.000Z",
      "ttlSeconds": 2700
    },
    "publicKeyId": "kid-2026-06",
    "signature": "base64-ed25519"
  }
}
```

Worker validation:

- Bearer token is valid.
- Record schema is supported.
- `networkId` matches configured network if Worker is network-scoped.
- Signature verifies against configured public key.
- `expiresAt` is in the future and not too far in the future.
- `ttlSeconds` is within allowed range, default 15-60 minutes.
- Endpoint host is a valid hostname and not a private IP literal.
- Protocol is supported.

Worker storage:

```text
proxy:{nodeId} -> WorkerProxyConfig
mesh:{networkId}:{nodeId} -> PublicProxyRecord
```

KV expiration should match `expiresAt`, with a small grace buffer.

## 10. Subscription Generation

### Secret Material

For private meshes, the Worker generates subscription links by combining:

- public endpoint metadata from `PublicProxyRecord`.
- secrets from Worker env/KV.

Required Worker secrets:

```text
AUTH_TOKEN
NETWORK_ID
VLESS_UUID
HY2_PASSWORD
MESH_PUBLIC_KEYS
```

GitHub Actions runners need matching proxy secrets:

```text
VLESS_UUID
HY2_PASSWORD
MESH_SIGNING_PRIVATE_KEY
MESH_PUBLIC_KEY_ID
NETWORK_ID
AUTH_TOKEN
COORDINATOR_URL
```

### Hysteria2 Link

```text
hysteria2://{HY2_PASSWORD}@{host}:{port}?sni={sni}&insecure=1#{name}
```

Example:

```text
hysteria2://secret@example.trycloudflare.com:443?sni=example.trycloudflare.com&insecure=1#animamesh-hy2-12ab
```

### VLESS WS Link

```text
vless://{VLESS_UUID}@{host}:{port}?encryption=none&security=tls&sni={sni}&type=ws&path=%2Fws#{name}
```

Example:

```text
vless://f47ac10b-58cc-4372-a567-0e02b2c3d479@abc.trycloudflare.com:443?encryption=none&security=tls&sni=abc.trycloudflare.com&type=ws&path=%2Fws#animamesh-vless-12ab
```

### Output Encoding

Keep current behavior unless intentionally changed by tests:

- `GET /sub/all` returns newline-separated URI lines.
- If base64 subscription output is added, expose it as `/sub/all?format=base64`
  or `/sub/base64`, not as a breaking replacement.

## 11. GitHub Actions Runner Lifecycle

### Workflow Inputs

```yaml
workflow_dispatch:
  inputs:
    protocol:
      type: choice
      options: [vless, hysteria2]
    ingress:
      type: choice
      options: [cloudflared_quick, ngrok]
```

### Required Job Permissions

```yaml
permissions:
  contents: read
  actions: write   # only if workflow_dispatch respawn is enabled
```

Avoid write permissions unless respawn is explicitly implemented.

### Lifecycle

1. Validate secrets are present.
2. Pick TTL with jitter, capped by workflow timeout.
3. Start protocol server using shared secret material.
4. Start public ingress.
5. Build and sign `PublicProxyRecord`.
6. `POST /mesh/register` to Worker if `COORDINATOR_URL` exists.
7. Start DHT announcer best-effort if the `node/` package is available.
8. Heartbeat every 60-120 seconds with jitter.
9. On shutdown, call `/mesh/deregister` best-effort.

### Respawn

MVP should not use empty commits. Preferred respawn:

- A trusted scheduled workflow maintains target runner count.
- Optional manual `scripts/proxy-up.sh` starts new nodes.
- Later, a runner may call GitHub Actions `workflow_dispatch` through the API
  if a bounded concurrency and max-run guard is implemented.

Required guards before autonomous respawn:

- `concurrency.group: animamesh-${protocol}`.
- Max active runs query before dispatch.
- Minimum respawn interval.
- Hard workflow timeout below GitHub limit.

## 12. Dashboard and CLI Behavior

### Dashboard

Add mesh fields without exposing secrets:

- active nodes.
- protocol breakdown.
- expires in.
- ingress type.
- endpoint host.
- registration path: Worker, DHT, or both.
- last heartbeat.

Do not display `VLESS_UUID`, `HY2_PASSWORD`, `AUTH_TOKEN`, or signing keys.

### CLI

Existing scripts remain valid:

- `scripts/proxy-up.sh --protocol hysteria2`
- `scripts/proxy-status.sh`
- `scripts/proxy-down.sh`

Add later:

```text
scripts/mesh-status.sh
scripts/mesh-snapshot.sh
```

Both should consume Worker JSON first. A DHT-only status mode can be added after
the `node/` package exists.

## 13. Optional IPFS/IPNS Mirror

IPFS is a mirror/cache, not the primary control plane.

### What to Publish

Publish `SignedSnapshot`, containing only `PublicProxyRecord[]`.

```text
ipfs add snapshot.json -> CID
ipns publish CID -> /ipns/{mesh-key}
```

### What Not to Publish

Do not publish private Hiddify links for a private mesh:

```text
vless://UUID@host...
hysteria2://PASSWORD@host...
```

Those links reveal mesh access. A CID or IPNS name is not an access-control
mechanism.

### Stock Hiddify Limitation

Stock Hiddify can consume HTTP subscription URLs, not encrypted IPFS metadata.
Therefore a private IPFS-only subscription is incompatible with stock Hiddify
unless the operator accepts public mesh credentials.

Practical options:

1. Private mesh: use Worker `/sub/all`; IPFS mirrors public metadata only.
2. Public research mesh: publish full subscription to IPFS intentionally.
3. Future custom client: fetch IPFS snapshot and combine with local secrets.

## 14. Failure Modes and Degraded Operation

| Failure | Expected Behavior |
|---|---|
| Worker offline | Existing Hiddify subscriptions cannot refresh; DHT-aware resolver may still work. |
| DHT unavailable | Worker registration and `/sub/all` still work. |
| Ingress URL disappears | Heartbeat health should fail or TTL expires naturally. |
| Runner exits without deregister | KV expiry and `expiresAt` remove it. |
| Bad signature | Worker and indexers reject the record. |
| Old replayed record | Reject if `expiresAt` expired or heartbeat regresses. |
| Secret mismatch | Subscription links exist but clients cannot connect; health checks should catch it. |
| External fork PR | No secrets are available; workflow must not start a real node. |

## 15. Implementation Plan

### Phase 1: Safe Worker Compatibility

Files:

- `worker/src/index.ts`
- `worker/src/index.test.ts`
- `.github/workflows/proxy.yml`
- `docs/SPEC-V3-ANIMAMESH-BACKEND.md`

Work:

1. Add `PublicProxyRecord` validation helpers in Worker.
2. Add `/mesh/register`, `/mesh/heartbeat`, `/mesh/deregister`,
   `/mesh/status`, `/mesh/snapshot`, and `/bootstrap/peers`.
3. Keep old `/register` and `/heartbeat`.
4. Generate subscription links from Worker env secrets when public records do not
   carry legacy `uuid` or `password`.
5. Update workflow to send both legacy registration and V3 public registration
   during migration.

### Phase 2: Runner Signing

Files:

- `.github/workflows/proxy.yml`
- `scripts/`
- new helper script under `tools/` or `node/`

Work:

1. Generate canonical public record JSON.
2. Sign with `MESH_SIGNING_PRIVATE_KEY`.
3. Register with Worker.
4. Add tests for canonical JSON and signature verification.

### Phase 3: `node/` Package

Files to create:

```text
node/package.json
node/tsconfig.json
node/src/index.ts
node/src/types.ts
node/src/record.ts
node/src/signing.ts
node/src/dht.ts
node/src/announce.ts
node/src/discover.ts
```

Responsibilities:

- Sign and verify records.
- Start libp2p in DHT client mode by default.
- Provide rendezvous content keys.
- Serve `/animamesh/proxy-record/1.0.0`.
- Discover providers and fetch signed records.
- Output sanitized records or Hiddify links only when local secrets are present.

### Phase 4: Optional DHT Indexer

Create a separately deployable process, not a Worker:

```text
node/src/indexer.ts
```

Responsibilities:

- Maintain stable libp2p connectivity.
- Discover DHT provider records.
- Verify signatures.
- Mirror valid public records to Worker `/mesh/register` or an operator DB.
- Publish signed snapshots to IPFS/IPNS if configured.

### Phase 5: IPFS Mirror

Files:

```text
node/src/ipfs.ts
node/src/snapshot.ts
```

Responsibilities:

- Create `SignedSnapshot`.
- Publish to a configured IPFS node.
- Optionally publish IPNS.
- Never include protocol secrets unless `PUBLIC_MESH=true`.

## 16. File-by-File Changes

### `worker/src/index.ts`

Add:

- `PublicProxyRecord` type.
- `verifyPublicRecord(record, env)`.
- `sanitizePublicRecord(record)`.
- `deriveProxyConfigFromRecord(record, env)`.
- route handlers for V3 mesh endpoints.

Preserve:

- legacy `ProxyConfig`.
- current subscription URL generation behavior.
- current CORS behavior.

### `worker/src/index.test.ts`

Add tests:

- rejects unsigned `/mesh/register`.
- rejects expired record.
- rejects wrong `networkId`.
- rejects invalid endpoint host.
- accepts valid signed record.
- `/sub/all` can render env-derived VLESS and Hy2 links.
- `/proxies` and `/mesh/status` do not expose secrets.

### `.github/workflows/proxy.yml`

Add:

- shared secret mode for `VLESS_UUID` and `HY2_PASSWORD`.
- signed public record generation.
- V3 registration call.
- heartbeat jitter.

Keep:

- legacy registration until Worker tests prove the V3 path.
- manual `workflow_dispatch`.
- no secret-bearing `pull_request`.

### `scripts/proxy-status.sh`

Add optional display of:

- `/mesh/status`.
- active node count.
- protocol breakdown.

### `docs/SPEC-V2-MESH.md`

Do not rewrite immediately. Add a short note later pointing readers to this V3
spec for corrected DHT and secret-handling rules.

## 17. Testing Plan

### Unit Tests

Worker:

- route authorization.
- public record validation.
- subscription generation with env secrets.
- TTL expiration.
- secret redaction.

Node package:

- canonical JSON stability.
- Ed25519 sign/verify.
- rendezvous key derivation.
- record expiry and dedupe.

### Integration Tests

- Run Worker dev server.
- POST a valid signed record.
- Fetch `/sub/all`.
- Confirm Hiddify URI line is generated.
- Advance expiry and confirm the node disappears.

### Workflow Smoke

- Manual `workflow_dispatch` on a trusted branch.
- Confirm proxy starts.
- Confirm Worker registration.
- Confirm subscription imports in stock Hiddify.
- Confirm logs do not print secrets.

## 18. Open Questions

- Should private mesh subscriptions require a token on `GET /sub/all`?
- Should each protocol use one shared org secret or per-run secrets stored only
  in Worker KV?
- Which stable bootstrap/indexer nodes will exist for DHT mode?
- Should the first DHT implementation use libp2p circuit relay or only support
  stable indexer discovery?
- Should IPFS full subscription publishing be allowed behind an explicit
  `PUBLIC_MESH=true` flag?
- Should Worker storage move from KV to Durable Objects if concurrent updates
  become important?

## 19. MVP Acceptance Criteria

- A trusted workflow run can start a VLESS or Hy2 proxy.
- The runner registers a signed public record with the Worker.
- Worker verifies the record and stores it with TTL.
- `GET /sub/all` returns stock Hiddify-compatible links.
- `GET /proxies` and `/mesh/status` expose no secrets.
- Expired runners disappear automatically.
- DHT work is optional and cannot break Worker compatibility.
- No raw protocol secrets appear in DHT/IPFS public metadata.
