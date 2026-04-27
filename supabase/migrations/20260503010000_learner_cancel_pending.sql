-- Allow a learner to cancel their own session while it is still pending.
-- The teacher response policy already covers pending -> accepted/rejected;
-- the FSM trigger validates the pending -> cancelled transition.
CREATE POLICY "Learners cancel pending sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = learner_id
    AND status = 'pending'
  )
  WITH CHECK (
    auth.uid() = learner_id
    AND status = 'cancelled'
  );
