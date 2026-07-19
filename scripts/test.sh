#!/usr/bin/env bash
#
# Smoke-test a deployed Cloudflare Stats Worker V2.
# Override target with: STATS_HOST=https://your.worker.example.com ./scripts/test.sh
set -euo pipefail

BASE_URL=${STATS_HOST:-${1:-http://127.0.0.1:8787}}
PASS="\033[0;32mPASS\033[0m"; FAIL="\033[0;31mFAIL\033[0m"; WARN="\033[1;33mWARN\033[0m"; INFO="\033[0;34mINFO\033[0m"
pass_count=0; fail_count=0
step() { printf "[%b] %s\n" "$INFO" "$1"; }
mark_pass() { printf "       [%b] %s\n" "$PASS" "$1"; pass_count=$((pass_count + 1)); }
mark_fail() { printf "       [%b] %s\n" "$FAIL" "$1"; fail_count=$((fail_count + 1)); }
command -v jq >/dev/null 2>&1 || { printf "[%b] jq is required\n" "$FAIL" >&2; exit 1; }
http_get() { curl --silent --show-error --max-time 10 "$1"; }
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

printf "Stats Worker V2 smoke test\nTarget: %s\n\n" "$BASE_URL"

step "Health (/health)"
if echo "$(http_get "$BASE_URL/health")" | jq -e '.status=="ok"' >/dev/null 2>&1; then mark_pass "status=ok"; else mark_fail "bad health"; fi

step "Dashboard (/)"
DS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL/")
[ "$DS" = "200" ] && mark_pass "HTTP 200" || mark_fail "HTTP $DS"

step "Config (/api/config)"
if echo "$(http_get "$BASE_URL/api/config")" | jq -e '.timezone|type=="string"' >/dev/null 2>&1; then mark_pass "timezone present"; else mark_fail "no timezone"; fi

step "Ingest (POST /api/collect, dev origin)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/collect" \
  -H "Origin: http://127.0.0.1" -H "User-Agent: $UA" -H "Content-Type: application/json" \
  -d '{"path":"/_smoke/","referrer":"https://news.ycombinator.com/"}')
[ "$CODE" = "204" ] && mark_pass "collect 204" || mark_fail "collect $CODE"

step "Bot excluded (POST /api/collect, GPTBot)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/collect" \
  -H "Origin: http://127.0.0.1" -H "User-Agent: GPTBot/1.1" -H "Content-Type: application/json" \
  -d '{"path":"/_smoke/","referrer":""}')
[ "$CODE" = "204" ] && mark_pass "bot 204 (no row expected)" || mark_fail "bot $CODE"

step "Origin enforcement (POST /api/collect, bad origin)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/collect" \
  -H "Origin: https://evil.example" -H "User-Agent: $UA" -H "Content-Type: application/json" -d '{"path":"/"}')
[ "$CODE" = "403" ] && mark_pass "403 rejected" || mark_fail "expected 403, got $CODE"

step "Summary (/api/summary)"
if echo "$(http_get "$BASE_URL/api/summary")" | jq -e '(.today.pv|type)=="number"' >/dev/null 2>&1; then mark_pass "cards ok"; else mark_fail "bad summary"; fi

step "Query (/api/query group_by=country)"
if echo "$(http_get "$BASE_URL/api/query?metric=pageviews&group_by=country")" | jq -e '(.results|type)=="array"' >/dev/null 2>&1; then mark_pass "query ok"; else mark_fail "bad query"; fi

step "Timeseries (/api/timeseries)"
if echo "$(http_get "$BASE_URL/api/timeseries?metric=visitors")" | jq -e '(.results|type)=="array"' >/dev/null 2>&1; then mark_pass "timeseries ok"; else mark_fail "bad timeseries"; fi

printf "\nSummary: %d passed, %d failed\n" "$pass_count" "$fail_count"
[ "$fail_count" -gt 0 ] && exit 1 || exit 0
