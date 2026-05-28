#!/usr/bin/env bash
#
# Cloudflare Stats Worker — guided installer.
# Handles KV namespace creation, optional D1 setup, wrangler.toml rewrite,
# and the first deploy. Safe to re-run; existing resources are reused.

set -Eeuo pipefail

BLUE="\033[1;34m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
NC="\033[0m"

info()   { printf "%b->%b %s\n" "$BLUE" "$NC" "$1"; }
ok()     { printf "%bOK%b %s\n" "$GREEN" "$NC" "$1"; }
warn()   { printf "%b!!%b %s\n" "$YELLOW" "$NC" "$1"; }
fail()   { printf "%bXX%b %s\n" "$RED" "$NC" "$1"; exit 1; }

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_ROOT"

dep_check() {
  if ! command -v "$1" >/dev/null 2>&1; then
    warn "$1 not found. Installing globally with npm..."
    npm install -g "$1" >/dev/null
    ok "$1 installed"
  fi
}

info "Cloudflare Stats Worker installer"
dep_check wrangler

if ! wrangler whoami >/dev/null 2>&1; then
  info "Logging in to Cloudflare via Wrangler..."
  wrangler login >/dev/null
  ok "Login successful"
else
  ACCOUNT_NAME=$(wrangler whoami 2>&1 | awk -F': ' '/Account Name/ {print $2}')
  ok "Using Cloudflare account: ${ACCOUNT_NAME:-unknown}"
fi

read -rp "Worker name [cloudflare-stats-worker]: " WORKER_NAME
WORKER_NAME=${WORKER_NAME:-cloudflare-stats-worker}

read -rp "Custom domain (optional, e.g. stats.example.com): " CUSTOM_DOMAIN

read -rp "Create D1 database for /api/top? (Y/n): " USE_D1
USE_D1=${USE_D1:-Y}
USE_D1=$(echo "$USE_D1" | tr '[:upper:]' '[:lower:]')

COMPAT_DATE=$(grep '^compatibility_date' wrangler.toml 2>/dev/null | awk -F'"' '{print $2}')
COMPAT_DATE=${COMPAT_DATE:-$(date +%Y-%m-%d)}

# --- KV namespace --------------------------------------------------------------------
KV_TITLE="${WORKER_NAME//[^A-Za-z0-9_-]/}_PAGE_STATS"

info "Creating KV namespace (${KV_TITLE})..."
KV_OUTPUT=$(wrangler kv namespace create "$KV_TITLE" 2>&1 || true)
if echo "$KV_OUTPUT" | grep -qi "already exists"; then
  warn "Namespace already exists. Reusing existing ID."
  KV_ID=$(wrangler kv namespace list 2>/dev/null | awk -v title="$KV_TITLE" '$0 ~ title {print $2}' | head -1)
  if [[ -z "$KV_ID" ]]; then
    read -rp "Enter existing KV namespace id: " KV_ID
  fi
else
  KV_ID=$(echo "$KV_OUTPUT" | awk -F'"' '/id =/ {print $2}' | head -1)
fi

KV_PREVIEW_OUTPUT=$(wrangler kv namespace create "$KV_TITLE" --preview 2>&1 || true)
if echo "$KV_PREVIEW_OUTPUT" | grep -qi "already exists"; then
  warn "Preview namespace already exists. Reusing existing ID."
  KV_PREVIEW_ID=$KV_ID
else
  KV_PREVIEW_ID=$(echo "$KV_PREVIEW_OUTPUT" | awk -F'"' '/preview_id =/ {print $2}' | head -1)
fi

[[ -n "$KV_ID" ]] || fail "KV namespace id missing"
[[ -n "$KV_PREVIEW_ID" ]] || fail "KV preview id missing"

ok "KV bound: $KV_ID"

# --- D1 database --------------------------------------------------------------------
D1_BLOCK=""
if [[ "$USE_D1" == "y" || "$USE_D1" == "yes" ]]; then
  D1_NAME="${WORKER_NAME//[^A-Za-z0-9_-]/}-stats"
  info "Creating D1 database (${D1_NAME})..."
  D1_OUTPUT=$(wrangler d1 create "$D1_NAME" 2>&1 || true)
  if echo "$D1_OUTPUT" | grep -qi "already exists"; then
    warn "D1 database already exists. Reusing existing ID."
    D1_ID=$(wrangler d1 list 2>/dev/null | awk -v name="$D1_NAME" '$0 ~ name {print $1}' | head -1)
    if [[ -z "$D1_ID" ]]; then
      read -rp "Enter existing D1 database id: " D1_ID
    fi
  else
    D1_ID=$(echo "$D1_OUTPUT" | awk -F'"' '/database_id =/ {print $2}' | head -1)
  fi
  [[ -n "$D1_ID" ]] || fail "D1 database id missing"
  ok "D1 bound: $D1_ID"

  if [[ -f schema.sql ]]; then
    info "Applying schema.sql to ${D1_NAME}..."
    wrangler d1 execute "$D1_NAME" --remote --file=schema.sql >/dev/null
    ok "Schema applied"
  else
    warn "schema.sql not found; skipping table creation"
  fi

  D1_BLOCK=$'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "'$D1_NAME$'"\ndatabase_id = "'$D1_ID$'"\n'
fi

# --- Rewrite wrangler.toml ----------------------------------------------------------
info "Writing wrangler.toml..."
cat > wrangler.toml <<EOF
name = "$WORKER_NAME"
main = "src/index.js"
compatibility_date = "$COMPAT_DATE"

[[kv_namespaces]]
binding = "PAGE_STATS"
id = "$KV_ID"
preview_id = "$KV_PREVIEW_ID"
$D1_BLOCK
EOF
ok "wrangler.toml updated"

# --- Deploy ------------------------------------------------------------------------
info "Deploying Worker..."
wrangler deploy >/tmp/stats-worker-deploy.log && ok "Deployment successful" || fail "Deployment failed"

ACCOUNT_SUBDOMAIN=$(wrangler whoami 2>&1 | awk -F': ' '/Account ID/ {print $2}' | tr -d '-' | cut -c1-8)
WORKERS_URL="https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev"

if [[ -n "$CUSTOM_DOMAIN" ]]; then
  info "Binding custom domain ${CUSTOM_DOMAIN}..."
  if wrangler custom-domains add "$CUSTOM_DOMAIN" >/dev/null 2>&1; then
    ok "Custom domain added"
  else
    warn "Unable to bind custom domain automatically — add it from the Cloudflare dashboard."
  fi
fi

cat <<SUMMARY

${GREEN}Done.${NC}
Primary URL : ${WORKERS_URL}
Dashboard   : ${WORKERS_URL}/
Health      : ${WORKERS_URL}/health
API sample  : ${WORKERS_URL}/api/stats?url=/

SUMMARY

if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo "Custom domain : https://${CUSTOM_DOMAIN}"
fi

echo "Next steps:"
echo "  1. Update assets/js/cloudflare-stats.js -> API_BASE to match your domain."
echo "  2. Visit the dashboard and confirm PV/UV counters."
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo "  3. Ensure DNS and SSL for ${CUSTOM_DOMAIN} are active in Cloudflare."
fi
