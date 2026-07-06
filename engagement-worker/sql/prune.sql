-- Retention / TTL — prune ONLY orphan anonymous sessions and their events.
--
-- A linked session (user_id IS NOT NULL) belongs to a registered account; its history is
-- the user's and is NEVER auto-pruned. Bind ?1 to a cutoff timestamp (ms since epoch),
-- e.g. now - 180 days. Run on a schedule (a Worker cron or a `wrangler d1 execute` job).
--
--   wrangler d1 execute makerperks-engagement --file=sql/prune.sql \
--     --param "$(node -e 'process.stdout.write(String(Date.now()-180*864e5))')"

DELETE FROM events
WHERE session_id IN (
  SELECT session_id FROM sessions
  WHERE user_id IS NULL AND created_at < ?1
);

DELETE FROM sessions
WHERE user_id IS NULL AND created_at < ?1;
