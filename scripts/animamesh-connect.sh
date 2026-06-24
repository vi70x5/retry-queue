#!/usr/bin/env bash
#
# animamesh-connect.sh — 1-click Linux client for Animamesh n2n P2P mesh
#
# Connects your Linux machine to the Animamesh n2n overlay VPN,
# discovers active proxy endpoints via the Worker coordinator,
# and launches a Hysteria2 SOCKS5 tunnel for direct P2P proxy traffic.
#
# ─── Architecture ─────────────────────────────────────────────────────────
#
#                          ┌──────────────────────┐
#                          │  Cloudflare Worker    │
#                          │  (coordinator)        │
#                          │  /mesh/n2n-join       │
#                          │  /sub/all             │
#                          └──────┬───────────────┘
#                                 │ HTTPS
#                    ┌────────────┴────────────┐
#                    ▼                         ▼
#           ┌──────────────┐         ┌──────────────────┐
#           │  GHA Runner  │         │  Your Linux PC   │
#           │  10.10.10.1  │◄───────►│  10.10.10.X      │
#           │  Hysteria2   │  n2n   │  Hysteria2 client │
#           │  (server)    │  P2P   │  (SOCKS5 proxy)   │
#           └──────────────┘         └──────────────────┘
#                    ▲                     ▲
#                    │     Direct P2P      │
#                    └─────────────────────┘
#                      (no middleman!)
#
# Usage:
#   ./animamesh-connect.sh --coordinator https://worker.example.com [options]
#
# Options:
#   -C, --coordinator URL    Worker coordinator URL (required unless manual n2n)
#   -t, --auth-token TOKEN   Auth token for n2n-join
#   -k, --n2n-key KEY        n2n encryption key (override or manual mode)
#   -c, --community NAME     n2n community name (override or manual mode)
#   -s, --supernode HOST:PORT  n2n supernode
#   -i, --virtual-ip IP      Local n2n virtual IP (default: 10.10.10.random)
#       --socks5-port PORT   Local SOCKS5 port (default: 1080)
#   -d, --discovery METHOD   Discovery: worker|dht|both (default: worker)
#       --dht-only           Use DHT discovery only (requires node/ package)
#       --no-install         Skip dependency installation
#       --no-hysteria        Don't start hysteria2, just join n2n & print config
#       --json-config        Print hysteria2 client config JSON then exit
#   -v, --verbose            Verbose output
#   -h, --help               Show help
#
# Environment variables:
#   COORDINATOR_URL          Worker coordinator URL
#   AUTH_TOKEN               Auth token for n2n-join
#   N2N_COMMUNITY            n2n community name
#   N2N_KEY                  n2n encryption key
#   N2N_SUPERNODE            n2n supernode host:port
#   N2N_VIRTUAL_IP           Local n2n virtual IP
#
# Examples:
#   # 1-click with coordinator + auth token
#   ./animamesh-connect.sh --coordinator https://bpb.worker.dev --auth-token mytoken
#
#   # Same with env vars
#   export COORDINATOR_URL=https://bpb.worker.dev
#   export AUTH_TOKEN=mytoken
#   ./animamesh-connect.sh
#
#   # Manual n2n config (no coordinator needed)
#   ./animamesh-connect.sh --community mynet --key secret --supernode supernode.ntop.org:7777
#

set -euo pipefail

# ─── Version ─────────────────────────────────────────────────────────────

VERSION="1.0.0"
SCRIPT_NAME="$(basename "$0")"

# ─── Defaults ────────────────────────────────────────────────────────────

COORDINATOR_URL="${COORDINATOR_URL:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
N2N_COMMUNITY="${N2N_COMMUNITY:-}"
N2N_KEY="${N2N_KEY:-}"
N2N_SUPERNODE="${N2N_SUPERNODE:-}"
N2N_VIRTUAL_IP="${N2N_VIRTUAL_IP:-}"
SOCKS5_PORT="${ANIMAMESH_SOCKS5_PORT:-1080}"
DISCOVERY_MODE="worker"
NO_INSTALL=false
NO_HYSTERIA=false
JSON_CONFIG=false
VERBOSE=false
EDGE_PID=""
HY2_PID=""
CLEANUP_DONE=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Helper functions ────────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}ℹ${NC} $*"; }
log_ok()    { echo -e "${GREEN}✔${NC} $*"; }
log_warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
log_error() { echo -e "${RED}✘${NC} $*" >&2; }
log_step()  { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }
log_debug() { if [ "$VERBOSE" = true ]; then echo -e "${CYAN}…${NC} $*"; fi; }

banner() {
  echo ""
  echo -e "${CYAN}  _          _     _                      ${NC}"
  echo -e "${CYAN} / \\\\  _ __ (_) __| | ___ _ __ ___   ___  ${NC}"
  echo -e "${CYAN}/ _ \\\\| '_ \\\\| |/ _\` |/ _ \\\\ '_ \` _ \\\\ / _ \\\\ ${NC}"
  echo -e "${CYAN}/ ___ \\\\| | | | | (_| |  __/ | | | | |  __/ ${NC}"
  echo -e "${CYAN}/_/   \\_\\\\_| |_|_|\\\\__,_|\\\\___|_| |_| |_|\\\\___| ${NC}"
  echo -e "${CYAN}  n2n P2P Client v${VERSION}${NC}"
  echo ""
}

usage() {
  cat <<EOF
Animamesh n2n P2P Client v${VERSION} — 1-click Linux client

USAGE:
  $SCRIPT_NAME [options]

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
      --dht-only           DHT discovery only
      --no-install         Skip installing deps
      --no-hysteria        Join n2n only, no proxy
      --json-config        Print hysteria2 config and exit
  -v, --verbose            More output
  -h, --help               This message

EOF
  exit 0
}

cleanup() {
  if [ "$CLEANUP_DONE" = true ]; then return; fi
  CLEANUP_DONE=true
  echo ""
  log_info "Shutting down..."

  if [ -n "$HY2_PID" ] && kill -0 "$HY2_PID" 2>/dev/null; then
    log_info "Stopping Hysteria2 client (PID $HY2_PID)..."
    kill "$HY2_PID" 2>/dev/null || true
    wait "$HY2_PID" 2>/dev/null || true
    log_ok "Hysteria2 stopped"
  fi

  if [ -n "$EDGE_PID" ] && kill -0 "$EDGE_PID" 2>/dev/null; then
    log_info "Stopping n2n edge (PID $EDGE_PID)..."
    sudo kill "$EDGE_PID" 2>/dev/null || true
    wait "$EDGE_PID" 2>/dev/null || true
    log_ok "n2n edge stopped"
  fi

  # Remove hysteria2 config temp file
  rm -f /tmp/animamesh-hy2-client.yaml /tmp/animamesh-hy2-client.json

  log_ok "Disconnected. See you later!"
}

# ─── Parse arguments ─────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--coordinator)  COORDINATOR_URL="$2"; shift 2 ;;
    -t|--auth-token)   AUTH_TOKEN="$2"; shift 2 ;;
    -k|--n2n-key)      N2N_KEY="$2"; shift 2 ;;
    -c|--community)    N2N_COMMUNITY="$2"; shift 2 ;;
    -s|--supernode)    N2N_SUPERNODE="$2"; shift 2 ;;
    -i|--virtual-ip)   N2N_VIRTUAL_IP="$2"; shift 2 ;;
    --socks5-port)     SOCKS5_PORT="$2"; shift 2 ;;
    -d|--discovery)    DISCOVERY_MODE="$2"; shift 2 ;;
    --dht-only)        DISCOVERY_MODE="dht"; shift ;;
    --no-install)      NO_INSTALL=true; shift ;;
    --no-hysteria)     NO_HYSTERIA=true; shift ;;
    --json-config)     JSON_CONFIG=true; shift ;;
    -v|--verbose)      VERBOSE=true; shift ;;
    -h|--help)         usage ;;
    *)                 echo "Unknown option: $1"; usage ;;
  esac
done

trap cleanup EXIT INT TERM

# ─── Validate ────────────────────────────────────────────────────────────

MANUAL_N2N=false
if [ -n "$N2N_COMMUNITY" ] && [ -n "$N2N_KEY" ]; then
  MANUAL_N2N=true
fi

if [ -z "$COORDINATOR_URL" ] && [ "$MANUAL_N2N" = false ]; then
  log_error "Either --coordinator or --community (with --n2n-key) is required"
  echo ""
  usage
fi

if [ -n "$COORDINATOR_URL" ]; then
  # Strip trailing slash
  COORDINATOR_URL="${COORDINATOR_URL%/}"
fi

# ─── Banner ──────────────────────────────────────────────────────────────

banner

# ─── Step 1: Install dependencies ────────────────────────────────────────

log_step "1/5  Checking dependencies"

if [ "$NO_INSTALL" = false ]; then
  # Check n2n
  if command -v edge &>/dev/null; then
    log_ok "n2n edge found at $(command -v edge)"
  else
    log_info "n2n not found. Installing..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq n2n
      log_ok "n2n installed"
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm n2n
      log_ok "n2n installed"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y n2n
      log_ok "n2n installed"
    else
      log_warn "Could not install n2n automatically. Please install n2n manually."
      log_info "  Debian/Ubuntu: sudo apt install n2n"
      log_info "  Arch: sudo pacman -S n2n"
      log_info "  Fedora: sudo dnf install n2n"
    fi
  fi

  # Check jq
  if ! command -v jq &>/dev/null; then
    log_info "jq not found. Installing..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq jq
      log_ok "jq installed"
    else
      log_warn "jq recommended for parsing. Install with your package manager."
    fi
  else
    log_debug "jq available"
  fi

  # Check hysteria2
  if [ "$NO_HYSTERIA" = false ] && [ "$JSON_CONFIG" = false ]; then
    if command -v hysteria2 &>/dev/null || command -v hysteria &>/dev/null; then
      log_ok "hysteria2 client found"
    else
      log_warn "Hysteria2 client not found. Will generate config only."
      log_info "  Download from: https://github.com/apernet/hysteria/releases"
      log_info "  Or use --no-hysteria to join n2n without proxy tunnel"
      NO_HYSTERIA=true
    fi
  fi
else
  log_debug "Skipping dependency installation (--no-install)"
fi

# ─── Step 2: Resolve n2n config ──────────────────────────────────────────

log_step "2/5  Resolving n2n network config"

if [ "$MANUAL_N2N" = true ]; then
  log_info "Using manual n2n config"
  log_debug "  Community: $N2N_COMMUNITY"
  log_debug "  Supernode: ${N2N_SUPERNODE:-default}"
else
  log_info "Fetching n2n config from coordinator: $COORDINATOR_URL"
  log_debug "  GET ${COORDINATOR_URL}/mesh/n2n-config"

  N2N_CONFIG=$(curl -sf --max-time 10 "${COORDINATOR_URL}/mesh/n2n-config" 2>/dev/null || true)

  if [ -z "$N2N_CONFIG" ]; then
    log_warn "Public n2n-config endpoint returned nothing."
    log_info "Trying n2n-join with auth token..."

    if [ -z "$AUTH_TOKEN" ]; then
      log_error "Coordinator requires AUTH_TOKEN for n2n-join. Provide via --auth-token or AUTH_TOKEN env var."
      exit 1
    fi

    N2N_CONFIG=$(curl -sf --max-time 10 \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -X POST "${COORDINATOR_URL}/mesh/n2n-join" 2>/dev/null || true)

    if [ -z "$N2N_CONFIG" ]; then
      log_error "Failed to fetch n2n config from coordinator"
      exit 1
    fi

    log_ok "n2n config fetched (authenticated)"
  else
    log_ok "n2n config fetched (public)"
  fi

  # Parse n2n config (handle both JSON and missing jq)
  if command -v jq &>/dev/null; then
    if [ -z "$N2N_COMMUNITY" ]; then
      N2N_COMMUNITY=$(echo "$N2N_CONFIG" | jq -r '.community // empty')
    fi
    if [ -z "$N2N_KEY" ]; then
      N2N_KEY=$(echo "$N2N_CONFIG" | jq -r '.key // empty')
    fi
    if [ -z "$N2N_SUPERNODE" ]; then
      N2N_SUPERNODE=$(echo "$N2N_CONFIG" | jq -r '.supernode // "supernode.ntop.org:7777"')
    fi
  else
    # Fallback: extract values with grep/sed
    if [ -z "$N2N_COMMUNITY" ]; then
      N2N_COMMUNITY=$(echo "$N2N_CONFIG" | grep -o '"community"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"community"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    fi
    if [ -z "$N2N_KEY" ]; then
      N2N_KEY=$(echo "$N2N_CONFIG" | grep -o '"key"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    fi
    if [ -z "$N2N_SUPERNODE" ]; then
      N2N_SUPERNODE=$(echo "$N2N_CONFIG" | grep -o '"supernode"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"supernode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo "supernode.ntop.org:7777")
    fi
  fi

  # If still missing key, try n2n-join
  if [ -z "$N2N_KEY" ] && [ -n "$AUTH_TOKEN" ]; then
    log_info "Key not in public config — fetching from n2n-join endpoint..."
    N2N_JOIN=$(curl -sf --max-time 10 \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -X POST "${COORDINATOR_URL}/mesh/n2n-join" 2>/dev/null || true)
    if [ -n "$N2N_JOIN" ]; then
      if command -v jq &>/dev/null; then
        N2N_KEY=$(echo "$N2N_JOIN" | jq -r '.key // empty')
        N2N_COMMUNITY=$(echo "$N2N_JOIN" | jq -r '.community // empty')
        N2N_SUPERNODE=$(echo "$N2N_JOIN" | jq -r '.supernode // empty')
      fi
    fi
  fi
fi

# Validate n2n config
if [ -z "$N2N_COMMUNITY" ]; then
  log_error "No n2n community configured"
  exit 1
fi
if [ -z "$N2N_SUPERNODE" ]; then
  N2N_SUPERNODE="supernode.ntop.org:7777"
  log_debug "Using default supernode: $N2N_SUPERNODE"
fi
if [ -z "$N2N_KEY" ]; then
  log_warn "No n2n encryption key configured. Traffic will NOT be encrypted!"
  log_warn "Set N2N_KEY or ensure your coordinator has N2N_KEY configured"
fi

log_ok "n2n network: $N2N_COMMUNITY"
log_debug "  Supernode: $N2N_SUPERNODE"
log_debug "  Key: ${N2N_KEY:+**** (set)}${N2N_KEY:-none}"

# ─── Step 3: Join n2n network ────────────────────────────────────────────

log_step "3/5  Joining n2n P2P overlay network"

# Assign virtual IP if not set
if [ -z "$N2N_VIRTUAL_IP" ]; then
  # Pick a random IP in 10.10.10.x range (avoiding 1 which is usually the runner)
  RANDOM_SUFFIX=$(( (RANDOM % 89) + 10 ))  # 10-98
  N2N_VIRTUAL_IP="10.10.10.$RANDOM_SUFFIX"
  log_debug "Using auto-assigned IP: $N2N_VIRTUAL_IP"
fi

# Check if edge0 already exists
if ip addr show edge0 &>/dev/null; then
  log_warn "n2n interface edge0 already exists"
  EXISTING_IP=$(ip -4 addr show edge0 | grep -oP 'inet \K[\d.]+' 2>/dev/null || true)
  if [ -n "$EXISTING_IP" ]; then
    log_info "Current IP: $EXISTING_IP"
  fi
  log_info "Skipping n2n join (already connected)"
  log_info "To rejoin, run: sudo ip link delete edge0"
else
  log_info "Starting n2n edge (IP: $N2N_VIRTUAL_IP)"

  EDGE_CMD="sudo edge -c \"$N2N_COMMUNITY\" -a \"$N2N_VIRTUAL_IP\" -l \"$N2N_SUPERNODE\" -f"
  if [ -n "$N2N_KEY" ]; then
    EDGE_CMD="$EDGE_CMD -k \"$N2N_KEY\""
  fi

  log_debug "Running: $EDGE_CMD"
  eval "$EDGE_CMD" > /tmp/n2n-edge.log 2>&1 &
  EDGE_PID=$!

  # Wait for interface
  sleep 3
  for i in $(seq 1 10); do
    if ip addr show edge0 &>/dev/null; then
      ASSIGNED_IP=$(ip -4 addr show edge0 | grep -oP 'inet \K[\d.]+' 2>/dev/null || echo "$N2N_VIRTUAL_IP")
      log_ok "Connected! IP: $ASSIGNED_IP (PID: $EDGE_PID)"
      N2N_VIRTUAL_IP="$ASSIGNED_IP"
      break
    fi
    if ! kill -0 "$EDGE_PID" 2>/dev/null; then
      log_error "n2n edge process died. Logs:"
      cat /tmp/n2n-edge.log
      exit 1
    fi
    sleep 1
  done

  if ! ip addr show edge0 &>/dev/null; then
    log_error "n2n edge interface did not come up. Logs:"
    cat /tmp/n2n-edge.log
    exit 1
  fi
fi

# ─── Step 4: Discover proxies ────────────────────────────────────────────

log_step "4/5  Discovering proxies"

PROXY_LIST=""

case "$DISCOVERY_MODE" in
  worker)
    if [ -z "$COORDINATOR_URL" ]; then
      log_warn "No coordinator URL for worker discovery. Trying DHT..."
      DISCOVERY_MODE="dht"
    fi
    ;;
  dht|both)
    log_info "DHT discovery requires the node/ package to be set up"
    log_info "  cd node && npm install && npm run indexer"
    if [ "$DISCOVERY_MODE" = "dht" ]; then
      log_warn "DHT-only mode selected but not implemented in bash yet"
      log_info "Falling back to worker discovery..."
      DISCOVERY_MODE="worker"
    fi
    ;;
esac

if [ "$DISCOVERY_MODE" = "worker" ] && [ -n "$COORDINATOR_URL" ]; then
  log_info "Fetching subscription from Worker coordinator..."
  log_debug "  GET ${COORDINATOR_URL}/sub/all"

  SUBSCRIPTION=$(curl -sf --max-time 15 "${COORDINATOR_URL}/sub/all" 2>/dev/null || true)

  if [ -z "$SUBSCRIPTION" ]; then
    log_warn "Empty subscription from coordinator"
  else
    # Filter to n2n proxy lines (host starting with 10.)
    PROXY_LIST=$(echo "$SUBSCRIPTION" | grep -E '^hysteria2://[^@]+@10\.' || true)
    PROXY_LIST="$PROXY_LIST
$(echo "$SUBSCRIPTION" | grep -E '^vless://[^@]+@10\.' || true)"

    PROXY_COUNT=$(echo "$PROXY_LIST" | grep -c '://' 2>/dev/null || echo 0)

    if [ "$PROXY_COUNT" -eq 0 ]; then
      log_warn "No n2n proxies found in subscription"
      log_info "Trying all proxies (may include non-n2n)..."
      PROXY_LIST=$(echo "$SUBSCRIPTION" | grep -E '^hysteria2://' | head -3 || true)
      PROXY_COUNT=$(echo "$PROXY_LIST" | grep -c '://' 2>/dev/null || echo 0)
    fi

    log_ok "Found $PROXY_COUNT proxy line(s)"
    echo ""
    echo "$PROXY_LIST" | head -5 | while IFS= read -r line; do
      [ -n "$line" ] && echo "  ${BLUE}→${NC} $line"
    done
  fi
fi

# ─── Step 5: Setup Hysteria2 client ──────────────────────────────────────

log_step "5/5  Setting up proxy tunnel"

if [ "$NO_HYSTERIA" = true ]; then
  log_info "Skipping Hysteria2 client (--no-hysteria)"
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}n2n P2P network joined!${NC}"
  echo ""
  echo -e "  ${BOLD}Your n2n IP:${NC}     $N2N_VIRTUAL_IP"
  echo -e "  ${BOLD}Community:${NC}       $N2N_COMMUNITY"
  if [ -n "$PROXY_LIST" ]; then
    echo ""
    echo -e "  ${BOLD}Subscription:${NC}"
    echo "$PROXY_LIST" | while IFS= read -r line; do
      [ -n "$line" ] && echo "    $line"
    done
  fi
  echo ""
  echo -e "  To start Hysteria2 client manually:"
  echo -e "    ./animamesh-connect.sh --coordinator $COORDINATOR_URL --no-install"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Keep alive — just monitor n2n
  log_info "Monitoring n2n connection. Press Ctrl+C to disconnect."
  while true; do
    if ! ip addr show edge0 &>/dev/null; then
      log_error "n2n interface lost!"
      exit 1
    fi
    sleep 10
  done
  # NOTREACHED
fi

# Pick the first hysteria2 n2n proxy
HY2_LINE=$(echo "$PROXY_LIST" | grep -E '^hysteria2://' | head -1 || true)

if [ -z "$HY2_LINE" ]; then
  log_error "No hysteria2 n2n proxy found in subscription"
  log_info "Available proxies:"
  echo "$PROXY_LIST"
  exit 1
fi

log_info "Parsing proxy URL: $HY2_LINE"

# Parse hysteria2 URL: hysteria2://PASSWORD@HOST:PORT?params#name
# Extract password, host, port, params
HY2_RAW="${HY2_LINE#hysteria2://}"        # Remove scheme
HY2_PASSWORD="${HY2_RAW%%@*}"              # Everything before @
HY2_REST="${HY2_RAW#*@}"                   # Everything after @
HY2_HOST="${HY2_REST%%:*}"                 # Host
HY2_PORT="${HY2_REST#*:}"                  # Port + query
HY2_PORT="${HY2_PORT%%\?*}"               # Just port
HY2_PARAMS="${HY2_REST#*\?}"              # Everything after ?
HY2_SNI="${HY2_PARAMS#*sni=}"             # sni=value...
HY2_SNI="${HY2_SNI%%[&#]*}"               # Strip &params and #fragment
HY2_NAME="${HY2_LINE#*#}"                 # Everything after #
[ "$HY2_NAME" = "$HY2_LINE" ] && HY2_NAME="animamesh-n2n"

log_debug "  Host: $HY2_HOST"
log_debug "  Port: $HY2_PORT"
log_debug "  Password: ${HY2_PASSWORD:0:8}..."
log_debug "  SNI: ${HY2_SNI:-$HY2_HOST}"

# Generate hysteria2 client config
HY2_SNI="${HY2_SNI:-$HY2_HOST}"
HY2_CONFIG_FILE="/tmp/animamesh-hy2-client.yaml"

cat > "$HY2_CONFIG_FILE" <<HYCONF
# Animamesh n2n Hysteria2 client config
# Generated by animamesh-connect.sh v${VERSION}
server: ${HY2_HOST}:${HY2_PORT}
auth: ${HY2_PASSWORD}
tls:
  insecure: true
  sni: ${HY2_SNI}
socks5:
  listen: 127.0.0.1:${SOCKS5_PORT}
HYCONF

if [ "$JSON_CONFIG" = true ]; then
  log_info "Hysteria2 client config (JSON):"
  echo ""
  cat > /tmp/animamesh-hy2-client.json <<HYJSON
{
  "server": "${HY2_HOST}:${HY2_PORT}",
  "auth": "${HY2_PASSWORD}",
  "tls": {
    "insecure": true,
    "sni": "${HY2_SNI}"
  },
  "socks5": {
    "listen": "127.0.0.1:${SOCKS5_PORT}"
  }
}
HYJSON
  cat /tmp/animamesh-hy2-client.json
  echo ""
  exit 0
fi

# Find hysteria2 binary
HY2_BIN=""
for cmd in hysteria2 hysteria; do
  if command -v "$cmd" &>/dev/null; then
    HY2_BIN="$cmd"
    break
  fi
done

if [ -z "$HY2_BIN" ]; then
  log_error "Hysteria2 client not found!"
  log_info "Config saved to: $HY2_CONFIG_FILE"
  log_info "Run manually: hysteria2 client -c $HY2_CONFIG_FILE"
  exit 1
fi

log_info "Starting Hysteria2 client (SOCKS5 on 127.0.0.1:$SOCKS5_PORT)..."
log_debug "  Binary: $HY2_BIN"
log_debug "  Config: $HY2_CONFIG_FILE"

"$HY2_BIN" client -c "$HY2_CONFIG_FILE" > /tmp/animamesh-hy2.log 2>&1 &
HY2_PID=$!

# Wait for hysteria2 to be ready
sleep 2
if kill -0 "$HY2_PID" 2>/dev/null; then
  log_ok "Hysteria2 client started (PID: $HY2_PID)"
else
  log_warn "Hysteria2 client failed to start. Check /tmp/animamesh-hy2.log"
  cat /tmp/animamesh-hy2.log
  log_info "You can start it manually:"
  log_info "  $HY2_BIN client -c $HY2_CONFIG_FILE"
fi

# ─── Success ─────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  ✅ Connected! Direct P2P proxy traffic flowing${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Proxy:${NC}       ${HY2_HOST}:${HY2_PORT} (${HY2_NAME})"
echo -e "  ${BOLD}SOCKS5:${NC}      127.0.0.1:${SOCKS5_PORT}"
echo -e "  ${BOLD}n2n IP:${NC}      $N2N_VIRTUAL_IP"
echo -e "  ${BOLD}Community:${NC}   $N2N_COMMUNITY"
echo ""
echo -e "  ${BOLD}Test:${NC}         curl --socks5 127.0.0.1:${SOCKS5_PORT} https://ifconfig.me"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to disconnect.${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ─── Keep alive ──────────────────────────────────────────────────────────

log_debug "Entering keep-alive loop (monitoring n2n + hysteria2)"

while true; do
  # Check n2n interface
  if ! ip addr show edge0 &>/dev/null; then
    log_error "n2n interface edge0 lost! Reconnecting..."
    # The cleanup handler will stop hysteria2
    exit 1
  fi

  # Check hysteria2
  if ! kill -0 "$HY2_PID" 2>/dev/null; then
    log_warn "Hysteria2 client died. Restarting..."
    log_info "Check /tmp/animamesh-hy2.log for details"
    # Restart
    "$HY2_BIN" client -c "$HY2_CONFIG_FILE" > /tmp/animamesh-hy2.log 2>&1 &
    HY2_PID=$!
    sleep 2
    if kill -0 "$HY2_PID" 2>/dev/null; then
      log_ok "Hysteria2 restarted (PID: $HY2_PID)"
    else
      log_error "Failed to restart Hysteria2"
      exit 1
    fi
  fi

  # Ping n2n gateway or log stats every 30s
  if command -v ping &>/dev/null; then
    # Ping the gateway (first .1 is often the runner)
    ping -c 1 -W 1 10.10.10.1 > /dev/null 2>&1 && P2P_OK=true || P2P_OK=false
    if [ "$P2P_OK" = true ]; then
      log_debug "n2n P2P ping OK (10.10.10.1 reachable)"
    fi
  fi

  sleep 15
done
