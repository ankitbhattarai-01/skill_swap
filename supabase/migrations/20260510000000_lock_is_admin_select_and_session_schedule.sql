-- Round-3 hardening:
--   1. Hide profiles.is_admin from broad reads (admin enumeration).
--   2. Reject sessions scheduled in the past.
--
-- Both are small, additive changes that do not alter existing user-visible
-- behaviour. The is_admin lockdown is the bigger of the two: today, anyone
-- (including unauthenticated visitors) can run
--     SELECT id, full_name FROM profiles WHERE is_admin = true
-- and get a roster of admin accounts to target.

-- ─── 1. Lock is_admin column-level SELECT ────────────────────────────────────
--
-- The base "Profiles are publicly viewable" policy uses USING (true), which
-- (combined with table-level SELECT GRANT) lets anyone read every column.
-- Postgres column-level GRANTs are the right tool to keep is_admin private
-- without giving up the public-readable profile experience needed by the
-- explore/users pages.
--
-- Anything not listed here remains readable, but is_admin specifically becomes
-- unreadable to anon and authenticated. Code that needs the flag for the
-- current user goes through the existing public.is_admin(uuid) RPC, which is
-- SECURITY DEFINER and so bypasses this restriction.

REVOKE SELECT ON public.profiles FROM anon, authenticated;
GRANT SELECT (
  id,
  full_name,
  bio,
  avatar_url,
  credits,
  learning_mode,
  onboarded,
  created_at,
  updated_at
) ON public.profiles TO anon, authenticated;
-- The service role keeps full access (used by Edge Functions when they need
-- to read is_admin server-side).
GRANT SELECT ON public.profiles TO service_role;
-- The 20260509020000 INSERT policy references `is_admin = false` directly,
-- which now fails because RLS expressions evaluate with the invoker's column
-- privileges. The check is redundant anyway: the column-level GRANT INSERT
-- list at the same migration excludes is_admin, and the column DEFAULT is
-- false, so a client INSERT can never set is_admin = true. Drop the explicit
-- check.
DROP POLICY IF EXISTS "Users insert their own profile" ON public.profiles;
CREATE POLICY "Users insert their own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND credits = 10
  );
-- ─── 2. Reject sessions scheduled in the past ────────────────────────────────
--
-- Client-side, SessionRequestDialog blocks past times. The INSERT policy at
-- 20260509030000 doesn't validate scheduled_at at all, so a direct API call
-- can create a session dated 8+ days ago, which the auto_complete_due_sessions
-- sweeper would then immediately settle. Mitigated because the counterparty
-- must accept before escrow is held — but if the counterparty is your own
-- sock-puppet, that's not much of a guard.
--
-- Five-minute past slack covers clock skew between client and server.
--
-- Implemented as a BEFORE INSERT/UPDATE trigger rather than a CHECK constraint
-- because CHECK with non-immutable now() would refire on every UPDATE — once
-- a session aged past now() - 5min (it always will), even an unrelated UPDATE
-- of meet_link would fail. The trigger only fires when scheduled_at is being
-- set or changed.

CREATE OR REPLACE FUNCTION public.check_session_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.scheduled_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at)
  THEN
    -- Past with 5-min skew tolerance.
    IF NEW.scheduled_at <= now() - interval '5 minutes' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Sessions cannot be scheduled in the past.';
    END IF;
    -- Far-future cap so a typo can't park escrow until the heat death of the
    -- universe. One year is generous for a peer skill exchange.
    IF NEW.scheduled_at > now() + interval '1 year' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Sessions cannot be scheduled more than one year in advance.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sessions_check_schedule ON public.sessions;
CREATE TRIGGER sessions_check_schedule
  BEFORE INSERT OR UPDATE OF scheduled_at ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.check_session_schedule();
REVOKE EXECUTE ON FUNCTION public.check_session_schedule() FROM PUBLIC, anon, authenticated;
