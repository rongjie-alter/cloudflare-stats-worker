#!/usr/bin/env bash
# Step-by-step V2 verification. Usage: ./scripts/verify.sh <base-worker-url>
# Uses Origin: http://127.0.0.1 (the built-in dev exception) so it can record a
# test event against any deployment without knowing the configured allowed origin.
set -euo pipefail

BASE_URL=${1:-}
if [[ -z "$BASE_URL" ]]; then
  echo "Usage: $0 <base-worker-url>   e.g. $0 https://stats.example.com" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "[FAIL] jq is required" >&2; exit 1; }

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok()   { echo "[ OK ] $*"; }
info() { echo "[INFO] $*"; }

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

info "1. Health"
curl -sS --max-time 10 "$BASE_URL/health" | jq -e '.status=="ok"' >/dev/null || fail "health not ok"
ok "health"

info "2. Config"
TZ=$(curl -sS "$BASE_URL/api/config" | jq -r '.timezone')
[[ -n "$TZ" && "$TZ" != "null" ]] || fail "config missing timezone"
ok "timezone=$TZ"

info "3. Ingest a test pageview (Origin: dev exception)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/collect" \
  -H "Origin: http://127.0.0.1" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -d '{"path":"/_verify/","referrer":"https://www.google.com/"}')
[[ "$CODE" == "204" ]] || fail "collect returned $CODE (expected 204)"
ok "collect accepted"

info "4. Disallowed origin is rejected"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/collect" \
  -H "Origin: https://evil.example" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -d '{"path":"/","referrer":""}')
[[ "$CODE" == "403" ]] || fail "disallowed origin returned $CODE (expected 403)"
ok "origin enforcement"

info "5. Summary"
curl -sS "$BASE_URL/api/summary" | jq -e '(.today.pv|type)=="number"' >/dev/null || fail "summary invalid"
ok "summary"

info "6. Query by country"
curl -sS "$BASE_URL/api/query?metric=pageviews&group_by=country" | jq -e '(.results|type)=="array"' >/dev/null || fail "query invalid"
ok "query"

echo "All checks passed."
