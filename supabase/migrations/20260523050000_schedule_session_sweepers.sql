-- =============================================================================
-- High #11 — Missing scheduled jobs.
--
-- The codebase has three sweeper functions that nothing currently invokes:
--
--   move_due_sessions_to_review()    (20260512060000)
--     Moves accepted/active sessions to pending_review once their scheduled
--     end has passed. Without this, sessions stay in 'accepted' forever and
--     the review/auto-settle path never starts.
--
--   settle_pending_review_sessions() (20260512060000)
--     Reads attendance and finalises any pending_review session that has
--     sat undisputed for 24h. Without this, escrow never releases and the
--     credits never reach the teacher's balance.
--
--   notify_upcoming_sessions()       (20260508070000)
--     Inserts the 10-min reminder notifications for both parties. Without
--     this, participants get no in-app heads-up before a call.
--
-- Two earlier migrations (20260511040000_lock_sweep_rpcs_to_service_role and
-- 20260512060000) revoked the authenticated grant on these functions and
-- restricted them to service_role, on the explicit assumption that a
-- scheduler would call them. That scheduler never landed in the repo, so
-- in practice the dashboards / chats / billing all silently broke past
-- their scheduled-end times.
--
-- pg_cron lives in the `extensions` schema on Supabase. We schedule each
-- sweeper as a SECURITY DEFINER call (the functions already are), so the
-- cron worker — running as the postgres role — invokes them with the
-- privileges of the function owner regardless of role.
--
-- Cadence rationale:
--   * notify_upcoming: every minute. The reminder fires inside a 10-min
--     window before scheduled_at and the function is idempotent (it skips
--     sessions that already have a notification row), so polling cheaply
--     is fine. Most ticks are no-ops.
--   * move_due_to_review: every 5 minutes. The sweeper itself adds a
--     5-min grace for clock skew, so a 5-min cadence means a session is
--     in pending_review at most 10 min after its scheduled end.
--   * settle_pending_review: every 15 minutes. The 24h dispute window is
--     generous; missing a settlement by up to 15 min is fine.
-- =============================================================================


-- ─── 1. Ensure pg_cron is available ──────────────────────────────────────────
--
-- On Supabase, pg_cron is installed but not always created in the target
-- database. The CREATE EXTENSION line is a no-op if it already exists.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
-- ─── 2. Schedule the sweepers ────────────────────────────────────────────────
--
-- cron.schedule(jobname, schedule, command) replaces any existing job with
-- the same jobname, so this migration is safe to re-run (and to ship to
-- environments that may already have a manually-created job by the same
-- name).

SELECT cron.schedule(
  'skillswap-notify-upcoming-sessions',
  '* * * * *',
  $$SELECT public.notify_upcoming_sessions();$$
);
SELECT cron.schedule(
  'skillswap-move-due-sessions-to-review',
  '*/5 * * * *',
  $$SELECT public.move_due_sessions_to_review();$$
);
SELECT cron.schedule(
  'skillswap-settle-pending-review-sessions',
  '*/15 * * * *',
  $$SELECT public.settle_pending_review_sessions();$$
);
-- ─── 3. Operator notes ───────────────────────────────────────────────────────
--
-- Inspecting / pausing schedules:
--
--   SELECT jobid, jobname, schedule, active FROM cron.job
--     WHERE jobname LIKE 'skillswap-%';
--
--   SELECT cron.unschedule('skillswap-notify-upcoming-sessions');
--
-- Inspecting recent runs:
--
--   SELECT jobid, runid, status, return_message, start_time
--     FROM cron.job_run_details
--     WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'skillswap-%')
--     ORDER BY start_time DESC
--     LIMIT 50;
--
-- If your Supabase project doesn't enable pg_cron (free tier in some
-- regions), comment out section 2 and point an external scheduler at the
-- sweeper functions via PostgREST RPC + the service-role key. Same
-- functions, same cadence; just a different invoker.
