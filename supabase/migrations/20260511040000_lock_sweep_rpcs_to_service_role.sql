-- Stop letting authenticated users run platform-wide sweeps.
--
-- Before: auto_complete_due_sessions() and notify_upcoming_sessions() were
-- granted to `authenticated` and called fire-and-forget on every dashboard
-- load (LOGIC-002 in the audit). Any logged-in user could script a tight
-- loop and force the database to walk every accepted session repeatedly,
-- and the moment of settlement was effectively decided by which client
-- happened to load the dashboard first.
--
-- After: both functions are callable only by service_role. Production must
-- run them on a schedule — either Supabase scheduled cron (pg_cron) or an
-- external scheduled worker hitting the function with the service-role key.
-- The recommended cadence is once per minute for notify_upcoming_sessions
-- (so reminders fire close to their 10-minute window) and once every 15
-- minutes for auto_complete_due_sessions (the 7-day cutoff is generous).

REVOKE EXECUTE ON FUNCTION public.auto_complete_due_sessions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_upcoming_sessions() FROM PUBLIC, anon, authenticated;
