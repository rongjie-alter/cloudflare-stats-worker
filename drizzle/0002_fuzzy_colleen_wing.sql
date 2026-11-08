-- events_monthly_tab is gone: site_daily_tab now keeps its rows after the raw
-- events are pruned, and the all-time cards read only that. DROP TABLE bills 0
-- written rows. It discards any month already folded into the table, so check
-- SELECT COUNT(*) FROM events_monthly_tab is 0 before applying it remotely.
DROP TABLE `events_monthly_tab`;