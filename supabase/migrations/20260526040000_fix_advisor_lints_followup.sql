-- Address Supabase advisor lints after the pending-message-caps work.
--
-- 1) WARN auth_rls_initplan on public.messages.
--    Migration 20260526010000 rewrote the "Participants send messages"
--    policy with bare auth.uid() calls, regressing the init-plan fix
--    from 20260514000000. Re-wrap each call in (select auth.uid()) so
--    Postgres evaluates it once per statement instead of once per row.
--
-- 2) INFO unused_index x4 from 20260524010000.
--    - sessions_review_scheduled_due_idx / sessions_review_unscheduled_due_idx:
--      move_due_sessions_to_review() filters with a single
--      (scheduled_at IS NOT NULL ... OR scheduled_at IS NULL ...) OR, so
--      the planner cannot use either partial index and falls back to a
--      seq scan. They will never be used by the current sweeper.
--    - track_planned_sessions_pending_due_idx: small table at current
--      scale; planner picks a seq scan. We can re-add when row count
--      makes the index worth it.
--    - learning_tracks_active_id_idx: redundant with the primary key on
--      (id); the planner uses the PK with a filter instead.

DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('pending', 'accepted', 'active')
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

DROP INDEX IF EXISTS public.sessions_review_scheduled_due_idx;
DROP INDEX IF EXISTS public.sessions_review_unscheduled_due_idx;
DROP INDEX IF EXISTS public.track_planned_sessions_pending_due_idx;
DROP INDEX IF EXISTS public.learning_tracks_active_id_idx;
