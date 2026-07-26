-- =============================================================================
-- Welcome email on account creation.
--
-- Why this exists:
--   Signing up produced no email at all. Email/password signups get Supabase's
--   confirmation mail, but OAuth signups get nothing — Google has already
--   verified the address, so Supabase skips confirmation entirely and the user
--   lands in the app having never heard from us. (The "a new app was granted
--   access" mail some providers send comes from Google, not from us, and only
--   fires for sensitive scopes — we request just openid/email/profile.)
--
-- Design:
--   Reuse the existing notification -> pg_net -> send-session-email pipeline
--   rather than adding a second mail path. One AFTER INSERT trigger on
--   public.profiles writes a `welcome` notification; the existing fanout
--   trigger on public.notifications picks it up and dispatches it. That gives
--   us the in-app notification, the HMAC-signed dispatch, the per-user opt-out
--   and the session_email_deliveries dedupe log for free.
--
-- Fires once per user: profiles rows are created exactly once, by
-- handle_new_user(). Its ON CONFLICT (id) DO UPDATE branch is an UPDATE, so a
-- pre-seeded profile does not produce a welcome mail.
--
-- NOT backfilled on purpose — existing users must not be mailed.
-- =============================================================================

-- ─── 1. Let the dispatcher through for `welcome` ─────────────────────────────
-- Everything below is identical to 20260623000000_fix_session_email_gateway_apikey.sql
-- except the type guard, which now admits one non-session type.
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
  IF p_type NOT LIKE 'session\_%' ESCAPE '\' AND p_type <> 'welcome' THEN
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

REVOKE EXECUTE ON FUNCTION private.dispatch_session_email(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 2. Emit the welcome notification on profile creation ────────────────────
CREATE OR REPLACE FUNCTION public.notify_new_user_welcome()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, link)
  VALUES (
    NEW.id,
    'welcome',
    'Welcome to SkillSwap Connect',
    'Your account is ready. Add a skill you can teach, tell us what you want to learn, and book your first swap.',
    '/dashboard'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- This trigger runs inside the auth.users insert transaction (via
  -- handle_new_user). A raise here would abort the whole signup, which is a far
  -- worse outcome than a missing welcome mail. Swallow and log.
  RAISE WARNING 'notify_new_user_welcome failed for profile %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_new_user_welcome() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_welcome_notification ON public.profiles;
CREATE TRIGGER profiles_welcome_notification
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_user_welcome();

COMMENT ON FUNCTION public.notify_new_user_welcome() IS
  'Writes the one-time `welcome` notification for a newly created profile. The notifications_session_email_fanout trigger turns it into an email.';
