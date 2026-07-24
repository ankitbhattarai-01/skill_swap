-- =============================================================================
-- Fix: session lifecycle emails never sent because the API gateway blocked the
-- pg_net dispatch.
--
-- Symptom: requesting a session created the in-app notification but no email
-- reached the teacher. The Edge Function `send-session-email` was (re)deployed
-- with JWT verification ENABLED, so Supabase's API gateway rejected every call
-- from `private.dispatch_session_email` with:
--     401 { "code": "UNAUTHORIZED_NO_AUTH_HEADER", "message": "Missing
--           authorization header" }
-- pg_net has no user session, so the trigger sent only the HMAC headers and no
-- `apikey` / `Authorization` — the request never reached the function code.
--
-- Fix (caller side, no redeploy): include the project's PUBLIC publishable key
-- as the `apikey` header so the gateway lets the request through. This is NOT
-- the security boundary — the function still verifies the HMAC-SHA256 signature
-- (X-SkillSwap-Signature) before doing anything, and refuses anything unsigned.
-- The publishable key is already public (it ships in the browser bundle), so
-- embedding it here leaks nothing.
--
-- Doing it on the trigger side (rather than redeploying the function with
-- --no-verify-jwt) means the pipeline keeps working even if the function is
-- later redeployed without that flag.
--
-- Everything else in this function is byte-for-byte identical to
-- 20260518000000_session_email_dispatch.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION private.dispatch_session_email(p_notification_id UUID, p_type TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, extensions
AS $$
DECLARE
  v_config   private.email_dispatch_config%ROWTYPE;
  v_body     TEXT;
  v_ts       TEXT;
  v_sig_hex  TEXT;
BEGIN
  IF p_type NOT LIKE 'session\_%' ESCAPE '\' THEN
    RETURN;
  END IF;

  SELECT * INTO v_config FROM private.email_dispatch_config LIMIT 1;
  IF NOT FOUND THEN
    RAISE NOTICE 'email_dispatch_config not populated; skipping email for notification %', p_notification_id;
    RETURN;
  END IF;

  v_ts := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT::TEXT;
  v_body := jsonb_build_object('notificationId', p_notification_id)::TEXT;
  v_sig_hex := encode(
    extensions.hmac(
      convert_to(v_ts || '.' || v_body, 'UTF8'),
      convert_to(v_config.shared_secret, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := v_config.target_url,
    body := v_body::JSONB,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Public publishable key: satisfies the API gateway only. The HMAC
      -- signature below is the real auth boundary the function checks.
      'apikey', 'sb_publishable_HeEresTINIWXQ48q5JZbxg_rOvgrFS8',
      'X-SkillSwap-Timestamp', v_ts,
      'X-SkillSwap-Signature', 'sha256=' || v_sig_hex
    ),
    timeout_milliseconds := 10000
  );
EXCEPTION WHEN OTHERS THEN
  -- Never block the source INSERT — a failing email pipeline must not roll
  -- back the underlying notification or session change. Log and move on.
  RAISE WARNING 'dispatch_session_email failed for notification % (%): %',
    p_notification_id, p_type, SQLERRM;
END;
$$;
