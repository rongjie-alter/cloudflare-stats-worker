# cloudflare-stats-worker (V2)

Self-hosted, cookieless website analytics on Cloudflare Workers. Records rich per-pageview dimensions (OS, browser, device, country, referrer) with bot exclusion, and serves a preact dashboard. Reusable per-website via config.

## Architecture

A single worker (`src/index.js`) handles the ingest + query API and serves the dashboard SPA from **Workers Static Assets**. The dashboard is a separate Vite/preact app built into `dashboard-v2/dist`.

**Storage:**
- **D1 (`DB`, database `cloudflare_stats_db`)** — single source of truth. Raw one-row-per-pageview fact table `events_tab` (hot 6-month window) + dictionary `dim_*_tab` lookup tables + rollups (`site_daily_tab`, `dim_daily_tab`, `hier_daily_tab`) + `meta_tab` bookkeeping + `events_monthly_tab` archive.

**Metrics:** PV = `COUNT(*)`, UV = `COUNT(DISTINCT visitor_id)` over `events_tab`. UV is not additive across dimensions, which is why raw `visitor_id` rows are kept (enables exact arbitrary-dimension UV).

## Read path — this is the part that matters

D1's free tier allows **5M rows read/day**. At 5–10K pageviews/day, reading breakdowns straight off `events_tab` cost ~2.3M rows for a single cold dashboard load — about 1.5 loads/day. Everything below exists to fix that.

**Nothing scans the full `events_tab` on the common path.** Instead:

| Read | Source | Rows read (7d) |
|---|---|---|
| Dimension breakdown, unfiltered pageviews | `dim_daily_tab` (sealed days) `UNION ALL` today live | ~100–2,000 |
| Sunburst hierarchy | `hier_daily_tab`, one statement for all levels | ~150 |
| Trend chart, unfiltered | `site_daily_tab` | ~7 |
| Headline PV cards | `site_daily_tab` + today live + archive | ~180 |
| Headline UV cards (7d/30d/all-time) | `meta_tab` snapshot | 1 |
| **Anything filtered, or any multi-day `metric=visitors`** | **`events_tab`, exactly as before** | full range |

**Sealed vs live.** Rollup rows are written once, by the nightly cron, after a day has closed — never incremented. Today is always read live from `events_tab` and merged into the same statement, so it is never stale. Maintaining rollups at ingest time was rejected: it would cost ~14 extra rows written per pageview against a 100K/day free write budget that ingest already spends ~30K of.

**Rollups store PV only.** `COUNT(DISTINCT)` is not summable across days — nor across a hierarchy's deeper levels — and both failures would be silent. So unique visitors are always answered from `events_tab` and stay exact. The one precomputed UV is per-day site-wide (`site_daily_tab.uv`), which the read path never sums across days.

**Coverage is explicit.** `meta_tab.rollup_min_day` / `rollup_max_day` bound the sealed window, and it is kept *contiguous*. A query starting before `rollup_min_day` bypasses the rollups entirely rather than returning a partial count. Sealing walks backwards a few days per night (`ROLLUP_BACKFILL_DAYS_PER_RUN`), so coverage of older history improves over time; until then those queries are correct but slow.

**Caching.** `[cache] enabled = true` in every wrangler config. This matters: the older `caches.default` API is a **no-op on `*.workers.dev`** — `put()` resolves, `match()` always misses — so before this the 30s cache had never once worked. Handlers drive it via `Cache-Control`: 24h for a date range that has already closed (it can never change), 5m for anything touching today.

**Freshness contract:** pageviews are exact and live everywhere. `today.uv` is exact and live. `last7d`/`last30d`/`allTime` UV come from a snapshot, dated by `uv_as_of` in the `/api/summary` response and labelled in the UI — 7d/30d refresh nightly, all-time weekly (it is a 1.35M-row scan and moves &lt;1%/day).

## Naming convention

D1 database uses a `_db` suffix; every table uses a `_tab` suffix (`events_tab`, `dim_path_tab`, …).

## Key files

| File | Purpose |
|---|---|
| `src/index.js` | Worker: router, ingest, query API, `scheduled` cron, static-asset serving, `normalizePath`, timezone day logic |
| `src/ua.js` | ua-parser-js wrapper: OS/browser/device parse, bot/AI-crawler exclusion, referrer parse |
| `src/config.js` | Reads `[vars]`, origin/CORS enforcement, `localDay`/`localDayOffset` (Intl, tz-aware) |
| `schema.sql` | D1 DDL (`dim_*_tab`, `events_tab`, the rollups, `meta_tab`, `events_monthly_tab`; V1 tables kept as legacy baseline) |
| `migrations/add-rollup-tables.sql` | Adds the rollups + indexes to an existing deployment |
| `migrations/backfill-rollups.sql` | One-time 31-day backfill (read the COST note first) |
| `scripts/verify-rollup.mjs` | Diffs rollup-served vs raw-served vs ground truth |
| `scripts/export.sh` | Export to local SQLite/DuckDB for unbounded analysis |
| `report.js` | Client beacon (also shipped from `dashboard-v2/public/report.js` → `/report.js`) |
| `dashboard-v2/` | Vite + preact + AG Grid + ECharts dashboard (English only) |
| `wrangler.toml` | `[vars]`, `[assets]`, `[triggers]` cron, D1 bindings |
| `check.js` | Node quick-check against a deployment |

## API routes

```
POST /api/send      Ingest one pageview (beacon). Origin-restricted; bots excluded. -> 204
GET  /api/query        Grouped breakdown: metric, from/to, group_by, filter, exclude, limit
GET  /api/timeseries   Daily trend: metric, from/to, filters
GET  /api/summary      Headline cards (today / 7d / 30d / all-time)
GET  /api/config       { timezone } for client date math
GET  /health           { status, version, timestamp }
*                      Static assets (dashboard SPA) with SPA fallback
```

Read endpoints (`/api/query|timeseries|summary|config`) are cached 30s via the Cache API.

### Query dimensions (whitelist)

`path, referrer_domain, country, browser, browser_version, os, os_version, device_type, device_vendor, device_model`. Filters use `dimension:value` tokens in `filter=` (include) / `exclude=`.

`group_by` accepts up to 3 comma-separated dimensions (`group_by=device_type,device_vendor,device_model`), returning whole tuples as `{ keys: [...], value }` instead of `{ key, value }`. The sunburst uses this: it previously fanned out one request per node — up to 261 requests and 522 full range scans from a single click — and now issues one.

## Configuration (`wrangler.toml [vars]`)

- `ALLOWED_ORIGIN` — the single website allowed to report (plus `127.0.0.1`/`localhost` dev exception)
- `RATE_LIMIT_PER_MINUTE` — documented per-IP ingest cap; the **enforced** value is the `[[ratelimits]]` binding's `limit` (keep in sync)
- `TIMEZONE` — day-boundary timezone (default `Asia/Tokyo`)

Per-IP ingest rate limiting is enforced by the Workers **Rate Limiting binding** (`RATE_LIMITER` in `wrangler.toml`, atomic per-colo). IP is taken **only** from `CF-Connecting-IP` (never client-supplied `x-forwarded-for`).

## Ingestion & bot exclusion

`/api/send` reads UA (server-side), IP, and `request.cf.country`; referrer comes from the beacon payload (`document.referrer`). Bots/AI crawlers are always dropped (`src/ua.js`: regex + ua-parser-js Crawlers extension). Visitor id = first 13 hex of `SHA-256(ip|userAgent)` as a 52-bit int. The event write runs in `ctx.waitUntil`. Dimension ids are resolved via an isolate-global get-or-create cache.

## Retention & rollup (cron)

`scheduled` (cron `30 15 * * *` = 00:30 Asia/Tokyo) is the only trigger — the free plan allows 5 cron triggers **per account** and the deployments already use one each, so adding a second schedule is not available. Each run:

1. **Seals** every closed day not yet sealed, up to yesterday, into all three rollups. Always re-seals the last 2 days (ingest writes are fire-and-forget via `ctx.waitUntil`, so stragglers land late) and resumes from `rollup_max_day` so the sealed window stays contiguous — capped at `MAX_SEAL_DAYS_PER_RUN`.
2. **Extends** coverage backwards a few days (`extendRollupHistory`).
3. **Refreshes** the UV snapshot: 7d/30d nightly, all-time on Sundays.
4. **Archives** raw events older than 6 whole months into `events_monthly_tab`, then deletes the raw rows *and* the rollup rows for those days — leaving them would make the all-time PV card count the month twice.

The archive probe is `SELECT MIN(day) FROM events_tab WHERE day < ?`. It used to be `SELECT DISTINCT (day / 100) ... WHERE (day / 100) < ?`, which wrapped the indexed column in an expression so `idx_events_day` could not be used: a **~1.35M-row full scan every single night**, even when there was nothing to archive. Verified with `EXPLAIN QUERY PLAN` — `SCAN ... USE TEMP B-TREE FOR DISTINCT` became `SEARCH events_tab USING COVERING INDEX idx_events_day (day<?)`.

## The write budget is the tighter constraint

D1's free tier gives **5M rows read/day but only 100K rows written/day, account-wide across every database**. Reads were the presenting problem; writes are the one that silently bites, because **exhausted writes mean ingest drops real pageviews**.

Two rules follow:

- **Indexes are limited by writes, not storage.** D1 bills a written row per index covering an inserted column, so each index on `events_tab` costs one extra write per pageview forever — and *creating* one writes a row per existing row. That is why `idx_events_day_ref` lives in its own opt-in migration (`migrations/add-referrer-index.sql`) rather than the main one: on a 90K-row table it is a 90K-write statement, most of a day's budget in one go. Check `rows_written_24h` for **every** database with `wrangler d1 info` before adding one.
- **Never spend a write where a read will do.** `getDimId` (`src/index.js`) reads before writing. It used to be a single `INSERT ... ON CONFLICT DO UPDATE SET value=excluded.value RETURNING id`, which on conflict rewrote the row and its unique index entry to the value they already held — ~2 wasted writes × 10 dimensions on every isolate-cache miss. Dimension values are tiny, stable sets that nearly always already exist, so this dominated ingest cost. The `SELECT` → `INSERT ... DO NOTHING RETURNING id` → `SELECT` sequence is race-safe (verified with concurrent inserts of the same new value producing exactly one row) and turns the common path read-only.

Before any change that touches ingest, estimate writes per pageview. The floor is 4 (one `events_tab` row + its three indexes).

## Path normalization

`normalizePath` (`src/index.js`): full URLs → pathname; strip query/hash; remove `/index.html`, `/index`, `/_index`; strip `/zh-cn/`, `/zh-tw/`, `/en/` language prefixes; always append trailing slash.

## Local development

```bash
pnpm install                              # root deps (ua-parser-js, wrangler)
pnpm --dir dashboard-v2 install
pnpm --dir dashboard-v2 build             # produce dashboard-v2/dist (needed for [assets])
wrangler d1 execute cloudflare_stats_db --local --file=schema.sql
wrangler dev --test-scheduled             # http://127.0.0.1:8787
node check.js                             # quick-check (STATS_HOST to target remote)
bash scripts/verify.sh <url>             # step-by-step verification (needs jq)
```

### Proving the rollups changed no numbers

`scripts/verify-rollup.mjs` computes ground truth straight from the raw events in a dump and diffs it against the API. Every dimension is checked twice — once as served (rollup path) and once with a no-op `exclude` token that forces the raw path — and both must equal ground truth.

```bash
wrangler d1 execute cloudflare_stats_db --local --file=schema.sql
grep '^INSERT' prod_backup.sql > /tmp/data.sql
wrangler d1 execute cloudflare_stats_db --local --file=/tmp/data.sql
wrangler dev --test-scheduled &
curl "http://127.0.0.1:8787/__scheduled?cron=30+15+*+*+*"   # seal; run twice to extend coverage
node scripts/verify-rollup.mjs
```

Note miniflare's local D1 does **not** report `meta.rows_read` — only `duration`. Verify access paths locally with `EXPLAIN QUERY PLAN`, and measure real rows read against the deployment with `wrangler d1 insights --sort-by reads`.

### Exporting for local analysis

```bash
bash scripts/export.sh
```

Dumps the remote database, builds a local SQLite copy with extra indexes (free locally), and prints DuckDB usage. This is the intended home for anything the rollups deliberately cannot answer — cross-filtered breakdowns, arbitrary cohorts, long-range exploration — so exploratory queries never touch production quota. Notably, general 2-dimension pair rollups were rejected on measurement: `country x path` compresses only ~2x (43% of pageviews are their own unique tuple), so the 45 pairs would be several times larger than `events_tab` itself.

Dashboard-only dev with API proxy: `pnpm --dir dashboard-v2 dev` (proxies `/api` to `wrangler dev` on :8787).

## Deployment

```bash
python scripts/manage.py init
```

## Client integration

```html
<script defer src="https://stats.example.com/report.js"></script>
```

The beacon POSTs `{ path, referrer }` to `/api/send` via `XMLHttpRequest` (a single transport — `sendBeacon` is avoided because its `true` return only means "queued", so a blocker that neuters it looks like success).

## Notes

- The V1 KV-counter model, `/api/count|stats|batch|top|daily`, and `src/dashboard.js` were removed in V2. Old D1 tables `page_stats`/`site_daily_stats` remain in `schema.sql` as an optional read-only pre-V2 baseline.
- The dashboard is **English only**.
- Package manager is **pnpm**; the worker bundles `ua-parser-js` via Wrangler's esbuild (needs `compatibility_flags = ["nodejs_compat"]`).
