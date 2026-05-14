-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Rejecting/withdrawing a reschedule only changes the proposal row. Give
-- authenticated users narrowly-scoped UPDATE rights for those state changes
-- and run the RPCs as the caller. accept_reschedule remains SECURITY DEFINER
-- because it also updates the locked session scheduled_at.

GRANT UPDATE (status, responder_id, responded_at) ON public.reschedule_proposals TO authenticated;

DROP POLICY IF EXISTS "Counterparty rejects pending reschedules" ON public.reschedule_proposals;
CREATE POLICY "Counterparty rejects pending reschedules" ON public.reschedule_proposals
  FOR UPDATE TO authenticated
  USING (
    status = 'pending'
    AND proposer_id <> auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  )
  WITH CHECK (
    status = 'rejected'
    AND responder_id = auth.uid()
    AND responded_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Proposers withdraw pending reschedules" ON public.reschedule_proposals;
CREATE POLICY "Proposers withdraw pending reschedules" ON public.reschedule_proposals
  FOR UPDATE TO authenticated
  USING (
    status = 'pending'
    AND proposer_id = auth.uid()
  )
  WITH CHECK (
    status = 'withdrawn'
    AND responder_id = auth.uid()
    AND responded_at IS NOT NULL
  );

ALTER FUNCTION public.reject_reschedule(UUID) SECURITY INVOKER;
ALTER FUNCTION public.withdraw_reschedule(UUID) SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';
