-- Add signalCount column to cron_runs — tracks how many new signals
-- were ingested during each cron run window.
ALTER TABLE cron_runs ADD COLUMN signalCount INTEGER;
