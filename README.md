# 🌀 Animamesh

> **Direct P2P proxy from your PC to GitHub Actions runners. No CDN. No middleman. Pure n2n.**

Ephemeral proxy nodes running inside GitHub Actions, connected to your machine via a Layer 2 P2P VPN overlay. The coordinator is just a rendezvous — once you're on the n2n mesh, your traffic flows **directly** between peers. No Cloudflare. No ngrok. No VPS required.

Pure science experiment. Not a production service. 🧪

---

## 🧬 The Big Idea

GitHub Actions runners have **unrestricted outbound internet** but block all inbound traffic. You can't connect *to* a runner. But the runner can dial *out* to a supernode — and so can you.

**n2n** turns this asymmetry into a direct tunnel:

```
  Your PC                        Supernode                     GHA Runner
  ───────                       ─────────                     ─────────
  edge -c net -k key -a 10.0.0.2 ──► supernode.ntop.org:7777 ◄── edge -c net -k key -a 10.0.0.1
       │                              (forwards peer coords)        │
       ◄─────────── direct UDP hole-punched P2P link ──────────────►
       │                                                              │
  Hysteria2 client                                             Hysteria2 server
  (SOCKS5 on 127.0.0.1:1080)                                (bound to 10.0.0.1:PORT)
```

The supernode is **never in the data path** — it just introduces peers so they can punch through NAT. Once both edges connect, they talk directly. Your proxy traffic never touches any relay, CDN, or coordinator.

---

## 🏗️ Architecture

```
                          ┌──────────────────────┐
                          │  Cloudflare Worker    │
                          │  (coordinator)        │
                          │                       │
                          │  Public endpoints:    │
                          │    GET /mesh/n2n-config  → {community, supernode}
                          │    POST /mesh/n2n-join   → {community, key, supernode}
                          │    GET /sub/all          → proxy subscription
                          │    GET /health           → status
                          └──────┬───────────────┘
                                 │ HTTPS (control plane only)
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌──────────────┐         ┌──────────────────┐
           │  GHA Runner  │         │  Your Linux PC   │
           │  10.10.10.1  │◄───────►│  10.10.10.X      │
           │  Hysteria2   │  n2n   │  Hysteria2 client │
           │  (server)    │  P2P   │  (SOCKS5 proxy)   │
           └──────────────┘         └──────────────────┘
                    ▲                     ▲
                    └───── Direct ────────┘
                      (no middleman!)
```

### The two-layer trust model

| Layer | What it does | Credential | Who distributes it |
|---|---|---|---|
| **n2n overlay** | VPN mesh — L2 adjacency, direct P2P reachability | Community name + encryption key (`-c` / `-k`) | Worker (`/mesh/n2n-join`, auth-gated) |
| **Hysteria2 proxy** | Application-level SOCKS5 tunnel, QUIC+TLS encrypted | Random per-run password | Worker (`/sub/all`, inside the subscription URL) |

**Why two passwords?** The n2n key gets you on the network — like WiFi WPA2. The Hysteria2 password lets you use the proxy — like your router admin password. Even if someone else joins the same n2n community, they can't use your proxy without the per-run Hysteria2 password. Two factors: network access + application auth.

See [SPEC-V3 §6 Data Models](docs/SPEC-V3-ANIMAMESH-BACKEND.md) for the full `PublicProxyRecord` and `SignedSnapshot` schemas, and [SPEC-V3 §10 Subscription Generation](docs/SPEC-V3-ANIMAMESH-BACKEND.md) for how credentials flow into subscription links.

### The Worker is NOT in the data path

The Cloudflare Worker serves two roles, both **control plane only**:

1. **n2n coordinator** — distributes community name, encryption key, and supernode address so you can join the mesh
2. **subscription server** — lists active proxy endpoints (host, port, protocol credentials) so your client knows where to connect

Neither role touches proxy traffic. The Worker never sees a single byte of your browsing.

---

## 🚀 Quick Start

### What you need

- A GitHub account (free tier works)
- A Linux machine (Debian/Ubuntu, Arch, or Fedora)
- `sudo` on your machine (n2n creates a TUN interface)
- 5 minutes

### Step 1: Fork & add secrets

1. Fork this repository
2. Go to **Settings → Secrets and variables → Actions**
3. Add these secrets:

| Secret | What it is | Example |
|---|---|---|
| `COORDINATOR_URL` | Your Worker URL (after deploying in Step 2) | `https://animamesh.you.workers.dev` |
| `AUTH_TOKEN` | Shared secret for Worker auth | `my-secret-token-123` |
| `N2N_COMMUNITY` | n2n community name — pick something unique | `animamesh-net-2026` |
| `N2N_KEY` | n2n encryption key — strong password | `MyStr0ngP2PEncrypt10n!` |
| `NETWORK_ID` | Mesh network identifier | `my-mesh` |

### Step 2: Deploy the coordinator

```bash
git clone https://github.com/YOURUSERNAME/animamesh.git
cd animamesh/backend
npm install

# Deploy the Cloudflare Worker
cd worker
npm install
npx wrangler login
npx wrangler deploy
# → Save the URL (e.g. https://animamesh.you.workers.dev)

# Set n2n secrets on the Worker
npx wrangler secret put N2N_COMMUNITY   # enter your community name
npx wrangler secret put N2N_KEY          # enter your encryption key
```

### Step 3: Launch a proxy runner

```bash
# Trigger a GitHub Actions runner with n2n tunnel + Hysteria2
./scripts/proxy-up.sh --protocol hysteria2

# Or manually: Actions → BPB Action Proxy → Run workflow
#   Protocol: hysteria2
#   Tunnel:   n2n
```

The runner will:
1. Start n2n edge → join the overlay VPN as `10.10.10.1`
2. Start Hysteria2 server bound to `10.10.10.1:PORT`
3. Register itself with the Worker coordinator
4. Heartbeat every 5 minutes until the 45-minute timeout

### Step 4: Connect from your PC

```bash
# One command — that's it
./scripts/animamesh-connect.sh \
  --coordinator https://animamesh.you.workers.dev \
  --auth-token my-secret-token-123
```

This will:
1. Install `n2n` if missing
2. Fetch n2n credentials from the Worker (auth-gated)
3. Join the n2n P2P overlay as `10.10.10.X`
4. Discover active Hysteria2 proxies from the Worker subscription
5. Start Hysteria2 SOCKS5 tunnel on `127.0.0.1:1080`

### Step 5: Use the proxy

```bash
curl --socks5 127.0.0.1:1080 https://ifconfig.me

# Or set environment variables
export http_proxy=socks5://127.0.0.1:1080
export https_proxy=socks5://127.0.0.1:1080
```

Press **Ctrl+C** to gracefully disconnect — stops Hysteria2 and n2n edge.

---

## 🔌 Connection Modes

Animamesh supports multiple tunnel types, from purely direct to CDN-backed:

| Tunnel | Data path | NAT traversal | Latency | Setup |
|---|---|---|---|---|
| **n2n** 🌟 | Direct P2P (UDP hole-punched) | Supernode-assisted | Low | Set 2 secrets |
| **bore** | bore.pub relay | Public relay | Medium | Just works |
| **trycloudflare** | Cloudflare CDN | CF tunnel | Higher | Just works |
| **direct** | Raw STUN punch | STUN server | Lowest | Fragile, often blocked |

**n2n is the primary mode** — direct, encrypted, no third-party in the data path. The other modes are fallbacks for when supernodes are unreachable or you need CDN compatibility (e.g. for Hiddify/v2ray clients).

### When to use what

- **n2n** — Default. Direct P2P, L2 adjacency, encrypted overlay. Works everywhere outbound UDP is allowed.
- **bore** — Quick test, no secrets needed. Relay adds latency but is reliable.
- **trycloudflare** — Need a public HTTPS endpoint (e.g. VLESS+WS for Hiddify)? CF tunnel gives you one. Traffic flows through Cloudflare's CDN.
- **direct** — Raw STUN-based NAT punching. Low latency but fragile — many networks block it.

---

## 📂 Project Structure

```
backend/
├── node/                  # libp2p DHT mesh node (optional DHT discovery)
│   ├── src/
│   │   ├── dht.ts         # Kademlia DHT node lifecycle
│   │   ├── announce.ts    # DHT provider publish + record server
│   │   ├── discover.ts    # DHT discovery + record fetch + verify
│   │   ├── signing.ts     # Ed25519 signing/verification
│   │   ├── record.ts      # PublicProxyRecord creation + validation
│   │   ├── types.ts       # Data model types
│   │   ├── index.ts       # Entry point
│   │   └── indexer.ts     # Standalone DHT indexer process
│   └── package.json
│
├── worker/                # Cloudflare Worker coordinator
│   ├── src/
│   │   └── index.ts       # register, heartbeat, sub/all, mesh/*, n2n endpoints
│   ├── wrangler.toml
│   └── package.json
│
├── src/                   # Dashboard panel (Express + Socket.IO)
│   ├── assets/panel/      # Web dashboard UI
│   ├── server.ts
│   └── index.ts
│
├── scripts/
│   ├── animamesh-connect.sh   # 1-click n2n P2P client (Linux)
│   ├── proxy-up.sh            # Trigger a proxy runner
│   ├── proxy-down.sh          # Remove active proxies
│   ├── proxy-status.sh        # Check proxy health
│   └── stun_punch.py          # STUN-based direct NAT traversal
│
├── .github/
│   └── workflows/
│       ├── proxy.yml          # GHA runner: n2n/bore/cloudflared/direct tunnel
│       └── panel.yml          # Dashboard CI/CD
│
├── docs/
│   ├── SPEC-V3-ANIMAMESH-BACKEND.md  # V3 backend spec (n2n, signing, mesh)
│   ├── SPEC-V2-MESH.md                # Original DHT mesh spec + consillium decisions
│   └── ANIMAMESH-CLIENT.md            # Linux client documentation
│   # → See 📚 Specification Index below for section-level references
│
└── README.md               # You are here
```

---

## 🔑 Coordinator API

The Worker exposes these endpoints. The n2n-specific ones are the heart of the P2P architecture.
Full request/response schemas: [SPEC-V3 §9 Worker Coordinator Protocol](docs/SPEC-V3-ANIMAMESH-BACKEND.md).

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/mesh/n2n-config` | GET | None | Public: community name + supernode (no key) |
| `/mesh/n2n-join` | POST | Bearer | Full n2n config: community + key + supernode |
| `/mesh/register` | POST | Bearer | Runner registers signed proxy record |
| `/mesh/heartbeat` | POST | Bearer | Runner refreshes TTL |
| `/mesh/deregister` | POST | Bearer | Runner removes its record |
| `/mesh/status` | GET | None | Active mesh nodes (JSON) |
| `/mesh/snapshot` | GET | None | Signed snapshot of all records |
| `/sub/all` | GET | None | Hiddify-compatible subscription (all proxies) |
| `/sub/{id}` | GET | None | Single proxy subscription |
| `/proxies` | GET | None | JSON proxy list |
| `/register` | POST | Bearer | Legacy v1 registration |
| `/heartbeat` | POST | Bearer | Legacy v1 heartbeat |
| `/delete/{id}` | DELETE | Bearer | Remove proxy record |
| `/health` | GET | None | Service health check |

---

## 🛡️ Threat Model

| Threat | Mitigation |
|---|---|
| **Coordinator compromise** | Coordinator is control-plane only. No proxy traffic flows through it. Signed records (Ed25519) prevent metadata tampering. See [SPEC-V3 §5 Trust Model](docs/SPEC-V3-ANIMAMESH-BACKEND.md) and [SPEC-V2 §6 Threat Model](docs/SPEC-V2-MESH.md). |
| **n2n key leak** | Anyone with the key can join the overlay — but they still need per-run Hysteria2 passwords to use proxies (from `/sub/all`). Two-factor: network access + app auth. |
| **Supernode MITM** | n2n encrypts peer-to-peer traffic with AES using the community key. The supernode only sees encrypted UDP packets and peer coordinates — never plaintext. |
| **Other n2n peers** | Hysteria2 password is per-run, random. Even other peers on the same overlay can't use your proxy. |
| **Runner dies** | Ephemeral by design. 45-minute TTL. No persistent state. Trigger a new one with `proxy-up.sh`. |
| **Sybil attack** | Network-ID = shared secret. Coordinator auth-gates registration. DHT records signed with Ed25519. See [SPEC-V2 §8 Q7 Defection](docs/SPEC-V2-MESH.md). |
| **Ghost nodes** | Short TTL, heartbeat every 5 minutes, tombstones on deregister. |

---

## ❓ FAQ

**Is this free?**
Yes. GitHub Actions free tier gives 2,000 minutes/month. Each runner uses ~45 min. The mesh draws 1-3 nodes at a time. You can run for many hours before hitting limits.

**Do I need a VPS?**
No. That's the whole point. n2n uses public supernodes (free) to broker the initial connection. Once both peers are on the overlay, traffic flows directly between them.

**What if the supernode is down?**
Try an alternative. Set `N2N_SUPERNODE` secret or pass `--supernode` to `animamesh-connect.sh`:

| Supernode | Location |
|---|---|
| `supernode.ntop.org:7777` | Official ntop (default) |
| `vps.luckynet.info:7777` | Europe/CIS |
| `n2n.luckynet.info:7777` | Fallback |
| `supernode.lucaswilliams.co.uk:7777` | UK |

**Is traffic encrypted?**
Twice. n2n encrypts the wire between peers (AES with community key). Hysteria2 adds QUIC+TLS on top with its own password. Even if someone sniffs the supernode, they see encrypted UDP. Even if another n2n peer inspects traffic, they see QUIC ciphertext.

**Why two passwords?**
n2n key = join the WiFi. Hysteria2 password = use the proxy. Other peers on the same n2n community can ping you but can't proxy through you without the per-run password.

**Is this Tor?**
No. Tor is a production-grade multi-hop onion network with thousands of nodes and decades of security research. This is a weekend experiment that puts proxy nodes in GitHub Actions and connects to them via n2n. Philosophy-wise? Same neighborhood. Security-wise? Not even close.

**Can I use Hiddify instead of the Linux client?**
If you're using `trycloudflare` tunnel mode, yes — `GET /sub/all` returns standard v2ray subscription links. For n2n mode, you need to join the n2n overlay first (the Linux client does this automatically). Stock Hiddify doesn't speak n2n.

**Why Hysteria2 vs VLESS?**
Hysteria2: QUIC-based, fast on lossy networks, no TLS cert needed, works great over n2n.
VLESS: more widely supported, WebSocket transport works through CDNs.
Both are first-class. Hysteria2 is the recommended default for n2n mode.

**What about DHT?**
The libp2p DHT (`node/`) is an optional discovery layer. The Worker coordinator is the primary discovery path today. DHT adds resilience for when the Worker is down — but for most users, the Worker is perfectly fine. See [SPEC-V2 §3.1 DHT Discovery Layer](docs/SPEC-V2-MESH.md) and [SPEC-V3 §8 DHT Protocol](docs/SPEC-V3-ANIMAMESH-BACKEND.md) for the full architecture.

---

## 📚 Specification Index

All design documents, kept for research and architectural reference.

| Document | What it covers | When to read it |
|---|---|---|
| [`SPEC-V3-ANIMAMESH-BACKEND.md`](docs/SPEC-V3-ANIMAMESH-BACKEND.md) | **V3 implementation spec** — data models (`PublicProxyRecord`, `SignedSnapshot`), Ed25519 signing, Worker V3 mesh endpoints (`/mesh/register`, `/mesh/heartbeat`, `/mesh/snapshot`), DHT rendezvous protocol, subscription generation, runner lifecycle, IPFS mirroring, testing plan | Before modifying `worker/src/index.ts`, `node/src/`, or `proxy.yml` |
| [`SPEC-V2-MESH.md`](docs/SPEC-V2-MESH.md) | **Original mesh architecture** — DHT topology (Kademlia), lifecycle state machine (SPAWN → DEREGISTER → DIE), 7-AI consillium decisions (bootstrap cascade, multi-hop killed, proactive overspawn, tunnel provider cascade, reputation/PoW stake), threat model, implementation roadmap | For DHT design rationale, consillium voting records (§8), and historical context |
| [`ANIMAMESH-CLIENT.md`](docs/ANIMAMESH-CLIENT.md) | **Linux client docs** — `animamesh-connect.sh` usage, n2n join flow, proxy discovery, Hysteria2 SOCKS5 setup, troubleshooting, alternative supernodes | Before using or modifying `scripts/animamesh-connect.sh` |

### Key sections by topic

| Topic | SPEC-V3 | SPEC-V2 | Client doc |
|---|---|---|---|
| Data models & signing | §6 `PublicProxyRecord`, §7 signing model | — | — |
| Worker mesh API | §9 `/mesh/register`, `/mesh/heartbeat`, `/mesh/status`, `/mesh/snapshot` | — | — |
| n2n P2P overlay | (implemented, see proxy.yml + worker) | — | Architecture diagram, Step-by-step flow |
| DHT rendezvous keys | §8 `/bpb/v2/{net-id}/{protocol}/{peer-id}` | §3.1 DHT Discovery Layer, §8 Q1 bootstrap cascade | — |
| Subscription generation | §10 Hysteria2 link, VLESS WS link, secret material | — | How proxies are discovered from `/sub/all` |
| Runner lifecycle | §11 workflow inputs, TTL, respawn | §3.3 Ephemeral Lifecycle Manager | — |
| 6-AI consillium decisions | — | §8 voting matrix + per-question analysis | — |
| Threat model | §5 trust boundaries, untrusted actors | §6 full threat table | — |
| IPFS/IPNS mirroring | §13 optional, `SignedSnapshot` to IPFS | — | — |
| Implementation phases | §15 Phase 1–5, §16 file-by-file changes | §9 roadmap P0–P9 | — |
| Testing plan | §17 unit, integration, workflow smoke | — | — |

---

## 🤝 Contributing

Research project. Fork it, break it, improve it. PRs welcome.

See the [Specification Index](#-specification-index) above for all design documents.

---

## 📜 License

MIT — Because sharing is caring. 💙

---

**⚠️ Disclaimer:** This project is a pure science experiment in decentralized ephemeral proxy meshes. It is not affiliated with the original [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel). No production use is intended or supported. Use responsibly, in accordance with GitHub's Terms of Service, and in compliance with your local laws. The authors assume zero liability for what you do with this knowledge.
