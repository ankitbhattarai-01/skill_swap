-- =============================================================================
-- 'stop' recording signal for dual-sided AI-notes capture.
--
-- Recording is now dual-sided: each participant's device records its own mic.
-- When the initiator stops (or leaves the call), the peer's client must stop
-- its silent companion capture and upload its leg. That "stop" rides the same
-- RLS-gated recording_consent_signals table as the request/accept/decline
-- handshake (migration 20260724050000) rather than Realtime Broadcast: a stop
-- makes the peer's client UPLOAD recorded audio, so only a genuine participant
-- of the session may be able to trigger it.
--
-- Two changes: the kind CHECK constraint learns 'stop', and the
-- emit_recording_consent RPC's allow-list learns it too.
-- =============================================================================

ALTER TABLE public.recording_consent_signals
  DROP CONSTRAINT IF EXISTS recording_consent_signals_kind_check;
ALTER TABLE public.recording_consent_signals
  ADD CONSTRAINT recording_consent_signals_kind_check
  CHECK (kind IN ('request', 'accept', 'decline', 'stop'));

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
  IF p_kind NOT IN ('request', 'accept', 'decline', 'stop') THEN
    RAISE EXCEPTION 'Invalid consent kind: %', p_kind;
  END IF;
  INSERT INTO public.recording_consent_signals (session_id, from_user_id, kind)
  VALUES (p_session_id, v_caller, p_kind);
END;
$$;

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC by default privileges, so the
-- revoke from the original migration must be restated here.
REVOKE EXECUTE ON FUNCTION public.emit_recording_consent(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_recording_consent(UUID, TEXT) TO authenticated;
