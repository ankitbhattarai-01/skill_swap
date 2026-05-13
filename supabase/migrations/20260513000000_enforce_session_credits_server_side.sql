-- =============================================================================
-- Enforce the session credit amount server-side at INSERT time.
--
-- Before this migration, the only INSERT-policy check on `credits` was
-- `credits > 0` plus the duration whitelist. A malicious client could call
-- .insert({ duration_minutes: 90, credits: 1, ... }) and lock in a 1-credit
-- escrow for what should cost 6. The protect_session_integrity trigger
-- then blocked any post-insert correction, so the underpayment stuck.
--
-- Fix: a BEFORE INSERT trigger recomputes credits from
--   ceil(duration_minutes × credits_per_hour / 60)
-- and silently overwrites NEW.credits. The hourly rate is read from
-- user_teaching_skills for (teacher_id, skill_id); if missing it falls
-- back to the platform default (4 cr/hr per 20260508040000).
--
-- We use overwrite rather than reject so legitimate stale-cache clients
-- (where the user just changed their rate) still succeed — the server
-- always wins on price.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_session_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rate INT;
BEGIN
  -- Trigger fires for all roles (including service/postgres). There's no
  -- legitimate path that should bypass server-side pricing — backfills /
  -- data migrations should write directly to the table with admin tooling
  -- and disable the trigger explicitly if they need a different value.
  SELECT credits_per_hour
  INTO v_rate
  FROM public.user_teaching_skills
  WHERE user_id = NEW.teacher_id
    AND skill_id = NEW.skill_id
  LIMIT 1;

  -- Fallback to the platform default if the teacher hasn't listed this
  -- skill yet (shouldn't usually happen — explore/dashboard only surfaces
  -- teachers who have, but a teacher could remove the listing mid-flow).
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 4;
  END IF;

  NEW.credits := GREATEST(
    1,
    CEIL((v_rate::numeric * NEW.duration_minutes) / 60)::int
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_enforce_credits ON public.sessions;
CREATE TRIGGER sessions_enforce_credits
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_credits();
