# Cloudflare Stats Worker (V2)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Self-hosted, cookieless website analytics on Cloudflare Workers — rich per-pageview
> dimensions (OS, browser, device, country, referrer), bot exclusion, and a preact
> dashboard with free filtering, drill-down, and a country map.

---

## Highlights

- **Edge-native** — one Worker serves the ingest + query API *and* the dashboard SPA (Workers Static Assets).
- **Rich dimensions** — OS, OS version, browser, browser version, device type/vendor/model, country, referrer (domain + path).
- **Cookieless & bot-free** — visitor id = truncated `SHA-256(ip|ua)`; bots/AI crawlers are always excluded (`ua-parser-js`).
- **D1 as source of truth** — raw event fact table gives exact PV **and** UV under arbitrary filtering.
- **Retention that fits** — day-level detail for 6 months, auto-archived to month-level by a nightly cron; designed to stay well under 500 MB at 10k pv/day.
- **Reusable** — one site per deployment via config: worker domain, allowed origin, rate limit, timezone.

---

## Architecture

```
Browser (allowed site) ──beacon.js──► POST /api/collect ──► D1 events_tab (1 row/pageview)
Dashboard SPA at /  ◄── Static Assets ── Worker
  └─ /api/query · /api/timeseries · /api/summary · /api/config ──► D1 (SELECT/GROUP BY)
Cron (nightly) ──► refresh site_daily_tab, archive+prune >6mo ──► events_monthly_tab
```

- **PV** = `COUNT(*)`, **UV** = `COUNT(DISTINCT visitor_id)` over `events_tab`.
- Because UV isn't additive across dimensions, `total` for the visitors metric is computed over the whole filtered set (never summed from groups).

See [`CLAUDE.md`](CLAUDE.md) for the full schema, key files, and conventions.

---

## Quick start

Prerequisites: Node 18+, **pnpm**, a Cloudflare account, `wrangler`.

```bash
git clone <this-repo> && cd cloudflare-stats-worker
bash scripts/install.sh      # interactive: creates D1, applies schema, builds dashboard, deploys
```

The installer prompts for the worker name, worker domain, allowed website origin, rate limit, and timezone, then writes `wrangler.toml` and deploys.

### Manual setup

```bash
pnpm install                              # root deps (ua-parser-js, wrangler)
wrangler d1 create cloudflare_stats_db    # -> put database_id in wrangler.toml
wrangler d1 execute cloudflare_stats_db --remote --file=schema.sql

pnpm --dir dashboard-v2 install
pnpm --dir dashboard-v2 build             # -> dashboard-v2/dist
wrangler deploy
```

Edit `wrangler.toml` `[vars]` to set `WORKER_DOMAIN`, `ALLOWED_ORIGIN`, `RATE_LIMIT_PER_MINUTE`, `TIMEZONE`.

---

## Add the beacon to your site

```html
<script defer src="https://stats.example.com/beacon.js"></script>
```

It POSTs `{ path, referrer }` to `/api/collect` via `navigator.sendBeacon`. Only requests whose `Origin` matches `ALLOWED_ORIGIN` (or `127.0.0.1`/`localhost` in dev) are accepted.

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/collect` | Ingest one pageview. Origin-restricted; bots dropped. → `204` |
| `GET` | `/api/query` | Grouped breakdown: `metric`, `from`, `to`, `group_by`, `filter`, `exclude`, `limit` |
| `GET` | `/api/timeseries` | Daily trend: `metric`, `from`, `to`, `filter`, `exclude` |
| `GET` | `/api/summary` | Headline cards (today / 7d / 30d / all-time) |
| `GET` | `/api/config` | `{ timezone }` |
| `GET` | `/health` | `{ status, version, timestamp }` |
| `*` | | Dashboard SPA (static assets) |

**Dimensions:** `path, referrer_domain, referrer_path, country, browser, browser_version, os, os_version, device_type, device_vendor, device_model`.

Example:

```
/api/query?metric=visitors&from=2026-01-01&to=2026-06-30&group_by=country&filter=browser:Chrome&exclude=country:XX&limit=20
```

---

## Dashboard

English-only preact SPA (AG Grid + Apache ECharts). Metric switcher (Visitors / Page Views), time-range shortcuts (Today / Yesterday / Last 7 / Last 28 days), dark-light toggle, a trend chart, and six panels (Referrer, Path, Country, Browser, OS, Device type). Hover a panel row to **filter** or **exclude** that value; every panel updates. Each panel expands into a drill-down drawer with an AG Grid table and — for Country — an ECharts world map keyed by ISO-2.

---

## Local development

```bash
wrangler d1 execute cloudflare_stats_db --local --file=schema.sql
pnpm --dir dashboard-v2 build     # or: pnpm --dir dashboard-v2 dev  (proxies /api to :8787)
wrangler dev                      # http://127.0.0.1:8787
node check.js                     # quick-check (STATS_HOST=... to target remote)
bash scripts/verify.sh http://127.0.0.1:8787
```

---

## Retention

Raw events are kept day-level for ~6 months. A nightly cron (`30 15 * * *`, i.e. 00:30 Asia/Tokyo) refreshes the `site_daily_tab` rollup and archives older months into `events_monthly_tab` (per-dimension PV/UV — exact per single value, but not cross-filterable once the raw rows are pruned), then deletes the raw rows.

---

## License

MIT.
