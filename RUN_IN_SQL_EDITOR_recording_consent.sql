-- =============================================================================
-- RUN THIS IN THE SUPABASE SQL EDITOR
-- Feature: two-sided consent for AI-notes recording.
-- Mirrors migration 20260724050000_recording_consent_signals.sql.
-- Safe to run more than once (idempotent).
-- =============================================================================

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
