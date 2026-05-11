-- When a teacher reschedules a session, drop any existing
-- 'session_starting' notification for that session_id so the next sweep can
-- re-issue it for the new time.
--
-- Background: notify_upcoming_sessions() is idempotent per session_id (it
-- skips sessions that already have a 'session_starting' notification). That
-- prevents duplicates, but also means rescheduling leaves a stale "starts in
-- 5 min" notification stuck in the user's bell pointing at the old time.
-- Clearing on UPDATE OF scheduled_at lets the sweeper fire fresh.
--
-- We also drop them when the session leaves the 'accepted' state (cancelled,
-- rejected, completed) so users don't see "starts in N min" for a session
-- that's no longer happening.

CREATE OR REPLACE FUNCTION public.cleanup_session_starting_notifications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Reschedule, cancellation, completion, or rejection — any of these means
  -- the existing 'session_starting' notification for this session is stale.
  IF (TG_OP = 'UPDATE' AND NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at)
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
         AND NEW.status IN ('cancelled', 'rejected', 'completed'))
  THEN
    DELETE FROM public.notifications
    WHERE type = 'session_starting'
      AND metadata ->> 'session_id' = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sessions_cleanup_starting_notifications ON public.sessions;
CREATE TRIGGER sessions_cleanup_starting_notifications
  AFTER UPDATE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_session_starting_notifications();
REVOKE EXECUTE ON FUNCTION public.cleanup_session_starting_notifications() FROM PUBLIC, anon, authenticated;
