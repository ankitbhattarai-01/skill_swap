-- =============================================================================
-- Session lifecycle email dispatch.
--
-- The notify_session_lifecycle() trigger (see 20260512170000) already inserts
-- rows into public.notifications for every session_* event. This migration
-- fans those rows out to the `send-session-email` Edge Function via pg_net,
-- which renders an HTML template and ships it through Resend's HTTP API.
--
-- Why this design:
--   * Single source of truth: the same trigger drives in-app notifications
--     AND email, so adding a new event type only requires one place to edit.
--   * No client involvement: emails fire on the DB side, so the browser
--     doesn't need to know which actions trigger email (and can't suppress).
--   * Opt-out lives on the profile, so users control their own preference.
--
-- Runtime configuration:
--   The function URL and HMAC secret are stored in
--   `private.email_dispatch_config` (one row). You must populate this once
--   after applying the migration — see docs/EMAIL_SETUP.md for the exact
--   INSERT statement. Until populated, the trigger is a no-op (it logs a
--   NOTICE but does NOT block the underlying notification insert).
-- =============================================================================

-- ─── 1. Extensions ──────────────────────────────────────────────────────────
-- pg_net ships with Supabase but is not enabled in fresh projects.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ─── 2. Per-user opt-out ─────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.profiles.email_notifications_enabled IS
  'When false, suppress all session_* email notifications for this user. Default true.';

-- ─── 3. Private config table for runtime URLs/secrets ───────────────────────
-- Kept in the `private` schema (no API exposure) so the secret never leaks
-- through PostgREST or RLS misconfig.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.email_dispatch_config (
  singleton    BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  target_url   TEXT NOT NULL,
  shared_secret TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON private.email_dispatch_config FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE private.email_dispatch_config IS
  'Holds the Edge Function URL and HMAC secret for the session email pipeline. Populate exactly one row via service-role SQL — never expose to anon/authenticated.';

-- ─── 4. Dispatcher function ─────────────────────────────────────────────────
-- SECURITY DEFINER so the trigger (running as the inserting user) can read
-- the private config table and call net.http_post.
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
  -- Only act on session_* events. Cheap check — keeps this function safe to
  -- wire up to a broader trigger later without changing the SQL.
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

REVOKE EXECUTE ON FUNCTION private.dispatch_session_email(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 5. Trigger on notifications ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fanout_session_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  PERFORM private.dispatch_session_email(NEW.id, NEW.type);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fanout_session_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notifications_session_email_fanout ON public.notifications;
CREATE TRIGGER notifications_session_email_fanout
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.fanout_session_email();
