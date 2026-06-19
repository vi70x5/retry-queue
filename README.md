# 🌀 BPB Action Mesh

> **Your own Tor. But with VLESS. And ephemeral nodes. Running on GitHub Actions.**

A decentralized mesh of ephemeral proxy nodes — powered by libp2p DHT discovery, VLESS/Hysteria2 transport, and the sheer audacity of using CI infrastructure as a proxy network. Pure science. No production use. Just vibes and distributed systems. 🧪

---

## 🧬 The Big Idea

GitHub Actions runners become ephemeral proxy nodes. They discover each other via a Kademlia DHT (like BitTorrent finds peers). Actual proxy traffic flows directly over VLESS/Hysteria2 — the DHT is **only** for discovery, never in the data path. Nodes live 15-60 minutes (random TTL), die, and trigger fresh runners to replace them. The mesh self-heals.

**The BitTorrent Sync analogy** (because analogies are how we think):

```
Resilio Sync (formerly BitTorrent Sync):
  ┌──────────────────────┐        ┌──────────────────────┐
  │  DHT / bootstrap      │  find  │  Direct peer-to-peer │
  │  servers               │──►──► │  file transfer        │
  │  (discovery only)      │  peers │  (the actual data)   │
  └──────────────────────┘        └──────────────────────┘

BPB Mesh v2:
  ┌──────────────────────┐        ┌──────────────────────┐
  │  libp2p Kademlia DHT │  find  │  Direct VLESS/Hy2     │
  │  (discovery only)    │──►──► │  proxy connections    │
  │  Coordinator = tracker│  nodes │  (the actual traffic) │
  └──────────────────────┘        └──────────────────────┘
```

You don't download files through the BitTorrent DHT. You don't proxy traffic through the BPB DHT. Same principle. DHT finds the nodes. VLESS carries the bytes.

---

## 😤 Why v2? (The v1 Problems)

v1 worked. Sort of. In the way that a single bridge works until it collapses.

```
v1 — Centralized. Fragile. Lonely.

  Client ──► CF Worker (coordinator) ──► single GHA runner ──► trycloudflare
                    │
                    │ if this dies...
                    │
                    ▼
              ☠️ EVERYTHING DIES ☠️
```

**What was wrong:**

| Problem | Why It Hurt |
|---|---|
| Coordinator = SPOF | If the CF Worker went down, all clients lost all connectivity |
| 1 runner at a time | No redundancy. One node. One life. One chance. |
| Manual respawn | Push to main or manually trigger. No self-healing. |
| CF Worker KV as sole discovery | Single database. Single point of truth. Single point of failure. |

v2 asks: *what if there were no center?*

---

## 🕸️ The v2 Architecture

```
                    ┌──────────────────────────────────────┐
                    │          DHT (Kademlia)               │
                    │                                        │
                    │  Node A ◄──► Node B ◄──► Node C       │
                    │  TTL: 37m      TTL: 52m      TTL: 23m  │
                    │                                        │
                    │  Keys: /bpb/v2/{net-id}/vless/{peer}   │
                    │  Values: { host, port, uuid, sni }     │
                    └───────┬────────────┬──────────────┬────┘
                            │            │              │
                            ▼            ▼              ▼
                       ┌─────────┐ ┌─────────┐  ┌─────────┐
                       │ VLESS   │ │ VLESS   │  │ Hy2     │
                       │ server  │ │ server  │  │ server  │
                       │ CF tun  │ │ CF tun  │  │ CF tun  │
                       └────┬────┘ └────┬────┘  └────┬────┘
                            │           │            │
                  client connects DIRECTLY via VLESS/Hy2
                  (no libp2p in the data path. ever.)

         ┌─────────────────────────────────────────────┐
         │         Coordinator (optional tracker)       │
         │  /bootstrap/peers  /sub/all  /mesh/status     │
         │  Helpful but NOT required for the mesh to run │
         └─────────────────────────────────────────────┘
```

**The three laws of v2:**

1. **libp2p for discovery ONLY.** Data path = VLESS/Hy2 directly. Period.
2. **Coordinator is optional.** It's a BitTorrent tracker — nice to have, not required.
3. **Ephemeral by design.** Nodes live minutes, not days. No persistent state. Identity is per-lifecycle.

---

## 🔄 The Lifecycle of a Node

Every node follows the same beautiful, tragic arc:

```
  SPAWN ──────► BOOTSTRAP ──────► ANNOUNCE ──────► SERVE ──────► PRE_DEATH ──────► DEREGISTER ──────► DIE
  (GHA           (join DHT,       (publish        (proxy        (TTL -5 min,       (tombstone in       (runner
  starts)        find peers)      config to       traffic       trigger respawn)    DHT, clean up)      exits)
                                 DHT)            flows)
                                                                      │
                                                                      ▼
                                                              RESPAWN
                                                              (git push /
                                                              workflow_dispatch
                                                              → new GHA run)
```

Each node draws a **random TTL from uniform(15, 60) minutes**. This jitter is the secret sauce — it prevents synchronized herd death. At any moment, some nodes are young, some are middle-aged, some are about to die. The mesh is always alive.

5 minutes before TTL expires, the node:
1. Triggers a respawn (GitHub API or git push)
2. Waits up to 2 minutes for the new node to bootstrap
3. Publishes a tombstone to the DHT
4. Dies gracefully

---

## 🎯 How Clients Connect

```
Mode 1: DHT-Native (no coordinator needed)
─────────────────────────────────────────
  Client (Hiddify) ──► DHT Resolver ──► DHT ──► proxy configs
                                                    │
  Client ──► VLESS/Hy2 connection directly to node ◄┘
  (libp2p is NOT in the data path)

Mode 2: Coordinator-Backed (backward compatible with v1)
──────────────────────────────
  Client ──► GET /sub/all on coordinator ──► coordinator queries DHT + its own KV
                                                    │
  Client ──► VLESS/Hy2 connection directly to node ◄┘
```

**Coordinator degradation — the mesh survives without it:**

| Coordinator | DHT | Result |
|---|---|---|
| ✅ Online | ✅ Active | Best of both — coordinator caches DHT results |
| ✅ Online | ❌ No peers | Coordinator falls back to its own KV (legacy v1 mode) |
| ❌ Offline | ✅ Active | Client resolves DHT directly — zero impact |
| ❌ Offline | ❌ No peers | Dead mesh. Needs manual intervention. |

---

## ⚡ Concurrency: Not Just One Node Anymore

v1 ran one lonely runner at a time. v2 spawns a **matrix** of 2-5 concurrent nodes:

```yaml
strategy:
  matrix:
    node-index: [0, 1, 2]  # 3 initial nodes
  fail-fast: false
```

Each matrix slot gets a slightly offset TTL base. When one node dies, it triggers exactly one replacement. Staggered TTLs guarantee at least 1-2 nodes are always alive.

```
  Timeline (minutes):  0    10    20    30    40    50    60
  ─────────────────────────────────────────────────────────
  Node A (TTL=37):     ██████████████████████████████░░░ RIP
  Node B (TTL=52):     ████████████████████████████████████████████░░░░░ RIP
  Node C (TTL=23):     ███████████████████████░░ RIP
  Node D (spawned):                     ████████████████████████████████░ RIP
  Node E (spawned):                                        █████████████ ...
  ─────────────────────────────────────────────────────────
  Active nodes:         3     3     3     3     3     2     2
```

---

## 🛡️ Threat Model (v1 vs v2)

| Threat | v1 | v2 |
|---|---|---|
| Coordinator DDoS | ☠️ Fatal | ✅ DHT resolves locally, coordinator optional |
| Coordinator compromised | ⚠️ MITM risk | ✅ DHT records signed (Ed25519), clients verify |
| Sybil attack (fake nodes) | N/A (centralized) | ✅ Network-ID = shared secret, peer verification |
| Single runner dies | ☠️ Total outage | ✅ Multiple concurrent nodes, DHT failover |
| Ghost nodes (dead but registered) | Common (KV TTL 24h) | ✅ Short re-announce (5min), tombstones, client verification |
| Node impersonation | N/A | ✅ DHT provider records bound to PeerId |

---

## 🧰 Technology Stack

| Component | Technology | Why |
|---|---|---|
| DHT discovery | `@libp2p/kad-dht` | Standard Kademlia, npm package, runs in GHA node |
| Peer identity | `@libp2p/peer-id` (Ed25519) | Crypto identity, DHT record signing |
| NAT traversal | cloudflared (existing) | No libp2p relay needed — CF tunnel solves NAT |
| Proxy traffic | sing-box (VLESS) + Hysteria2 | Unchanged from v1 — proven, efficient |
| Coordinator | Cloudflare Worker | Now with DHT bridge + optional tracker role |
| Respawn trigger | GitHub REST API | `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` |

**What runs inside each GHA runner:**

```
┌─────────────────────────────────────────┐
│           GHA Runner (ubuntu-latest)     │
│                                          │
│  ┌──────────┐  ┌──────────┐            │
│  │ libp2p   │  │ sing-box │            │
│  │ DHT node │  │ (VLESS)  │            │
│  │ :4001    │  │ :43124   │            │
│  └────┬─────┘  └────┬─────┘            │
│       │              │                   │
│       ▼              ▼                   │
│  ┌──────────────┐                       │
│  │ cloudflared  │ ──► trycloudflare.com │
│  │ tunnel       │     (public URL)      │
│  └──────────────┘                       │
│                                          │
│  ┌──────────────┐                       │
│  │ lifecycle.js │  TTL, respawn, death   │
│  └──────────────┘                       │
└─────────────────────────────────────────┘
```

---

## 📂 Project Structure

```
bpb-action/
├── node/                  # 🆓 libp2p DHT mesh node
│   ├── src/
│   │   ├── dht.ts         # Kademlia DHT node — discovery + config publication
│   │   ├── lifecycle.ts   # TTL, spawn/announce/die state machine
│   │   ├── respawn.ts     # GitHub API / git push triggers
│   │   └── bootstrap.ts   # Peer bootstrapping strategies
│   └── package.json
│
├── client/                # 🆓 Client-side DHT resolver
│   ├── src/
│   │   ├── resolver.ts    # DHT resolver → Hiddify subscription format
│   │   └── gateway.ts     # HTTP-to-DHT gateway (thin API for non-DHT clients)
│   └── package.json
│
├── worker/                # ☁️ Coordinator (now optional tracker)
│   ├── src/
│   │   └── index.ts       # CF Worker: /bootstrap/peers, /sub/all, /sub/dht, /mesh/status
│   ├── wrangler.toml
│   └── package.json
│
├── src/                   # 📊 Dashboard panel
│   ├── assets/panel/      # Web dashboard UI (dark mode, obviously)
│   ├── server.ts           # Express + Socket.IO backend
│   └── index.ts            # Entry point
│
├── .github/
│   └── workflows/
│       ├── mesh.yml        # 🆓 Multi-node matrix (2-5 concurrent runners)
│       └── panel.yml       # Dashboard CI/CD
│
├── docs/
│   ├── SPEC-V2-MESH.md    # Full architectural spec
│   └── BRAINSTORM-PROMPT.md # Consillium brainstorm prompt
│
└── README.md               # You are here 📍
```

---

## 🚀 Quick Start

> **Note:** v2 is still under construction. The quick start below covers what works today (v1-style) plus the DHT-enhanced path that's coming.

### Prerequisites

1. A GitHub account (free tier works!)
2. A Cloudflare account (free tier)
3. [Hiddify](https://hiddify.com/) or any v2ray-compatible client

### Step 1: Fork & Setup

1. Fork this repository
2. Go to **Settings → Secrets and variables → Actions**
3. Add the following secrets:

| Secret | Description | Example |
|---|---|---|
| `COORDINATOR_URL` | Your Cloudflare Worker URL | `https://bpb-coordinator.you.workers.dev` |
| `AUTH_TOKEN` | Shared secret for auth | `your-secret-token-123` |
| `NETWORK_ID` | 🆓 DHT mesh identifier | `my-mesh-42` |

### Step 2: Deploy the Coordinator

```bash
git clone https://github.com/YOURUSERNAME/bpb-action.git
cd bpb-action
npm install -g wrangler
wrangler login

cd worker
npm install
wrangler deploy
# Save the URL (e.g. https://bpb-coordinator.you.workers.dev)
```

### Step 3: Trigger the Mesh

Push to `main` — this spawns the matrix:

```bash
echo "mesh go brrr" >> README.md
git add -A && git commit -m "🚀 mesh trigger" && git push origin main
```

Or manually: **Actions → BPB Action Proxy → Run workflow** → select protocol → **Run workflow**.

**Or use the KISS launcher (no TG bot needed!):**

```bash
# One command to start proxy + wait for subscription URL
./scripts/proxy-up.sh --protocol hysteria2 --coordinator https://bpb-coordinator.you.workers.dev

# Check status
./scripts/proxy-status.sh --coordinator https://bpb-coordinator.you.workers.dev

# Kill active proxies
./scripts/proxy-down.sh
```

The scripts use `gh` (GitHub CLI) — install with `brew install gh` or see [cli.github.com](https://cli.github.com/).

### Step 4: Get Your Subscription

After ~2 minutes, grab your subscription URL:

```
📋 Coordinator subscription:
   https://bpb-coordinator.you.workers.dev/sub/all

🆓 DHT-native subscription (coming soon):
   bpb-resolver resolve --network my-mesh-42 --format hiddify
```

### Step 5: Import into Hiddify

1. Open **Hiddify** → **Subscriptions → Add**
2. Paste the subscription URL
3. Click **Update**
4. Connect! 🌐

---

## 🗺️ Implementation Roadmap (Post-Consillium)

| Phase | Deliverable | Effort | Risk |
|---|---|---|---|
| **P0** | Node runs libp2p DHT, announces proxy config | 2-3 days | Low |
| **P1** | TTL-based lifecycle with git-push respawn | 1-2 days | Low |
| **P2** | Coordinator gains DHT bridge (`/bootstrap/peers`, `/sub/dht`) | 1 day | Low |
| **P3** | HTTP-to-DHT gateway (thin binary or CF Worker) | 2-3 days | Medium |
| **P4** | Multi-node matrix + proactive overspawn | 1-2 days | Low |
| **P5** | Tombstone + mesh self-healing + health metrics in DHT | 1-2 days | Medium |
| **P6** | Parallel multiplexed tunnels (NOT serial multi-hop) | 3-5 days | High |
| **P7** | Tunnel provider abstraction layer | 1-2 days | Low |
| **P8** | DNS TXT + Gist + GossipSub bootstrap cascade | 2-3 days | Medium |
| **P9** | Reputation system + PoW stake + random probes + 举报 incentives | 3-5 days | High |

---

## ✅ Consillium Decisions (6 AIs: ChatGPT × Sonnet 4.5 × Gemini Pro × DeepSeek × Kimi 2.6 × GLM 5.1)

Six AIs reviewed the spec and voted. Here's what they decided:

| Q | ChatGPT | Sonnet 4.5 | Gemini Pro | DeepSeek | Kimi 2.6 | GLM 5.1 | **Decision** |
|---|---|---|---|---|---|---|---|
| Q1 Bootstrap | coord+bootstrap | gossipsub+git | DNS TXT | DNS+户籍 | gossipsub+git | **DNS+墓碑** | **Layered cascade** |
| Q2 Client DHT | HTTP gateway | HTTP gateway | IPNS | B+特色 | **B+role** | **B+驿站** | **HTTP-to-DHT gateway** |
| Q3 Multi-hop | design now | design now | skip | B+留白 | **parallel** | **KILL IT** | **Dead. No serial multi-hop.** |
| Q4 Respawn | overspawn | overspawn | accept gap | C+禅让 | **C+litters** | **C+父死子继** | **Proactive overspawn** |
| Q5 Network ID | invite codes | secrets+invites | repo secrets | A+C+差序格局 | **C+delegable** | **门派制** | **Secrets + invites** |
| Q6 Tunnel | multi-provider | multi+relay | multi-provider | B+农村 | **E=destiny** | **B+暗网潜行** | **Multi-provider + relay hatch** |
| **Q7 Defection** | — | — | — | 仓颉审计 | — | **锦+推恩** | **Reputation + PoW + 举报** |

**Q1: DHT Bootstrap → Layered Cascade 🐔🥚**
All three picked different primaries. Synthesis: try everything in order — DNS TXT → coordinator → GossipSub → git-persisted peers → public bootstrap nodes → hardcoded seeds. *Gemini's insight: "DNS is the most resilient, globally cached read-only database in existence. Bitcoin, Tor, and IPFS all use it as ultimate fallback."*

**Q2: Client-Side DHT → HTTP-to-DHT Gateway 🪶**
Thin Go/Rust binary that embeds libp2p, exposes `GET /resolve/{net-id}` → Hiddify JSON. Client apps stay dumb. *Sonnet's bonus: any mesh node can act as DHT proxy via JSON-RPC.*

**Q3: Multi-Hop Relay → KILLED BY CONSIILLUM ☠️🔗**
Serial multi-hop is architecturally wrong for ephemeral environments. MTBF of a 3-hop circuit with 15-60min nodes is *minutes*. GLM 5.1 says: "remove `route: []` from schema entirely — it's code debt violating YAGNI." Gemini + Kimi agree. Instead: **parallel multiplexing**. Client opens 3 single-hop tunnels — one "主轨" (primary), two "暗轨" (dark tracks, heartbeat only, zero-latency switchover). Like high-speed rail's redundant power grid. Serial multi-hop belongs to Tor. Not here.

**Q4: Respawn Race → Proactive Overspawn ⏱️**
Maintain N+1 nodes. When a node hits 50% TTL, spawn replacement. Kubernetes thinking. *Concession to Gemini: if overspawn fails (API rate limits), the mesh degrades gracefully to "accept the gap" mode.*

**Q5: Network Identity → Repo Secrets + Optional Invites 🏷️**
Default: network-id in repo secrets (one darknet per fork). Optional: coordinator issues time-limited invitation codes for "join my mesh." *Gemini's warning: "A public mesh will immediately attract abuse, becoming a target for GitHub's Trust & Safety bans."*

**Q6: Tunnel SPOF → Multi-Provider + Relay Escape Hatch ⛓️**
Tunnel cascade: trycloudflare → bore.pub → localhost.run → ngrok → VPS relay → libp2p circuit relay. Abstract behind `TunnelProvider` interface. *Gemini's wildcard: Tor Onion Services as a tunnel provider — absolute anonymity, zero corporate dependency.*

**Q7: Node Defection → Reputation + PoW Stake 🐉** *(DeepSeek's new question — the other three missed it)*
What stops a node from going rogue? Fake configs, traffic logging, Sybil flood. DeepSeek's answer: 仓颉审计 (Cangjie Audit) — trust is earned, not given. Zero trust on spawn. Track uptime + performance. Nodes vouch for each other (连坐制 — collective accountability). Probe traffic catches loggers. PoW stake at join time makes Sybil expensive. Sponsor vouching: if your sponsored node defects, you lose reputation too. *DeepSeek: "制度大于人心 — systems over sentiment. Make punishment certain, not severe."

**Key cross-cutting principles from consillium:**
- *"Do not optimize for no coordinator. Optimize for coordinator compromise is survivable."* — ChatGPT
- *"Ephemeral infrastructure as highly hostile territory. This is a continuous rolling blackout."* — Gemini
- *"Control plane / data plane separation is sacred."* — Unanimous
- *"阴阳平衡 — yin-yang balance between centralized structure and decentralized resilience."* — DeepSeek
- *"制度大于人心 — systems over sentiment."* — DeepSeek
- *"Immortal liquidity through constant death."* — Kimi 2.6
- *"Client fault-tolerance is 70% of viability. Architecture is 30%."* — GLM 5.1
- *"Serial multi-hop is dead. Killed by this consillium."* — GLM 5.1 + Gemini + Kimi 2.6

Full details in `docs/SPEC-V2-MESH.md` §8.

---

## ⚖️ Constraints & Principles

1. **🧪 Pure science.** This is a research experiment in decentralized ephemeral proxy meshes. No production. No users. No liability.
2. **🔍 libp2p for discovery ONLY.** Data path = VLESS/Hy2 directly. Never route traffic through libp2p. Non-negotiable. *(Unanimous consillium agreement.)*
3. **📡 Coordinator is optional.** The mesh must work without it. It's a BitTorrent tracker, not a server. *(ChatGPT: "Optimize for coordinator compromise is survivable, not for no coordinator.")*
4. **⏳ Ephemeral by design.** Nodes live minutes, not days. No persistent state. Identity is per-lifecycle. *(Gemini: "Treat this as highly hostile territory — a continuous rolling blackout.")*
5. **🔙 Backward compatible.** v1 clients (using `/sub/all` on coordinator) must keep working. No breaking upgrades.
6. **📦 Minimal dependencies.** Prefer npm packages over custom protocols. Prefer standard libp2p protocols over ad-hoc messaging. Don't reinvent wheels.
7. **🔀 Stagger, don't sync.** Random TTLs. Jittered announces. No herd behavior. Entropy is our friend.
8. **🪜 Layered resilience.** Every critical function (bootstrap, tunnel, discovery) has a cascade of fallbacks. No single mechanism is trusted alone.
9. **❤️ Health over liveness.** DHT records carry health scores. Clients pick best nodes, not just any node.
10. **⚡ Parallel beats serial.** Client-side multiplexing > serial multi-hop for resilience. Three parallel single-hop tunnels beat one three-hop circuit.
11. **🐉 Trust is earned, not given.** Every node starts at zero trust. Reputation accumulates through uptime, consistency, and peer vouching. Sybil attacks must burn time and compute. *(DeepSeek: 制度大于人心 — systems over sentiment.)*
12. **☯️ 阴阳平衡.** Every layer needs both centralized structure and decentralized resilience. Bootstrap = yang. DHT = yin. Authorization = balanced. Defection defense = yang inside yin. *(DeepSeek.)*
13. **💀 Serial multi-hop is dead.** Killed by consensus of 6 AIs. Removed from schema. Parallel multiplexing (主轨+暗轨) is the resilience model. *(GLM 5.1: "Remove `route: []` — it's code debt violating YAGNI.")*
14. **🚂 Client retry = 70% of viability.** Architecture is 30%. Clients must implement relentless degradation: 1 fail → probe, 3 fails → dead + resubscribe. *(GLM 5.1.)*

---

## ❓ FAQ

**Is this free?**
Yes! GitHub Actions free tier gives you 2,000 minutes/month. Each node uses 15-60 min. The mesh draws ~3 nodes at a time, so ~45-180 min per "mesh hour." Do the math. 🧮

**How is this different from v1?**
v1 had one runner, one coordinator, one point of failure. v2 has a **mesh** — multiple nodes, DHT discovery, self-healing. The coordinator is now optional (a BitTorrent tracker, not a server). If it dies, the mesh keeps working.

**Wait, why is libp2p NOT in the data path?**
Because that's the whole point. DHT is for *finding* nodes, not *routing traffic through* them. Same reason BitTorrent uses DHT to find peers but transfers files directly between them. Putting libp2p in the data path would add latency, complexity, and a single protocol dependency. VLESS/Hysteria2 are purpose-built for proxying. Let them do their job.

**What if the coordinator goes down?**
The mesh continues on DHT alone. Coordinator = BitTorrent tracker. Nice to have, not required. It degrades gracefully: online+DHT = best, offline+DHT = fine, online-only = legacy fallback.

**How do nodes find each other if they're all ephemeral?**
Multiple bootstrap strategies: coordinator bootstrap endpoint, last-known peers from git, public libp2p bootstrap nodes, and the DHT itself (once at least one node is alive, others find it). The chicken-and-egg problem is real — see Q1 in the open questions.

**Is my traffic encrypted?**
Yes. VLESS and Hysteria2 are encrypted protocols. Traffic between you and the proxy node is encrypted. The DHT is public metadata (node configs, not your traffic).

**Can I use this for... reasons?**
Educational purposes only. Respect GitHub's ToS. Respect local laws. This is a science experiment, not a service. 🧪

**Why Hysteria2 vs VLESS?**
Hysteria2: no TLS cert needed, QUIC-based, faster on lossy networks.
VLESS: more widely supported, WebSocket transport plays nice with CDN.
Both are first-class in the mesh. Your call.

**Is this... Tor?**
lol no. Tor is a production-grade, multi-hop onion routing network with thousands of nodes and decades of security research. This is a weekend project that runs proxy nodes in GitHub Actions and finds them via DHT. But philosophy-wise? Same neighborhood. Three AIs reviewed the design — two say "design for multi-hop later," one says "skip it entirely." Interestingly, Gemini pointed out that 3 parallel single-hop tunnels (multiplexing) beat 1 serial 3-hop circuit for our use case. So the "your own Tor" line is a vibe, not a security claim. But we're building the scaffolding for it.

---

## 🤝 Contributing

This is a research project. Fork it, break it, improve it. PRs welcome, but expect things to change fast. The spec is still a draft.

See `docs/SPEC-V2-MESH.md` for the full architectural specification and `docs/BRAINSTORM-PROMPT.md` for the consillium prompt.

---

## 📜 License

MIT — Because sharing is caring. 💙

---

**⚠️ Disclaimer:** This project is a pure science experiment in decentralized ephemeral proxy meshes. It is not affiliated with the original [BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel). No production use is intended or supported. Use responsibly, in accordance with GitHub's Terms of Service, and in compliance with your local laws. The authors assume zero liability for what you do with this knowledge.
