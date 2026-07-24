-- Practice progress — the "solved" counters behind the LeetCode-lite Practice
-- page (/practice).
--
-- Practice is zero-stakes: the client generates multiple-choice problems via the
-- practice-questions Edge Function, grades them locally, and reports each answer
-- here. There is no badge and no reward, so these counts are advisory — a
-- personal "you've solved N problems" tally, shown as LeetCode-style stat cards.
--
-- One counter row per (user, skill, difficulty). The ONLY write path is the
-- record_practice_answer RPC below: clients cannot INSERT/UPDATE the table
-- directly, and the RPC always bumps `attempted` and only bumps `solved` on a
-- correct answer, so `solved` can never exceed `attempted`.

CREATE TABLE IF NOT EXISTS public.practice_progress (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,
  solved      INT NOT NULL DEFAULT 0,
  attempted   INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_id, level)
);

ALTER TABLE public.practice_progress
  DROP CONSTRAINT IF EXISTS practice_progress_level_chk,
  DROP CONSTRAINT IF EXISTS practice_progress_counts_chk;

ALTER TABLE public.practice_progress
  ADD CONSTRAINT practice_progress_level_chk
    CHECK (level IN ('basic', 'intermediate', 'advanced')),
  -- Belt-and-braces: the RPC already guarantees this, but the constraint means
  -- a stray write could never leave solved > attempted.
  ADD CONSTRAINT practice_progress_counts_chk
    CHECK (solved >= 0 AND attempted >= 0 AND solved <= attempted);

CREATE INDEX IF NOT EXISTS practice_progress_user_idx
  ON public.practice_progress (user_id);

ALTER TABLE public.practice_progress ENABLE ROW LEVEL SECURITY;

-- Read your own progress (the stat cards on the Practice page). Writes are
-- revoked entirely from clients — everything goes through the RPC below.
DROP POLICY IF EXISTS "Users read own practice progress" ON public.practice_progress;
CREATE POLICY "Users read own practice progress" ON public.practice_progress
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.practice_progress FROM anon, authenticated;
GRANT SELECT ON public.practice_progress TO authenticated;
GRANT ALL ON public.practice_progress TO service_role;

-- The one write path. Upserts the caller's (skill, level) row: +1 attempted
-- always, +1 solved only when the answer was correct. Runs as SECURITY DEFINER
-- so it can write past the client REVOKE above, but it is pinned to auth.uid(),
-- so a caller can only ever move their own counter.
CREATE OR REPLACE FUNCTION public.record_practice_answer(
  p_skill_id UUID,
  p_level    TEXT,
  p_correct  BOOLEAN
)
RETURNS TABLE (solved INT, attempted INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_level NOT IN ('basic', 'intermediate', 'advanced') THEN
    RAISE EXCEPTION 'invalid level %', p_level;
  END IF;

  INSERT INTO public.practice_progress (user_id, skill_id, level, solved, attempted, updated_at)
  VALUES (
    v_user,
    p_skill_id,
    p_level,
    CASE WHEN p_correct THEN 1 ELSE 0 END,
    1,
    now()
  )
  ON CONFLICT (user_id, skill_id, level) DO UPDATE
    SET attempted  = public.practice_progress.attempted + 1,
        solved     = public.practice_progress.solved + (CASE WHEN p_correct THEN 1 ELSE 0 END),
        updated_at = now();

  RETURN QUERY
    SELECT pp.solved, pp.attempted
    FROM public.practice_progress pp
    WHERE pp.user_id = v_user AND pp.skill_id = p_skill_id AND pp.level = p_level;
END;
$$;

REVOKE ALL ON FUNCTION public.record_practice_answer(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_practice_answer(UUID, TEXT, BOOLEAN) TO authenticated;
