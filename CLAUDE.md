# cloudflare-stats-worker (V2)

Self-hosted, cookieless website analytics on Cloudflare Workers. Records rich per-pageview dimensions (OS, browser, device, country, referrer) with bot exclusion, and serves a preact dashboard. Reusable per-website via config.

## Architecture

A single worker (`src/index.js`) handles the ingest + query API and serves the dashboard SPA from **Workers Static Assets**. The dashboard is a separate Vite/preact app built into `dashboard-v2/dist`.

**Storage:**
- **D1 (`DB`, database `cloudflare_stats_db`)** — single source of truth. Raw one-row-per-pageview fact table `events_tab` (hot 6-month window) + dictionary `dim_*_tab` lookup tables + `site_daily_tab` rollup + `events_monthly_tab` archive.

**Metrics:** PV = `COUNT(*)`, UV = `COUNT(DISTINCT visitor_id)` over `events_tab`. UV is not additive across dimensions, which is why raw `visitor_id` rows are kept (enables exact arbitrary-dimension UV).

## Naming convention

D1 database uses a `_db` suffix; every table uses a `_tab` suffix (`events_tab`, `dim_path_tab`, …).

## Key files

| File | Purpose |
|---|---|
| `src/index.js` | Worker: router, ingest, query API, `scheduled` cron, static-asset serving, `normalizePath`, timezone day logic |
| `src/ua.js` | ua-parser-js wrapper: OS/browser/device parse, bot/AI-crawler exclusion, referrer parse |
| `src/config.js` | Reads `[vars]`, origin/CORS enforcement, `localDay`/`localDayOffset` (Intl, tz-aware) |
| `schema.sql` | D1 DDL (`dim_*_tab`, `events_tab`, `site_daily_tab`, `events_monthly_tab`; V1 tables kept as legacy baseline) |
| `report.js` | Client beacon (also shipped from `dashboard-v2/public/report.js` → `/report.js`) |
| `dashboard-v2/` | Vite + preact + AG Grid + ECharts dashboard (English only) |
| `wrangler.toml` | `[vars]`, `[assets]`, `[triggers]` cron, KV + D1 bindings |
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

## Configuration (`wrangler.toml [vars]`)

- `ALLOWED_ORIGIN` — the single website allowed to report (plus `127.0.0.1`/`localhost` dev exception)
- `RATE_LIMIT_PER_MINUTE` — documented per-IP ingest cap; the **enforced** value is the `[[ratelimits]]` binding's `limit` (keep in sync)
- `TIMEZONE` — day-boundary timezone (default `Asia/Tokyo`)

Per-IP ingest rate limiting is enforced by the Workers **Rate Limiting binding** (`RATE_LIMITER` in `wrangler.toml`, atomic per-colo). IP is taken **only** from `CF-Connecting-IP` (never client-supplied `x-forwarded-for`).

## Ingestion & bot exclusion

`/api/send` reads UA (server-side), IP, and `request.cf.country`; referrer comes from the beacon payload (`document.referrer`). Bots/AI crawlers are always dropped (`src/ua.js`: regex + ua-parser-js Crawlers extension). Visitor id = first 13 hex of `SHA-256(ip|userAgent)` as a 52-bit int. The event write runs in `ctx.waitUntil`. Dimension ids are resolved via an isolate-global get-or-create cache.

## Retention & rollup (cron)

`scheduled` (cron `30 15 * * *` = 00:30 Asia/Tokyo) refreshes `site_daily_tab` and archives raw events older than 6 whole months into `events_monthly_tab` (per-dimension PV/UV, exact per single value but not cross-filterable), then deletes the raw rows.

## Path normalization

`normalizePath` (`src/index.js`): full URLs → pathname; strip query/hash; remove `/index.html`, `/index`, `/_index`; strip `/zh-cn/`, `/zh-tw/`, `/en/` language prefixes; always append trailing slash.

## Local development

```bash
pnpm install                              # root deps (ua-parser-js, wrangler)
pnpm --dir dashboard-v2 install
pnpm --dir dashboard-v2 build             # produce dashboard-v2/dist (needed for [assets])
wrangler d1 execute cloudflare_stats_db --local --file=schema.sql
wrangler dev                              # http://127.0.0.1:8787
node check.js                             # quick-check (STATS_HOST to target remote)
bash scripts/verify.sh <url>             # step-by-step verification (needs jq)
```

Dashboard-only dev with API proxy: `pnpm --dir dashboard-v2 dev` (proxies `/api` to `wrangler dev` on :8787).

## Deployment

```bash
bash scripts/install.sh                   # interactive: creates KV/D1, applies schema, builds, writes wrangler.toml, deploys
# or manually:
pnpm --dir dashboard-v2 build && wrangler deploy
wrangler d1 execute cloudflare_stats_db --remote --file=schema.sql   # apply schema
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
