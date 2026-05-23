-- =============================================================================
-- Critical #3 — Incorrect session pricing.
--
-- Two different "platform default credits per hour" values exist:
--
--   - admin_active_settings.sessions.default_credits_per_hour = 5
--     (seeded in 20260512005000_seed_admin_settings_and_feature_flags)
--   - enforce_session_credits() fallback constant                = 4
--     (introduced in 20260513000000_enforce_session_credits_server_side)
--   - user_teaching_skills.credits_per_hour column DEFAULT       = 4
--     (introduced in 20260508040000_credits_per_hour_default_4)
--
-- So when a teacher's user_teaching_skills row is missing (or stale, or the
-- teacher created a session against a skill they recently un-listed) the
-- server falls back to 4 cr/hr instead of the admin-configured 5 — a
-- 20% under-charge on the hourly rate.
--
-- Fix:
--   1. Re-align the column DEFAULT to 5 so newly listed skills price at
--      the admin-configured rate without each teacher having to set it.
--   2. Rewrite enforce_session_credits() so its fallback reads the live
--      admin setting, with a hard floor of 5 if for some reason the
--      setting row is missing. The admin setting becomes the single source
--      of truth, so future re-prices in the Settings UI flow through
--      automatically.
--
-- This migration does NOT touch existing user_teaching_skills rows. The
-- previous migration (20260508040000) backfilled everyone to 4; if the
-- product wants those bumped to 5, that's a separate operational decision
-- (it would be a unilateral price hike for every existing teacher) and
-- belongs in an admin-run data migration, not this fix.
-- =============================================================================


-- ─── 1. Column default ───────────────────────────────────────────────────────

ALTER TABLE public.user_teaching_skills
  ALTER COLUMN credits_per_hour SET DEFAULT 5;
-- ─── 2. Pricing trigger reads from admin_active_settings ─────────────────────

CREATE OR REPLACE FUNCTION public.enforce_session_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rate INT;
BEGIN
  -- Primary source: the teacher's own listed rate for this skill.
  SELECT credits_per_hour
  INTO v_rate
  FROM public.user_teaching_skills
  WHERE user_id = NEW.teacher_id
    AND skill_id = NEW.skill_id
  LIMIT 1;

  -- Fallback: the admin-configured platform default. This is the single
  -- source of truth for "what does an hour cost when the teacher hasn't
  -- said otherwise" — admins can change it in the Settings UI without
  -- another migration. Floor of 5 if the setting row is somehow missing,
  -- matching the seed value to keep behaviour deterministic.
  IF v_rate IS NULL OR v_rate <= 0 THEN
    SELECT COALESCE((current_value->>'value')::INT, 5)
    INTO v_rate
    FROM public.admin_active_settings
    WHERE setting_key = 'sessions.default_credits_per_hour';

    IF v_rate IS NULL OR v_rate <= 0 THEN
      v_rate := 5;
    END IF;
  END IF;

  NEW.credits := GREATEST(
    1,
    CEIL((v_rate::numeric * NEW.duration_minutes) / 60)::int
  );

  RETURN NEW;
END;
$$;
