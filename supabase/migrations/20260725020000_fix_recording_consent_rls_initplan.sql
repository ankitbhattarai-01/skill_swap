-- =============================================================================
-- Supabase performance advisor 0003 — "Auth RLS Initialization Plan" (WARN).
--
-- Both policies added by 20260724050000 on public.recording_consent_signals
-- call auth.uid() bare:
--
--   * "Participants emit recording consent" (INSERT)
--   * "Participants view recording consent"  (SELECT)
--
-- auth.uid() is STABLE, but written bare inside a policy expression the planner
-- treats it as part of the per-row qual and re-executes it for every row the
-- policy is checked against. Wrapping it as (select auth.uid()) turns it into
-- an uncorrelated InitPlan: evaluated once per statement, its result reused for
-- every row. Same value, same authorization outcome, one call instead of N.
--
-- This matters most for the SELECT policy: it gates the realtime changefeed and
-- runs over the whole session's consent history on each read.
--
-- Why this cannot change who can do what:
--
--   1. auth.uid() reads request.jwt.claims from the current session's GUC. It
--      is constant for the duration of a statement, so hoisting it out of the
--      row loop cannot produce a different answer for any row.
--
--   2. ALTER POLICY only replaces the named expression. The policy's command
--      (INSERT / SELECT), its permissive kind, and its `TO authenticated`
--      role targeting are all left exactly as they were.
--
--   3. The EXISTS subquery on public.sessions is untouched apart from the same
--      substitution — it still correlates on session_id and still requires the
--      caller to be the teacher or the learner, with the write side still
--      requiring status IN ('accepted', 'active').
--
-- Net effect on the running site: none, beyond fewer function calls per query.
-- =============================================================================

-- ─── 1. Write policy ─────────────────────────────────────────────────────────

ALTER POLICY "Participants emit recording consent"
  ON public.recording_consent_signals
  WITH CHECK (
    (select auth.uid()) = from_user_id
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

-- ─── 2. Read policy ──────────────────────────────────────────────────────────

ALTER POLICY "Participants view recording consent"
  ON public.recording_consent_signals
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );
