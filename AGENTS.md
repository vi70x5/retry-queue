# BPB Action Mesh

> **Agent Readiness:** This file contains two kinds of guidance:
> - **Universal rules** — project structure, branching, architecture, and security patterns that apply regardless of what tooling you have.
> - **Workflow recommendations** — tool-specific tips that are helpful when the relevant tools are available, but not required to complete tasks. Use whatever tools you have access to.

Decentralized mesh of ephemeral proxy nodes (VLESS/Hysteria2) on GitHub Actions runners, discovered via libp2p Kademlia DHT. Research experiment — not production.

## Structure

```
src/        Express + Socket.IO dashboard (server.ts, assets/panel/)
node/       libp2p DHT mesh node — discovery + lifecycle
worker/     Cloudflare Worker coordinator — register, heartbeat, subscription
scripts/    CLI: proxy-up.sh, animamesh-connect.sh, proxy-down.sh, proxy-status.sh
.github/    proxy.yml (GHA runner), panel.yml (build/deploy dashboard)
docs/       SPEC-V2-MESH.md, SPEC-V3-ANIMAMESH-BACKEND.md, ANIMAMESH-CLIENT.md
```

## Commands

| Action | Command |
|---|---|
| Dev dashboard | `npm run dev` |
| Dev mesh node | `cd node && npm run dev` |
| Dev coordinator | `cd worker && npm run dev` |
| Build all | `npm run build` |
| Build panel | `npm run build:panel` |
| Test | `npm test` (no-op stub) |
| Lint | `npm run lint` |
| Launch proxy | `./scripts/proxy-up.sh --protocol hysteria2` |
| Deploy coordinator | `cd worker && npm run deploy` |
| P2P connect | `./scripts/animamesh-connect.sh --coordinator URL --auth-token TOKEN` |

## Agent SOP — The Delegate-Verify Loop

This is the critical workflow for any code-change task. **Follow it every time.**

### Step 1: Analyze & Plan

Use structured exploration tools (if available) to understand the codebase before planning changes:

1. Start by exploring the codebase — identify the relevant symbols/files for your task. (If you have a code-indexing or symbol-search tool, use it here instead of brute-reading full files.)
2. Assess blast radius — understand what depends on the symbols you're about to change. Check both direct and transitive dependents.
3. Map module boundaries — know what crosses package boundaries. This repo crosses three packages (root, `node/`, `worker/` with different module systems).

Break into smallest incremental steps. Delegate one step at a time.

### Step 2: Delegate ONE Step (If Sub-Agent Tool Is Available)

When delegating to a sub-agent, every prompt must include:

1. **Repo identifier** — the repo/project name so the sub-agent knows where it's working
2. **Code-tool mandate:** instruct the sub-agent to use structured code-lookup tools (if available) instead of reading full files
3. **Target symbols/files:** exact symbols the sub-agent needs to read or modify
4. **All required context:** the sub-agent is stateless — include everything it needs to complete the task
5. **Token budget:** if your delegation tool supports token caps, set a reasonable limit to keep context focused

Example delegation preamble (adapt to your available tooling):

```
Repo: bpb-action
Use structured lookup for all code exploration — avoid reading full files.
Target symbols: <list symbol_ids>
Include all context the sub-agent needs.
```

Delegate only the immediate next step. Never bundle multiple steps. If work can be parallelized across disjoint files, instruct the sub-agent to fan out.

**Recursive safety:** If you are the spawned sub-agent, do your designated job directly. Do not recursively spawn further sub-agents unless explicitly instructed to "fan out."

### Step 3: ❗ Verify the Result (CRITICAL)

**Never trust a sub-agent's report.** Sub-agents frequently claim success while leaving code unmodified. After every delegated task:

1. **Read the actual file** — use `grep` / `read_file` to confirm the expected code is present. Do not rely on cached or pre-indexed reads.
2. Check blast radius — confirm impact matches expectations by tracing importers and callers of changed symbols.
3. Verify no call site is broken — check references to changed symbols across the project.
4. Re-index or invalidate caches if your tooling requires it after edits.
5. Run tests: `npm test` (currently a no-op stub, but check anyway).

□ **Before committing:** Did I verify with grep that all expected code is actually in the files?

### Step 4: Iterate

- **Approved:** Move to next step (return to Step 2).
- **Revision needed:** Re-delegate with corrective feedback. Instruct the sub-agent to read the current state before editing. **Do not fix code yourself** — delegate the fix so the sub-agent builds correct context.

**Lesson learned — sub-agent false-positive:** A sub-agent for a code-restructuring task reported "all changes applied successfully" but the target file was never modified — only unrelated comments were touched. The missing function body was discovered when verifying by reading the source with `grep`. Always verify the actual output — not just the sub-agent's summary.

## Git Rules

| Rule | Detail |
|---|---|
| Default branch | `main` — push triggers proxy workflow via GHA |
| Layout | Monorepo: root `package.json` owns dashboard; `node/` and `worker/` have own packages |
| Sync | `proxy.yml` runs on `ubuntu-latest`, 45-min timeout; DHT node step is commented out — do not re-enable |

Emergency recovery: push to main or `workflow_dispatch` → `proxy-up.sh` → `curl $COORDINATOR_URL/health` → `proxy-down.sh` to cancel stuck runs.

## Testing Rules

- `npm test` exits 0 (no tests yet)
- When adding tests: place adjacent to source (e.g. `node/src/lifecycle.test.ts`), use same module system as the source package, update the relevant `package.json` test script
- `panel.yml` has `continue-on-error: true` on deploy/release — failures are silently ignored

## Architecture Landmines

| Constraint | Why it matters |
|---|---|
| **DHT is discovery-only** | Never route proxy traffic through libp2p — unanimous consillium agreement |
| **Coordinator is optional** | Every feature must work DHT-only — graceful degradation |
| **No serial multi-hop** | `route: []` was killed by consillium — parallel multiplexing is the resilience model |
| **Ephemeral by design** | Nodes live 15-60 min, no persistent state, identity is per-lifecycle PeerId |
| **Stagger, don't sync** | Random TTLs, jittered announces — no herd behavior |
| **DHT key schema** | `/bpb/v2/{network-id}/{protocol}/{peer-id}` — changing it requires updating both `node/announce.ts` and the spec |
| **Module system mismatch** | Root tsconfig = CommonJS, `node/tsconfig.json` = ES2022 — never mix import styles across packages |
| **`/sub/all` format** | Consumed by Hiddify/v2ray clients — any output change breaks existing subscriptions |

Coordinator API to preserve:

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/register` | POST | Bearer | Runner registers proxy config |
| `/heartbeat` | POST | Bearer | Runner refreshes TTL |
| `/sub/all` | GET | None | Hiddify subscription (all proxies) |
| `/sub/{id}` | GET | None | Single proxy subscription |
| `/proxies` | GET | None | JSON list of active proxies |
| `/delete/{id}` | DELETE | Bearer | Remove a proxy record |
| `/health` | GET | None | Service health check |

## Credential Rules

- `COORDINATOR_URL`, `AUTH_TOKEN`, `NETWORK_ID` → GitHub Actions secrets only, never in source
- Worker `AUTH_TOKEN` set via `wrangler secret put AUTH_TOKEN` — if absent, worker allows all requests (dev mode)
- `wrangler.toml` KV namespace id is a placeholder — replace after `wrangler kv:namespace create BPB_KV`, don't commit real ids

## Further Reference

- `docs/SPEC-V2-MESH.md` — Full architecture (DHT topology, lifecycle, threat model, consillium decisions)
- `docs/SPEC-V3-ANIMAMESH-BACKEND.md` — V3 architecture (n2n P2P overlay, coordinator, signing)
- `docs/ANIMAMESH-CLIENT.md` — n2n P2P Linux client documentation
- `README.md` — Quick start, threat model, FAQ, roadmap