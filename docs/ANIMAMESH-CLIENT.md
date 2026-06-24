# Animamesh n2n P2P Linux Client

**Direct P2P proxy connections** — no middleman in the data path.

```
Your PC ─── n2n VPN ─── GHA Runner (Hysteria2 server)
                    ↕
          Direct P2P traffic (UDP hole-punched)
```

The Animamesh Linux client lets you connect to the n2n P2P overlay network,
discover active proxy endpoints via the Worker coordinator, and launch a
Hysteria2 SOCKS5 tunnel — all **direct peer-to-peer**, no cloudflare/ngrok
in the data path.

## Quick Start

### 1-click connect

```bash
./scripts/animamesh-connect.sh \
  --coordinator https://your-worker.worker.dev \
  --auth-token your-token
```

That's it. The script will:

1. Install `n2n` edge if missing
2. Fetch n2n community + key from the Worker coordinator
3. Join the n2n overlay VPN (virtual IP: `10.10.10.X`)
4. Discover n2n Hysteria2 proxies from the Worker subscription
5. Start a Hysteria2 SOCKS5 tunnel on `127.0.0.1:1080`
6. Keep everything alive until you press Ctrl+C

### Use the proxy

Once connected, configure any app to use the SOCKS5 proxy:

```bash
# Test with curl
curl --socks5 127.0.0.1:1080 https://ifconfig.me

# Or set environment variables
export http_proxy=socks5://127.0.0.1:1080
export https_proxy=socks5://127.0.0.1:1080
```

### Clean disconnect

Press **Ctrl+C** — the script gracefully stops Hysteria2 and the n2n edge.

## Usage

```text
./scripts/animamesh-connect.sh [options]

REQUIRED (one of):
  -C, --coordinator URL    Worker coordinator URL
  -c, --community NAME     n2n community (manual mode, needs -k and -s too)

OPTIONS:
  -t, --auth-token TOKEN   Auth token for n2n-join
  -k, --n2n-key KEY        n2n encryption key
  -s, --supernode HOST:PORT  n2n supernode
  -i, --virtual-ip IP      Local n2n IP (default: auto)
      --socks5-port PORT   SOCKS5 listen port (default: 1080)
  -d, --discovery METHOD   worker|dht|both (default: worker)
      --no-install         Skip installing deps
      --no-hysteria        Join n2n only, no proxy
      --json-config        Print hysteria2 config and exit
  -v, --verbose            More output
  -h, --help               This message
```

## Examples

### Basic — coordinator + auth token

```bash
./scripts/animamesh-connect.sh \
  --coordinator https://bpb-action.worker.dev \
  --auth-token my-secret-token
```

### Using environment variables

```bash
export COORDINATOR_URL=https://bpb-action.worker.dev
export AUTH_TOKEN=my-secret-token
./scripts/animamesh-connect.sh
```

### Manual n2n config (no coordinator needed)

If you know the n2n community and key directly:

```bash
./scripts/animamesh-connect.sh \
  --community my-animamesh-net \
  --key MyStrongP2PPassword \
  --supernode supernode.ntop.org:7777
```

### Just join the n2n network (no proxy tunnel)

```bash
./scripts/animamesh-connect.sh \
  --coordinator https://bpb-action.worker.dev \
  --auth-token my-token \
  --no-hysteria
```

Useful if you want to manually inspect the network or use a different proxy
client.

### Output hysteria2 config as JSON (no connection)

```bash
./scripts/animamesh-connect.sh \
  --coordinator https://bpb-action.worker.dev \
  --auth-token my-token \
  --json-config
```

### Custom SOCKS5 port

```bash
./scripts/animamesh-connect.sh \
  --coordinator https://bpb-action.worker.dev \
  --auth-token my-token \
  --socks5-port 2080
```

## Architecture

```
                          ┌──────────────────────┐
                          │  Cloudflare Worker    │
                          │  (coordinator)        │
                          │  /mesh/n2n-join       │
                          │  /sub/all             │
                          └──────┬───────────────┘
                                 │ HTTPS
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌──────────────┐         ┌──────────────────┐
           │  GHA Runner  │         │  Your Linux PC   │
           │  10.10.10.1  │◄───────►│  10.10.10.X      │
           │  Hysteria2   │  n2n   │  Hysteria2 client │
           │  (server)    │  P2P   │  (SOCKS5 proxy)   │
           └──────────────┘         └──────────────────┘
                    ▲                     ▲
                    │     Direct P2P      │
                    └─────────────────────┘
                      (no middleman!)
```

### What makes this P2P?

1. **n2n Layer 2 overlay** — Your PC and the GHA runner join the same n2n
   community. The supernode helps with initial connection (STUN-like), but
   once UDP hole-punching succeeds, traffic flows **directly** between peers.

2. **n2n virtual IPs** — The runner has `10.10.10.1`, your PC gets `10.10.10.2`
   (or any `.X`). They can reach each other directly via these IPs.

3. **Hysteria2 over n2n** — Hysteria2 binds to the n2n virtual IP on the
   runner. Your Hysteria2 client connects to `10.10.10.1:PORT`. All encrypted
   proxy traffic goes through the n2n tunnel — **no cloudflare, no ngrok,
   no coordinator in the data path**.

4. **Worker is NOT in the data path** — The Worker only serves as a rendezvous:
   it tells the client which n2n community to join and where the active proxies
   are. After that, the client connects directly.

## Requirements

- **Linux** (Debian/Ubuntu, Arch, Fedora)
- **sudo** — for `edge` (n2n creates a TUN interface) and optionally
  `hysteria2` if you want the SOCKS5 tunnel
- **curl** — for Worker API calls
- Internet access to the Worker coordinator and n2n supernode

### Auto-installed

- `n2n` (via apt/pacman/dnf)
- `jq` (for JSON parsing)

### Optional

- `hysteria2` binary — download from
  [github.com/apernet/hysteria/releases](https://github.com/apernet/hysteria/releases)
  If missing, the script will generate the config file and exit.

## How It Works (Detailed)

### Step 1: Get n2n credentials

The script calls the Worker coordinator:

- **Public:** `GET /mesh/n2n-config` → returns `{community, supernode}`
- **Authenticated:** `POST /mesh/n2n-join` → returns `{community, key, supernode}`

### Step 2: Join the n2n overlay

```bash
sudo edge -c <community> -k <key> -a 10.10.10.X -l <supernode>:7777
```

The `edge` process creates a `edge0` TUN interface. Now your PC is on the
same virtual LAN as all the GHA runner proxies.

### Step 3: Discover proxies

The script fetches `GET /sub/all` from the Worker and filters for lines with
`10.` addresses (n2n proxies). It picks the first Hysteria2 link.

### Step 4: Start Hysteria2 client

The script generates a hysteria2 client config and starts the binary:

```yaml
server: 10.10.10.1:PORT
auth: <password>
tls:
  insecure: true
  sni: 10.10.10.1
socks5:
  listen: 127.0.0.1:1080
```

Now you have a SOCKS5 proxy on `127.0.0.1:1080` that tunnels through the n2n
P2P connection directly to the GHA runner.

## Troubleshooting

### n2n edge won't start

Check the log:

```bash
cat /tmp/n2n-edge.log
```

Common issues:
- Missing `sudo`
- Community name or key mismatch
- Supernode unreachable (try an alternative from the list below)
- Firewall blocking UDP port `7777`

### n2n interface up but can't ping 10.10.10.1

```bash
# Check your interface
ip addr show edge0

# Ping the runner
ping -c 3 10.10.10.1

# Check n2n status
ip route | grep edge0
```

If ping fails, the runner may have disconnected (GHA timeout). Wait for a
new proxy to start.

### Subscription empty or no n2n proxies

No runners are currently active with n2n tunnel. Trigger a new one:

```bash
./scripts/proxy-up.sh --protocol hysteria2
```

Make sure the workflow is configured to use `n2n` tunnel.

### Hysteria2 client fails

```bash
cat /tmp/animamesh-hy2.log
```

Try running the client manually:

```bash
hysteria2 client -c /tmp/animamesh-hy2-client.yaml
```

## Alternative Public Supernodes

If `supernode.ntop.org:7777` is unreachable, try these public supernodes:

| Supernode | Location |
|---|---|
| `supernode.ntop.org:7777` | Official ntop test server |
| `vps.luckynet.info:7777` | Europe/CIS |
| `n2n.luckynet.info:7777` | Fallback |
| `supernode.lucaswilliams.co.uk:7777` | UK |

Override with `--supernode` or `N2N_SUPERNODE` env var.

## Related

- `SPEC-V3-ANIMAMESH-BACKEND.md` — Full backend specification
- `SPEC-V2-MESH.md` — Original mesh specification
- `proxy-up.sh` — Trigger a new proxy runner
- `proxy-status.sh` — Check running proxies
