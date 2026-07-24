-- =============================================================================
-- Two-sided consent for AI-notes recording.
--
-- Before this, the recorder only ticked a self-attestation checkbox ("I have
-- my partner's agreement") — the other participant was never actually asked.
-- That is meaningless consent: one person clicks a box and recording starts.
--
-- Fix: the recorder now *asks* the other participant, who accepts or declines
-- on their own screen, and capture only begins on an explicit accept.
--
-- This uses the same RLS-gated-table + postgres_changes pattern as
-- call_decline_signals (migration 20260523040000) rather than Realtime
-- Broadcast, and for the same reason: an "accept" drives a real action on the
-- asker's client (it starts a recording), so a forged accept is the dangerous
-- direction. Broadcast has no sender authentication — anyone who knew a
-- sessionId could push a fake accept and make an honest client record without
-- the peer ever agreeing. RLS on this table means only a genuine participant
-- of the session can write a consent row, so the accept can only come from the
-- real other party.
-- =============================================================================


-- ─── 1. Signal table ─────────────────────────────────────────────────────────
--
-- One row per consent event. `kind` is the event: 'request' (asker wants to
-- record), 'accept' / 'decline' (the peer's answer). `from_user_id` is who
-- produced the event. There are only ever two participants, so the receiver
-- resolves "who" from the session — the row doesn't carry a display name.

CREATE TABLE IF NOT EXISTS public.recording_consent_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'accept', 'decline')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recording_consent_signals_session_idx
  ON public.recording_consent_signals (session_id, created_at DESC);
ALTER TABLE public.recording_consent_signals ENABLE ROW LEVEL SECURITY;

-- ─── 2. RLS — write ──────────────────────────────────────────────────────────
--
-- Only authenticated callers, only as themselves, only on sessions they
-- actually participate in, and only while a video call is meaningful
-- (accepted/active). An outsider who doesn't share the session can't satisfy
-- the EXISTS check, so they can't manifest a consent event at all.

DROP POLICY IF EXISTS "Participants emit recording consent" ON public.recording_consent_signals;
CREATE POLICY "Participants emit recording consent" ON public.recording_consent_signals
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = from_user_id
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

-- ─── 3. RLS — read ───────────────────────────────────────────────────────────
--
-- Participants can read their own session's consent rows. This gates the
-- realtime changefeed: a subscriber only receives events RLS lets them SELECT.

DROP POLICY IF EXISTS "Participants view recording consent" ON public.recording_consent_signals;
CREATE POLICY "Participants view recording consent" ON public.recording_consent_signals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

GRANT SELECT, INSERT ON public.recording_consent_signals TO authenticated;
GRANT ALL ON public.recording_consent_signals TO service_role;

-- ─── 4. emit_recording_consent RPC ───────────────────────────────────────────
--
-- Thin SECURITY INVOKER wrapper for the INSERT so clients can call it without
-- the generated Supabase types needing a regen for the new table. Running as
-- INVOKER means the RLS policy above still applies — the RPC is just the call
-- shape.

CREATE OR REPLACE FUNCTION public.emit_recording_consent(p_session_id UUID, p_kind TEXT)
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
  IF p_kind NOT IN ('request', 'accept', 'decline') THEN
    RAISE EXCEPTION 'Invalid consent kind: %', p_kind;
  END IF;
  INSERT INTO public.recording_consent_signals (session_id, from_user_id, kind)
  VALUES (p_session_id, v_caller, p_kind);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.emit_recording_consent(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_recording_consent(UUID, TEXT) TO authenticated;

-- ─── 5. Enable realtime replication ──────────────────────────────────────────
--
-- postgres_changes only fires for tables in the supabase_realtime publication.
-- Guarded DO so re-running the migration is safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'recording_consent_signals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.recording_consent_signals;
  END IF;
END $$;
