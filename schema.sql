-- cloudflare-stats-worker V2 schema (database: cloudflare_stats_db)
-- Naming convention: database uses "_db" suffix, every table uses "_tab" suffix.
--
-- Storage model:
--   * events_tab        raw one-row-per-pageview fact table (hot 6-month window)
--   * dim_*_tab         dictionary/lookup tables (categorical dimensions -> integer FK)
--   * site_daily_tab    per-day PV/UV rollup (fast headline cards + trend)
--   * events_monthly_tab archive of data older than 6 months (EAV long-format)
--
-- PV  = COUNT(*) over events_tab.
-- UV  = COUNT(DISTINCT visitor_id) over events_tab (not additive across dimensions,
--       which is why raw visitor_id rows are kept for the hot window).

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

-- Keep indexes deliberately few (each ~30 MB at 6 months). One day is only
-- ~10k rows, so day-scoped scans + GROUP BY on any dimension stay cheap.
CREATE INDEX IF NOT EXISTS idx_events_day         ON events_tab(day);
CREATE INDEX IF NOT EXISTS idx_events_day_country ON events_tab(day, country_id);
CREATE INDEX IF NOT EXISTS idx_events_day_path    ON events_tab(day, path_id);

-- ---------------------------------------------------------------------------
-- Per-day site rollup (headline cards + trend chart, filled nightly by cron)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_daily_tab (
  day INTEGER PRIMARY KEY,   -- yyyymmdd
  pv  INTEGER NOT NULL DEFAULT 0,
  uv  INTEGER NOT NULL DEFAULT 0   -- exact per-day distinct visitors
);

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
