-- Add the read-path rollups that keep the dashboard inside D1's free tier
-- (5M rows read/day). Non-destructive: creates tables and indexes only.
--
--   wrangler d1 execute cloudflare_stats_db --remote --file=migrations/add-rollup-tables.sql
--
-- Then backfill with migrations/backfill-rollups.sql. See schema.sql for the
-- full rationale behind each table.

-- Per-day, per-dimension rollup. Sealed days only; today is read live and
-- merged at query time. value_id 0 = "(direct)" / "(unknown)".
CREATE TABLE IF NOT EXISTS dim_daily_tab (
  dimension TEXT    NOT NULL,
  day       INTEGER NOT NULL,
  value_id  INTEGER NOT NULL,
  pv        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dimension, day, value_id)
) WITHOUT ROWID;

-- Whole-tuple rollup for the three sunburst hierarchies.
CREATE TABLE IF NOT EXISTS hier_daily_tab (
  hier TEXT    NOT NULL,
  day  INTEGER NOT NULL,
  k0   INTEGER NOT NULL,
  k1   INTEGER NOT NULL,
  k2   INTEGER NOT NULL DEFAULT 0,
  pv   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hier, day, k0, k1, k2)
) WITHOUT ROWID;

-- Rollup coverage bounds + the periodic all-time UV snapshot.
CREATE TABLE IF NOT EXISTS meta_tab (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- The all-time card sums WHERE dimension = 'total'; idx_events_monthly_dim
-- cannot serve that because its leading column is `month`. Cheap: this table is
-- empty until the first month ages out at 6 months.
CREATE INDEX IF NOT EXISTS idx_events_monthly_total ON events_monthly_tab(dimension, month);

-- NOTE: the referrer index is deliberately NOT here -- see
-- migrations/add-referrer-index.sql. Building an index writes one row per
-- existing table row, so on a large events_tab it can consume most of a day's
-- 100K free write budget in one statement, and blocked writes mean DROPPED
-- PAGEVIEWS. It is an opt-in, sized per database.
