-- Skill verification — the "verified" tick on a teaching skill.
--
-- Flow: user clicks "Get verified" on one of their teaching skills. The
-- verify-skill Edge Function asks Gemini for 8 multiple-choice questions
-- pitched at that skill's declared level (basic / intermediate / advanced),
-- stores them, and returns them WITHOUT the answer key. The user answers, the
-- function grades server-side, and 6+/8 writes a row in
-- public.skill_verifications.
--
-- Three tables:
--   1. skill_verification_attempts — one row per quiz sitting. Drives the
--      24-hour cooldown after a failure and is the audit trail.
--   2. skill_verification_questions — the questions AND the answer key. This
--      is a separate table precisely BECAUSE RLS is row-level, not column-
--      level: keeping the key in the attempts row would mean any client that
--      can read its own attempt can read the answers. This table has no
--      policy for `authenticated` at all, so only the service role sees it.
--   3. skill_verifications — the durable badge. World-readable so the tick
--      renders on other people's profiles and in explore.

-- 1. Attempts ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.skill_verification_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id      UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  level         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in_progress',
  score         INT,
  total         INT NOT NULL,
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

ALTER TABLE public.skill_verification_attempts
  DROP CONSTRAINT IF EXISTS skill_verification_attempts_status_chk,
  DROP CONSTRAINT IF EXISTS skill_verification_attempts_level_chk,
  DROP CONSTRAINT IF EXISTS skill_verification_attempts_scored_chk;

ALTER TABLE public.skill_verification_attempts
  ADD CONSTRAINT skill_verification_attempts_status_chk
    CHECK (status IN ('in_progress', 'passed', 'failed', 'expired')),
  ADD CONSTRAINT skill_verification_attempts_level_chk
    CHECK (level IN ('basic', 'intermediate', 'advanced')),
  -- A finished attempt must carry a score, so the cooldown query can trust
  -- status alone without also null-checking score.
  ADD CONSTRAINT skill_verification_attempts_scored_chk
    CHECK (status = 'in_progress' OR score IS NOT NULL);

-- Serves the cooldown lookup: "this user's most recent finished attempt for
-- this skill".
CREATE INDEX IF NOT EXISTS skill_verification_attempts_user_skill_idx
  ON public.skill_verification_attempts (user_id, skill_id, created_at DESC);

ALTER TABLE public.skill_verification_attempts ENABLE ROW LEVEL SECURITY;

-- Read your own attempts (the UI shows "you can retry in N hours"). Writes are
-- service-role only — a client that could insert its own 'passed' attempt
-- could mint a badge.
DROP POLICY IF EXISTS "Users read own verification attempts" ON public.skill_verification_attempts;
CREATE POLICY "Users read own verification attempts" ON public.skill_verification_attempts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.skill_verification_attempts FROM anon, authenticated;
GRANT SELECT ON public.skill_verification_attempts TO authenticated;
GRANT ALL ON public.skill_verification_attempts TO service_role;

-- 2. Questions + answer key --------------------------------------------------
-- `correct_index` is the whole reason this table exists. NO policy is created
-- for `authenticated`, and RLS is enabled, so the table is invisible to every
-- client regardless of who owns the attempt. The Edge Function reads it with
-- the service-role key to grade.

CREATE TABLE IF NOT EXISTS public.skill_verification_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id    UUID NOT NULL REFERENCES public.skill_verification_attempts(id) ON DELETE CASCADE,
  position      INT NOT NULL,
  prompt        TEXT NOT NULL,
  options       JSONB NOT NULL,
  correct_index INT NOT NULL,
  explanation   TEXT,
  UNIQUE (attempt_id, position)
);

ALTER TABLE public.skill_verification_questions
  DROP CONSTRAINT IF EXISTS skill_verification_questions_correct_chk;

ALTER TABLE public.skill_verification_questions
  ADD CONSTRAINT skill_verification_questions_correct_chk
    CHECK (correct_index BETWEEN 0 AND 3 AND jsonb_array_length(options) = 4);

ALTER TABLE public.skill_verification_questions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.skill_verification_questions FROM anon, authenticated;
GRANT ALL ON public.skill_verification_questions TO service_role;

-- 3. The badge ---------------------------------------------------------------
-- One row per (user, skill). `level` records what they were tested at, so a
-- badge earned at 'basic' doesn't silently upgrade when the user later edits
-- their declared level to 'advanced' — see the trigger below.

CREATE TABLE IF NOT EXISTS public.skill_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,
  score       INT NOT NULL,
  total       INT NOT NULL,
  attempt_id  UUID REFERENCES public.skill_verification_attempts(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_id)
);

ALTER TABLE public.skill_verifications
  DROP CONSTRAINT IF EXISTS skill_verifications_level_chk;

ALTER TABLE public.skill_verifications
  ADD CONSTRAINT skill_verifications_level_chk
    CHECK (level IN ('basic', 'intermediate', 'advanced'));

CREATE INDEX IF NOT EXISTS skill_verifications_user_idx
  ON public.skill_verifications (user_id);
CREATE INDEX IF NOT EXISTS skill_verifications_skill_idx
  ON public.skill_verifications (skill_id);

ALTER TABLE public.skill_verifications ENABLE ROW LEVEL SECURITY;

-- World-readable: the tick has to render on other people's profiles and on
-- explore cards. Only the score/level is exposed, which is the point of it.
DROP POLICY IF EXISTS "Verifications are public" ON public.skill_verifications;
CREATE POLICY "Verifications are public" ON public.skill_verifications
  FOR SELECT TO authenticated, anon
  USING (true);

-- Users may drop their own badge (e.g. before re-testing at a higher level),
-- but may never create or edit one.
DROP POLICY IF EXISTS "Users delete own verification" ON public.skill_verifications;
CREATE POLICY "Users delete own verification" ON public.skill_verifications
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE ON public.skill_verifications FROM anon, authenticated;
GRANT SELECT, DELETE ON public.skill_verifications TO authenticated;
GRANT ALL ON public.skill_verifications TO service_role;

-- 4. Keep the badge honest when the declared level changes -------------------
-- Someone verified at 'basic' who then edits the skill to 'advanced' would
-- otherwise show a tick next to a level they never tested at. Raising the
-- level clears the badge (they can re-test); lowering it keeps the badge and
-- pins it down to the new, weaker claim.

CREATE OR REPLACE FUNCTION public.sync_skill_verification_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rank_old INT;
  rank_new INT;
BEGIN
  IF NEW.level IS NOT DISTINCT FROM OLD.level THEN
    RETURN NEW;
  END IF;

  SELECT CASE OLD.level WHEN 'basic' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END,
         CASE NEW.level WHEN 'basic' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END
    INTO rank_old, rank_new;

  IF rank_new > rank_old THEN
    DELETE FROM public.skill_verifications
     WHERE user_id = NEW.user_id AND skill_id = NEW.skill_id;
  ELSE
    UPDATE public.skill_verifications
       SET level = NEW.level
     WHERE user_id = NEW.user_id AND skill_id = NEW.skill_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_skill_verification_level ON public.user_teaching_skills;
CREATE TRIGGER sync_skill_verification_level
  AFTER UPDATE OF level ON public.user_teaching_skills
  FOR EACH ROW EXECUTE FUNCTION public.sync_skill_verification_level();

-- Removing the teaching skill entirely retires its badge too — there is
-- nothing left to put a tick against.
CREATE OR REPLACE FUNCTION public.clear_skill_verification_on_unteach()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.skill_verifications
   WHERE user_id = OLD.user_id AND skill_id = OLD.skill_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS clear_skill_verification_on_unteach ON public.user_teaching_skills;
CREATE TRIGGER clear_skill_verification_on_unteach
  AFTER DELETE ON public.user_teaching_skills
  FOR EACH ROW EXECUTE FUNCTION public.clear_skill_verification_on_unteach();
