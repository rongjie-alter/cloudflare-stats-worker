#!/usr/bin/env bash
#
# Smoke-test the deployed Cloudflare Stats Worker. Defaults to stats.zakk.au.
# Override with: STATS_HOST=https://your.worker.example.com ./scripts/test.sh

set -euo pipefail

BASE_URL=${STATS_HOST:-${1:-https://stats.zakk.au}}

PASS="\033[0;32mPASS\033[0m"
FAIL="\033[0;31mFAIL\033[0m"
WARN="\033[1;33mWARN\033[0m"
INFO="\033[0;34mINFO\033[0m"

pass_count=0
fail_count=0

step() {
  printf "[%b] %s\n" "$INFO" "$1"
}

mark_pass() {
  printf "       [%b] %s\n" "$PASS" "$1"
  pass_count=$((pass_count + 1))
}

mark_fail() {
  printf "       [%b] %s\n" "$FAIL" "$1"
  fail_count=$((fail_count + 1))
}

mark_warn() {
  printf "       [%b] %s\n" "$WARN" "$1"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || {
    printf "[%b] jq is required (install with 'brew install jq' or your package manager)\n" "$FAIL" >&2
    exit 1
  }
}

http_get() {
  curl --silent --show-error --max-time 10 "$1"
}

require_jq

printf "Stats Worker smoke test\n"
printf "Target: %s\n\n" "$BASE_URL"

# 1. Health
step "Health check (/health)"
if HEALTH=$(http_get "$BASE_URL/health"); then
  if echo "$HEALTH" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    mark_pass "status=ok"
  else
    mark_fail "unexpected response: $HEALTH"
  fi
else
  mark_fail "request failed"
fi

# 2. Dashboard HTML
step "Dashboard (/)"
if DASHBOARD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL/"); then
  if [ "$DASHBOARD_STATUS" = "200" ]; then
    mark_pass "HTTP 200"
    if curl -s --max-time 10 "$BASE_URL/" | grep -q 'data-i18n="title"'; then
      mark_pass "i18n payload present"
    else
      mark_fail "i18n payload missing"
    fi
  else
    mark_fail "HTTP $DASHBOARD_STATUS"
  fi
else
  mark_fail "request failed"
fi

# 3. Page stats query
step "Site stats (/api/stats)"
if SITE=$(http_get "$BASE_URL/api/stats"); then
  if echo "$SITE" | jq -e '.success == true and (.site.pv | type) == "number"' >/dev/null 2>&1; then
    mark_pass "site totals returned"
  else
    mark_fail "unexpected response: $SITE"
  fi
else
  mark_fail "request failed"
fi

# 4. Counter increment
step "Counter increment (/api/count)"
if COUNT=$(http_get "$BASE_URL/api/count?url=/_smoke-test/"); then
  if echo "$COUNT" | jq -e '.success == true and (.page.pv | type) == "number"' >/dev/null 2>&1; then
    mark_pass "increment ok"
  else
    mark_fail "unexpected response: $COUNT"
  fi
else
  mark_fail "request failed"
fi

# 5. Batch lookup
step "Batch (/api/batch)"
if BATCH=$(http_get "$BASE_URL/api/batch?urls=/,/about/,/posts/"); then
  if echo "$BATCH" | jq -e '.success == true and (.count | type) == "number"' >/dev/null 2>&1; then
    mark_pass "batch ok ($(echo "$BATCH" | jq -r '.count') paths)"
  else
    mark_fail "unexpected response: $BATCH"
  fi
else
  mark_fail "request failed"
fi

# 6. Top pages (D1 optional)
step "Top pages (/api/top, optional)"
if TOP=$(http_get "$BASE_URL/api/top?limit=5" || true); then
  if echo "$TOP" | jq -e '.success == true' >/dev/null 2>&1; then
    mark_pass "top pages ok"
  elif echo "$TOP" | jq -e '.success == false' >/dev/null 2>&1; then
    mark_warn "D1 not configured (skipping)"
  else
    mark_fail "unexpected response: $TOP"
  fi
else
  mark_fail "request failed"
fi

printf "\nSummary: %d passed, %d failed\n" "$pass_count" "$fail_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
