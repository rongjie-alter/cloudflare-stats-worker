# cloudflare-stats-worker

Self-hosted website analytics on Cloudflare Workers. Tracks page views (PV) and unique visitors (UV) with no npm dependencies and no external services.

## Architecture

Single worker file handles both the API and the dashboard. No build step — pure ES module deployed directly via `wrangler deploy`.

**Storage split:**
- **KV (`PAGE_STATS`)** — hot counter store, all live reads/writes on every page view
- **D1 (`DB`, database `cloudflare-stats-top`)** — SQL layer for ranked (`ORDER BY pv`) and date-range queries only; optional, failures never break counting

## Key Files

| File | Purpose |
|---|---|
| `src/index.js` | Worker entry point — all routing, API handlers, KV/D1 logic |
| `src/dashboard.js` | Exports the full dashboard SPA as an HTML string served at `/` |
| `schema.sql` | D1 DDL: `page_stats` and `site_daily_stats` |
| `wrangler.toml` | Binds KV namespace and D1 database |
| `scripts/install.sh` | Interactive installer — preferred deployment path |
| `check.js` | Node.js quick-check against a live deployment (`node check.js`) |

## API Routes

```
GET  /              Dashboard SPA
POST /api/count     Increment PV/UV; invalidates cached responses
GET  /api/stats     Page or site totals from KV          (cached 30s)
GET  /api/batch     Bulk-read up to 50 paths from KV     (cached 30s)
GET  /api/top       Top pages from D1 ranked by PV       (cached 60s)
GET  /api/daily     Daily PV/UV from D1 by date range    (cached 30s)
GET  /health        {status, version, timestamp}
```

Cache invalidation runs in `ctx.waitUntil` after every `/api/count`.

## KV Key Schema

```
page:<path>:pv                      page view count (permanent)
page:<path>:uv                      unique visitor count (permanent)
site:total:pv                       site-wide PV total (permanent)
site:total:uv                       site-wide UV total (permanent)
visitor:page:<path>:<id>:<date>     daily dedup key, TTL 86400s
visitor:site:<id>:<date>            daily dedup key, TTL 86400s
ratelimit:<ip>:<60s-bucket>         rate limit counter (120 req/60s), TTL 60s
```

Visitor ID: first 16 hex chars of `SHA-256(ip + userAgent)` — cookieless.

## D1 Tables

```sql
page_stats(path TEXT PK, pv INT, uv INT, updated_at DATETIME)
site_daily_stats(date TEXT PK, pv INT, uv INT, updated_at DATETIME)
```

Both are upserted in a single `db.batch()` call on every `/api/count`. D1 writes are in `try/catch` — failure is silent and never breaks the KV path.

Auto-sync: if `/api/top` is called and D1 has no rows, `syncKVToD1` scans KV (`kv.list({ prefix: "page:", limit: 1000 })`) and bulk-inserts into D1.

## Path Normalization

All paths are normalized before use as KV keys or D1 PKs (`normalizePath`, `src/index.js`):
- Full URLs → pathname only
- Query strings and hash fragments stripped
- `/index.html`, `/index`, `/_index` suffixes removed
- Language prefixes `/zh-cn/`, `/zh-tw/`, `/en/` stripped
- Trailing slash always appended

## Local Development

```bash
wrangler dev          # local dev server with miniflare
node check.js             # quick-check a live deployment
bash scripts/test.sh      # smoke test (needs jq, targets $STATS_HOST)
bash scripts/verify.sh <url>   # step-by-step verification (needs jq)
```

## Deployment

```bash
bash scripts/install.sh   # interactive: creates KV/D1, rewrites wrangler.toml, deploys
wrangler deploy       # re-deploy after code changes
wrangler d1 execute cloudflare-stats-top --remote --file=schema.sql  # apply schema
```

## Dashboard

Bilingual (Traditional Chinese / English), Chart.js loaded from jsDelivr CDN with SRI. Language and theme are persisted in `localStorage`. Shows: total PV/UV, today's stats, 7/14/30-day trend chart, page search, top 10 pages.

The older `dashboard/index.html` is superseded by `src/dashboard.js` but kept for reference.
