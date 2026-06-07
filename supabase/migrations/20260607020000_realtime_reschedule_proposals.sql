-- =============================================================================
-- Realtime for reschedule_proposals.
--
-- When one party accepts / rejects / withdraws a reschedule, the other party's
-- dashboard "Up next" panel kept showing the stale pending state until a manual
-- refresh. A reject in particular changes nothing on the sessions row (which IS
-- in the realtime publication), so there was no signal at all for the proposer.
--
-- Add reschedule_proposals to the supabase_realtime publication so the client
-- can subscribe to INSERT/UPDATE on a session's proposals and refresh live.
-- REPLICA IDENTITY FULL so UPDATE events ship the full row (the client filters
-- the changefeed by session_id, which is not the primary key).
--
-- Idempotent: guarded DO block, safe to re-run.
-- =============================================================================

ALTER TABLE public.reschedule_proposals REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'reschedule_proposals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reschedule_proposals;
  END IF;
END $$;
