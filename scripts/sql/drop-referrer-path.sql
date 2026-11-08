-- Remove the referrer_path dimension from a deployed cloudflare_stats_db.
-- Destructive: drops the fact-table column, the dictionary table, and purges
-- archived rows. Run once after deploying the code that stops recording it:
--   wrangler d1 execute cloudflare_stats_db --remote --file=scripts/sql/drop-referrer-path.sql
-- (It also purged events_monthly_tab's referrer_path rows; that table is gone
-- since migration 0002.)
ALTER TABLE events_tab DROP COLUMN ref_path_id;
DROP TABLE IF EXISTS dim_ref_path_tab;
