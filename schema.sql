-- cloudflare-stats-worker V2 schema (database: cloudflare_stats_db)
-- Naming convention: database uses "_db" suffix, every table uses "_tab" suffix.
--
-- Storage model:
--   * events_tab        raw one-row-per-pageview fact table (hot 6-month window)
--   * dim_*_tab         dictionary/lookup tables (categorical dimensions -> integer FK)
--   * site_daily_tab    per-day PV/UV rollup (headline cards + trend chart)
--   * dim_daily_tab     per-day, per-dimension rollup (dimension breakdowns)
--   * hier_daily_tab    per-day rollup of the 3 drill-down hierarchies (sunburst)
--   * meta_tab          rollup coverage bounds + periodic all-time UV snapshot
--   * events_monthly_tab archive of data older than 6 months (EAV long-format)
--
-- PV  = COUNT(*) over events_tab.
-- UV  = COUNT(DISTINCT visitor_id) over events_tab (not additive across dimensions,
--       which is why raw visitor_id rows are kept for the hot window).
--
-- READ PATH: no dashboard endpoint scans the full events_tab. The rollups cover
-- every sealed (past) day; today is read live from events_tab and merged in at
-- query time. events_tab is scanned over the whole range only when a query is
-- filtered, or asks for exact unique visitors across more than one day.

-- ---------------------------------------------------------------------------
-- Dimension lookup tables (dictionary encoding)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_path_tab          (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_ref_domain_tab    (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_country_tab       (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_browser_tab       (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_browser_ver_tab   (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_os_tab            (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_os_ver_tab        (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_device_type_tab   (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_device_vendor_tab (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dim_device_model_tab  (id INTEGER PRIMARY KEY, value TEXT UNIQUE NOT NULL);

-- ---------------------------------------------------------------------------
-- Raw event fact table (one row per non-bot pageview)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events_tab (
  id               INTEGER PRIMARY KEY,   -- rowid
  day              INTEGER NOT NULL,      -- yyyymmdd in configured TZ, e.g. 20260719
  visitor_id       INTEGER NOT NULL,      -- first 13 hex of SHA-256(ip|ua) as 52-bit int
  path_id          INTEGER NOT NULL,
  ref_domain_id    INTEGER,               -- NULL = direct / no referrer
  country_id       INTEGER,
  browser_id       INTEGER,
  browser_ver_id   INTEGER,               -- low-priority
  os_id            INTEGER,
  os_ver_id        INTEGER,               -- low-priority
  device_type_id   INTEGER,
  device_vendor_id INTEGER,               -- low-priority
  device_model_id  INTEGER                -- low-priority
);

-- Keep indexes deliberately few -- and the reason is WRITES, not storage. D1
-- bills one written row per index that covers an inserted column, so every
-- index here adds a row to the cost of every single pageview. At 7.5K PV/day
-- the four below already cost ~30K of the 100K/day free write budget; a fifth
-- would be ~7.5K more. Reads are handled by dim_daily_tab instead, which is
-- where the leverage actually is.
--
-- These composite (day, <dim>) indexes only matter on the raw-scan fallback
-- path (filtered queries and multi-day metric=visitors). `ref_domain_id` earns
-- its slot because referrer is the dimension people actually filter on; the
-- rest are served from the rollup and never scan events_tab.
CREATE INDEX IF NOT EXISTS idx_events_day         ON events_tab(day);
CREATE INDEX IF NOT EXISTS idx_events_day_country ON events_tab(day, country_id);
CREATE INDEX IF NOT EXISTS idx_events_day_path    ON events_tab(day, path_id);
CREATE INDEX IF NOT EXISTS idx_events_day_ref     ON events_tab(day, ref_domain_id);

-- ---------------------------------------------------------------------------
-- Per-day site rollup (headline cards + trend chart, filled nightly by cron)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_daily_tab (
  day INTEGER PRIMARY KEY,   -- yyyymmdd
  pv  INTEGER NOT NULL DEFAULT 0,
  uv  INTEGER NOT NULL DEFAULT 0   -- exact per-day distinct visitors
);

-- ---------------------------------------------------------------------------
-- Per-day, per-dimension rollup -- the read path for dimension breakdowns.
--
-- This is what keeps the dashboard inside D1's free 5M rows/day. Measured
-- against a real 4-day production snapshot (prod_backup.sql), a day of traffic
-- collapses to ~440 rollup rows across all ten dimensions; extrapolated to
-- 7.5K PV/day that is ~700 rows/day, ~126K rows over the 180-day window --
-- roughly 11x smaller than events_tab. A 7-day `browser` breakdown reads ~150
-- rollup rows instead of ~52,500 raw events.
--
-- SEALED DAYS ONLY. A row here is written once, by the nightly cron, after the
-- day has closed; it is never incremented. Today is always read live from
-- events_tab and UNIONed in at query time. That choice matters:
--   * Zero extra writes per pageview. D1's free tier allows 100K rows written
--     per day and ingest already spends ~30K of it on events_tab + its
--     indexes; maintaining this table at ingest time would cost ~14 more rows
--     per pageview and blow the write budget outright.
--   * Today stays real-time exact rather than lagging a refresh interval.
--   * It needs no extra cron trigger (the free plan allows only 5 per account
--     and the three deployments already use one each).
--   * A closed date range touches zero raw rows, so it is cacheable for a day.
--
-- Key order (dimension, day, value_id) makes "one dimension over a date range"
-- a single contiguous PK range scan: it reads exactly the rows it returns.
-- Ordering by day first would make a 30-day `os` query scan all ten
-- dimensions' rows (~21,000) instead of ~150.
--
-- WITHOUT ROWID keeps each upsert to exactly one written row: a rowid table
-- would carry a separate PK index and bill two.
--
-- value_id 0 is the sentinel for "dimension absent" ((direct) / (unknown)).
-- It cannot be NULL: SQLite compares NULLs as distinct in a unique index, so a
-- NULL key would never match ON CONFLICT and would silently duplicate rows.
-- Real dim_*_tab ids start at 1, so 0 is unambiguous.
--
-- PV ONLY. A `uv` column here would be exact per (dimension, value, day) but is
-- not summable across days, and summing it across a hierarchy's deeper levels
-- would over-count too -- both silent. Unique visitors are therefore always
-- answered from events_tab and stay exact. Per-day site-wide UV, which is all
-- the trend chart and headline cards need, already lives in site_daily_tab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_daily_tab (
  dimension TEXT    NOT NULL,   -- key of DIMENSIONS in src/index.js
  day       INTEGER NOT NULL,   -- yyyymmdd
  value_id  INTEGER NOT NULL,   -- FK into the matching dim_*_tab; 0 = unknown/direct
  pv        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dimension, day, value_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Per-day rollup of the three drill-down hierarchies, as whole tuples.
--
-- The sunburst is the single most expensive interaction in the app: it fans out
-- one query per node, up to 261 requests / 522 full range scans from one click.
-- Tuples cannot be reconstructed from dim_daily_tab, so they are stored.
--
-- This is only affordable because these are near-functional dependencies --
-- measured on the production snapshot, all three hierarchies together add just
-- ~160 rows/day. (Near, not exact: dim_browser_ver_tab stores bare version
-- strings like "17.0" that several browsers share, which is precisely why the
-- pair has to be materialised rather than derived.)
--
-- General 2-dimension pair rollups are deliberately NOT built: measured
-- country x path compresses only ~2x (43% of pageviews are their own unique
-- tuple), so the 45 pairs would be several times larger than events_tab itself.
-- Cross-filtered exploration belongs in the local export instead (see CLAUDE.md).
--
-- k* use the same 0 sentinel; k2 is 0 for the two-level hierarchies. PV only,
-- for the same reason as dim_daily_tab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hier_daily_tab (
  hier TEXT    NOT NULL,   -- 'browser', 'os', 'device' (keys of HIERARCHIES in src/index.js)
  day  INTEGER NOT NULL,
  k0   INTEGER NOT NULL,
  k1   INTEGER NOT NULL,
  k2   INTEGER NOT NULL DEFAULT 0,
  pv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hier, day, k0, k1, k2)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Small key/value store for rollup bookkeeping and periodic snapshots.
--   rollup_min_day   earliest day the rollups cover; a query starting before
--                    this bypasses them entirely rather than under-reporting
--   rollup_max_day   latest sealed day (normally yesterday)
--   uv_snapshot      JSON { as_of, uv } -- all-time distinct visitors over the
--                    hot window. Refreshed WEEKLY, not nightly: the statement
--                    is a full COUNT(DISTINCT) over events_tab (~27% of the
--                    daily read budget), and the number moves <1%/day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta_tab (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Monthly archive for data older than 6 months (raw rows pruned after rollup)
-- EAV long-format: one row per (month, dimension, value).
-- uv is EXACT per single (dimension,value) but is NOT summable and NOT
-- cross-filterable across dimensions -- that detail is destroyed on prune.
-- pv is additive but we still do not cross-tabulate it (tuples not stored).
-- The per-month grand total lives in the ('total','') row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events_monthly_tab (
  month     INTEGER NOT NULL,   -- yyyymm
  dimension TEXT    NOT NULL,   -- 'total','path','referrer_domain','country',
                                -- 'browser','browser_version','os','os_version',
                                -- 'device_type','device_vendor','device_model'
  value     TEXT    NOT NULL,   -- dimension value; '' for the 'total' row
  pv        INTEGER NOT NULL DEFAULT 0,
  uv        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, dimension, value)
);

CREATE INDEX IF NOT EXISTS idx_events_monthly_dim ON events_monthly_tab(month, dimension);
-- The all-time card sums WHERE dimension = 'total', which cannot use the index
-- above (its leading column is `month`). This one makes that lookup a point scan.
CREATE INDEX IF NOT EXISTS idx_events_monthly_total ON events_monthly_tab(dimension, month);

-- ---------------------------------------------------------------------------
-- Legacy V1 tables (pre-V2 baseline). Retained read-only for historical
-- totals only -- they carry no dimensions and are not written by V2.
-- Safe to drop if pre-V2 history is not needed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_stats (
  path TEXT PRIMARY KEY,
  pv INTEGER NOT NULL DEFAULT 0,
  uv INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_daily_stats (
  date TEXT PRIMARY KEY,
  pv INTEGER NOT NULL DEFAULT 0,
  uv INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
