-- Extend the auth-user trigger so OAuth signups (Google / GitHub) get a
-- usable profile row on first sign-in, not a half-empty one.
--
-- Why the change:
--   The previous handle_new_user() only read raw_user_meta_data->>'full_name',
--   which Supabase populates for email/password signups (we pass it via
--   options.data.full_name on signUp). OAuth providers do not use that key:
--     - Google fills `full_name`, `name`, `picture`, `avatar_url`
--     - GitHub fills `name`, `user_name`, `avatar_url`
--   so a GitHub user used to land in the app with full_name = the local part
--   of their email and no avatar at all. We now walk through the OAuth keys
--   in order and pick the first that's present, plus copy the provider avatar
--   so the dashboard greeting and the messages list look right immediately.
--
-- Backwards compatible: the credits=10 starting balance and the email/password
-- branch (full_name from options.data) keep working unchanged — the COALESCE
-- ladder simply has more steps now.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  resolved_name text;
  resolved_avatar text;
BEGIN
  resolved_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'name', ''),
    NULLIF(NEW.raw_user_meta_data->>'user_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'preferred_username', ''),
    split_part(NEW.email, '@', 1)
  );

  resolved_avatar := NULLIF(
    COALESCE(
      NEW.raw_user_meta_data->>'avatar_url',
      NEW.raw_user_meta_data->>'picture'
    ),
    ''
  );

  INSERT INTO public.profiles (id, full_name, avatar_url, credits)
  VALUES (NEW.id, resolved_name, resolved_avatar, 10)
  -- Idempotent against rare races where a profile row already exists (e.g. an
  -- admin pre-seeded one). Keep whatever the seed/edit set and only fill the
  -- avatar if the existing row is missing it.
  ON CONFLICT (id) DO UPDATE
    SET avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url);

  RETURN NEW;
END;
$$;

-- Re-grant the same lockdown the security migration applied — CREATE OR REPLACE
-- preserves grants in modern Postgres, but redo it defensively in case this
-- migration runs against a fresh database where the lockdown hasn't landed yet.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
