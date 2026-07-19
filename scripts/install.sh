#!/usr/bin/env bash
#
# Cloudflare Stats Worker V2 — guided installer.
# Creates the KV namespace (rate-limit buckets) and D1 database (analytics),
# applies the schema, builds the dashboard, writes wrangler.toml, and deploys.
# Safe to re-run; existing resources are reused.

set -Eeuo pipefail

BLUE="\033[1;34m"; GREEN="\033[1;32m"; YELLOW="\033[1;33m"; RED="\033[1;31m"; NC="\033[0m"
info() { printf "%b->%b %s\n" "$BLUE" "$NC" "$1"; }
ok()   { printf "%bOK%b %s\n" "$GREEN" "$NC" "$1"; }
warn() { printf "%b!!%b %s\n" "$YELLOW" "$NC" "$1"; }
fail() { printf "%bXX%b %s\n" "$RED" "$NC" "$1"; exit 1; }

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_ROOT"

command -v wrangler >/dev/null 2>&1 || fail "wrangler not found. Install with: pnpm add -g wrangler"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not found. See https://pnpm.io/installation"

info "Cloudflare Stats Worker V2 installer"

if ! wrangler whoami >/dev/null 2>&1; then
  info "Logging in to Cloudflare via Wrangler..."
  wrangler login >/dev/null
  ok "Login successful"
fi

read -rp "Worker name [cloudflare-stats-worker]: " WORKER_NAME
WORKER_NAME=${WORKER_NAME:-cloudflare-stats-worker}

read -rp "Worker domain (e.g. stats.example.com): " WORKER_DOMAIN
read -rp "Allowed website origin (e.g. https://blog.example.com): " ALLOWED_ORIGIN
read -rp "Rate limit per IP per minute [120]: " RATE_LIMIT
RATE_LIMIT=${RATE_LIMIT:-120}
read -rp "Timezone [Asia/Tokyo]: " TIMEZONE
TIMEZONE=${TIMEZONE:-Asia/Tokyo}

COMPAT_DATE=$(grep '^compatibility_date' wrangler.toml 2>/dev/null | awk -F'"' '{print $2}')
COMPAT_DATE=${COMPAT_DATE:-$(date +%Y-%m-%d)}

# --- KV namespace (rate-limit buckets) ------------------------------------------------
KV_TITLE="${WORKER_NAME//[^A-Za-z0-9_-]/}_PAGE_STATS"
info "Creating KV namespace (${KV_TITLE})..."
KV_OUTPUT=$(wrangler kv namespace create "$KV_TITLE" 2>&1 || true)
if echo "$KV_OUTPUT" | grep -qi "already exists"; then
  warn "Namespace already exists. Reusing existing ID."
  KV_ID=$(wrangler kv namespace list 2>/dev/null | awk -v t="$KV_TITLE" '$0 ~ t {print $2}' | head -1)
  [[ -n "$KV_ID" ]] || read -rp "Enter existing KV namespace id: " KV_ID
else
  KV_ID=$(echo "$KV_OUTPUT" | awk -F'"' '/id =/ {print $2}' | head -1)
fi
[[ -n "$KV_ID" ]] || fail "KV namespace id missing"
ok "KV bound: $KV_ID"

# --- D1 database (required in V2) -----------------------------------------------------
D1_NAME="cloudflare_stats_db"
info "Creating D1 database (${D1_NAME})..."
D1_OUTPUT=$(wrangler d1 create "$D1_NAME" 2>&1 || true)
if echo "$D1_OUTPUT" | grep -qi "already exists"; then
  warn "D1 database already exists. Reusing existing ID."
  D1_ID=$(wrangler d1 list 2>/dev/null | awk -v n="$D1_NAME" '$0 ~ n {print $1}' | head -1)
  [[ -n "$D1_ID" ]] || read -rp "Enter existing D1 database id: " D1_ID
else
  D1_ID=$(echo "$D1_OUTPUT" | awk -F'"' '/database_id =/ {print $2}' | head -1)
fi
[[ -n "$D1_ID" ]] || fail "D1 database id missing"
ok "D1 bound: $D1_ID"

info "Applying schema.sql to ${D1_NAME}..."
wrangler d1 execute "$D1_NAME" --remote --file=schema.sql >/dev/null
ok "Schema applied"

# --- Build dashboard ------------------------------------------------------------------
info "Building dashboard (pnpm)..."
pnpm --dir dashboard-v2 install >/dev/null
pnpm --dir dashboard-v2 build >/dev/null
ok "Dashboard built -> dashboard-v2/dist"

# --- Write wrangler.toml --------------------------------------------------------------
info "Writing wrangler.toml..."
cat > wrangler.toml <<EOF
name = "$WORKER_NAME"
main = "src/index.js"
compatibility_date = "$COMPAT_DATE"
compatibility_flags = ["nodejs_compat"]

[vars]
WORKER_DOMAIN         = "$WORKER_DOMAIN"
ALLOWED_ORIGIN        = "$ALLOWED_ORIGIN"
RATE_LIMIT_PER_MINUTE = "$RATE_LIMIT"
TIMEZONE              = "$TIMEZONE"

[assets]
directory = "./dashboard-v2/dist"
binding   = "ASSETS"

[triggers]
crons = ["30 15 * * *"]

[[kv_namespaces]]
binding = "PAGE_STATS"
id = "$KV_ID"
preview_id = "$KV_ID"

[[d1_databases]]
binding = "DB"
database_name = "$D1_NAME"
database_id = "$D1_ID"
EOF
ok "wrangler.toml updated"

# --- Deploy ---------------------------------------------------------------------------
info "Deploying Worker..."
wrangler deploy >/tmp/stats-worker-deploy.log && ok "Deployment successful" || fail "Deployment failed (see /tmp/stats-worker-deploy.log)"

cat <<SUMMARY

${GREEN}Done.${NC}
Dashboard : https://${WORKER_DOMAIN}/
Health    : https://${WORKER_DOMAIN}/health
Beacon    : https://${WORKER_DOMAIN}/beacon.js

Next steps:
  1. Add the beacon to your site (${ALLOWED_ORIGIN}):
       <script defer src="https://${WORKER_DOMAIN}/beacon.js"></script>
  2. Load a page on your site, then open the dashboard to confirm data.
SUMMARY
