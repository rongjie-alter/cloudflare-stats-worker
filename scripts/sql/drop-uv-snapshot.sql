-- One-off: the nightly UV snapshot is gone (daily UV is read from site_daily_tab).
-- Removes its leftover row. Safe to re-run. Run once per deployment:
--   python scripts/manage.py run-sql scripts/sql/drop-uv-snapshot.sql --all
DELETE FROM meta_tab WHERE key = 'uv_snapshot';
