-- =============================================================================
-- Security #7 — Realtime call spoofing (decline path).
--
-- The video route listened on Supabase Realtime Broadcast channel
-- `call-decline-<sessionId>` for a `call_declined` event. Broadcast channels
-- have no sender authentication: any authenticated user who knows (or
-- guesses) a sessionId could send a fake decline and force the legitimate
-- caller out of an in-progress Jitsi room.
--
-- Fix: move the decline signal off broadcast and onto an RLS-gated table.
-- The sender INSERTS a row; the receiver subscribes to postgres_changes on
-- that row. RLS ensures only real participants of the session can write a
-- decline row, and only participants can read it back, so an outsider
-- can't manifest a decline event at all.
--
-- The ringing event stays on broadcast because it's truly ephemeral and
-- doesn't drive a destructive UI action — the client-side fix tightens
-- that path by validating the payload against the sessions table before
-- showing the toast.
-- =============================================================================


-- ─── 1. Signal table ─────────────────────────────────────────────────────────
--
-- One row per decline event. We keep them in the table briefly (a janitor
-- job in a follow-up migration can sweep > 24h old) so the realtime
-- changefeed has something concrete to filter on. The unique constraint
-- on (session_id, decliner_id) is intentionally absent — a flaky network
-- or double-tap should be idempotent on the receiver side, not error here.

CREATE TABLE IF NOT EXISTS public.call_decline_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  decliner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_decline_signals_session_idx
  ON public.call_decline_signals (session_id, created_at DESC);
ALTER TABLE public.call_decline_signals ENABLE ROW LEVEL SECURITY;
-- ─── 2. RLS — write ──────────────────────────────────────────────────────────
--
-- Only authenticated callers may insert, only as themselves, only on
-- sessions they actually participate in, and only while the session is
-- in a state where a video call is meaningful (accepted/active). This
-- collectively kills the spoof: an attacker who doesn't share a session
-- with the victim cannot satisfy the EXISTS check.

DROP POLICY IF EXISTS "Participants emit decline" ON public.call_decline_signals;
CREATE POLICY "Participants emit decline" ON public.call_decline_signals
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = decliner_id
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- ─── 3. RLS — read ───────────────────────────────────────────────────────────
--
-- Participants can read their own session's decline rows. This is what
-- gates the realtime changefeed: a subscriber filtering by session_id
-- only receives events when RLS lets them SELECT the row.

DROP POLICY IF EXISTS "Participants view decline" ON public.call_decline_signals;
CREATE POLICY "Participants view decline" ON public.call_decline_signals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- Service role keeps full access for sweepers/admin tooling.
GRANT SELECT, INSERT ON public.call_decline_signals TO authenticated;
GRANT ALL ON public.call_decline_signals TO service_role;
-- ─── 4. emit_call_decline RPC ────────────────────────────────────────────────
--
-- Wrapper for the INSERT so clients can call this without the generated
-- Supabase types needing a regen for the new table. The RPC enforces the
-- same RLS constraints inline (caller identity + participant + status)
-- because it runs as SECURITY INVOKER — the policy still applies.

CREATE OR REPLACE FUNCTION public.emit_call_decline(p_session_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  INSERT INTO public.call_decline_signals (session_id, decliner_id)
  VALUES (p_session_id, v_caller);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.emit_call_decline(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_call_decline(UUID) TO authenticated;
-- ─── 5. Enable realtime replication ──────────────────────────────────────────
--
-- Realtime postgres_changes only fires for tables explicitly added to the
-- `supabase_realtime` publication. Wrapped in a guarded DO so re-running
-- the migration is safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'call_decline_signals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.call_decline_signals;
  END IF;
END $$;
