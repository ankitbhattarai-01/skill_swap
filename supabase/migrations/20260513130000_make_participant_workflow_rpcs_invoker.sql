-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Move five participant-scoped workflow RPCs to SECURITY INVOKER by encoding
-- their ownership/participant rules in RLS. Privileged credit/admin flows stay
-- SECURITY DEFINER.

-- 1) propose_reschedule: participant inserts a proposal for their session.
GRANT SELECT ON public.sessions TO authenticated;
GRANT SELECT ON public.reschedule_proposals TO authenticated;
GRANT INSERT ON public.reschedule_proposals TO authenticated;

DROP POLICY IF EXISTS "Participants propose reschedules" ON public.reschedule_proposals;
CREATE POLICY "Participants propose reschedules" ON public.reschedule_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    proposer_id = auth.uid()
    AND status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

ALTER FUNCTION public.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) SECURITY INVOKER;

-- 2) accept_reschedule: counterparty updates scheduled_at only to the pending
-- proposal's exact requested time, then marks the proposal accepted/expired.
GRANT UPDATE (scheduled_at) ON public.sessions TO authenticated;
GRANT UPDATE (status, responder_id, responded_at) ON public.reschedule_proposals TO authenticated;

DROP POLICY IF EXISTS "Counterparty applies accepted reschedules" ON public.sessions;
CREATE POLICY "Counterparty applies accepted reschedules" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    status IN ('accepted', 'active')
    AND (teacher_id = auth.uid() OR learner_id = auth.uid())
  )
  WITH CHECK (
    status IN ('accepted', 'active')
    AND (teacher_id = auth.uid() OR learner_id = auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.reschedule_proposals rp
      WHERE rp.session_id = sessions.id
        AND rp.status = 'pending'
        AND rp.proposer_id <> auth.uid()
        AND rp.new_scheduled_at = sessions.scheduled_at
    )
  );

DROP POLICY IF EXISTS "Counterparty accepts pending reschedules" ON public.reschedule_proposals;
CREATE POLICY "Counterparty accepts pending reschedules" ON public.reschedule_proposals
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
    status IN ('accepted', 'expired')
    AND responder_id = auth.uid()
    AND responded_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

ALTER FUNCTION public.accept_reschedule(UUID) SECURITY INVOKER;

-- 3) accept_track: teacher accepts a proposed track and inserts planned rows.
GRANT SELECT ON public.learning_tracks TO authenticated;
GRANT SELECT ON public.track_planned_sessions TO authenticated;
GRANT UPDATE (status) ON public.learning_tracks TO authenticated;
GRANT INSERT ON public.track_planned_sessions TO authenticated;

DROP POLICY IF EXISTS "Teachers accept proposed tracks" ON public.learning_tracks;
CREATE POLICY "Teachers accept proposed tracks" ON public.learning_tracks
  FOR UPDATE TO authenticated
  USING (
    teacher_id = auth.uid()
    AND status = 'proposed'
  )
  WITH CHECK (
    teacher_id = auth.uid()
    AND status = 'active'
  );

DROP POLICY IF EXISTS "Teachers create planned sessions for accepted tracks" ON public.track_planned_sessions;
CREATE POLICY "Teachers create planned sessions for accepted tracks" ON public.track_planned_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND lt.teacher_id = auth.uid()
        AND lt.status = 'proposed'
    )
  );

ALTER FUNCTION public.accept_track(UUID) SECURITY INVOKER;

-- 4) end_track: either participant cancels the track and pending planned rows.
GRANT UPDATE (status, end_reason, ended_by, ended_at) ON public.learning_tracks TO authenticated;
GRANT UPDATE (status, skip_reason) ON public.track_planned_sessions TO authenticated;

DROP POLICY IF EXISTS "Participants end active or proposed tracks" ON public.learning_tracks;
CREATE POLICY "Participants end active or proposed tracks" ON public.learning_tracks
  FOR UPDATE TO authenticated
  USING (
    status IN ('active', 'proposed')
    AND (learner_id = auth.uid() OR teacher_id = auth.uid())
  )
  WITH CHECK (
    status = 'cancelled'
    AND ended_by = auth.uid()
    AND ended_at IS NOT NULL
    AND (learner_id = auth.uid() OR teacher_id = auth.uid())
  );

DROP POLICY IF EXISTS "Participants cancel pending planned track sessions" ON public.track_planned_sessions;
CREATE POLICY "Participants cancel pending planned track sessions" ON public.track_planned_sessions
  FOR UPDATE TO authenticated
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = auth.uid() OR lt.teacher_id = auth.uid())
    )
  )
  WITH CHECK (
    status = 'cancelled'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = auth.uid() OR lt.teacher_id = auth.uid())
    )
  );

ALTER FUNCTION public.end_track(UUID, TEXT) SECURITY INVOKER;

-- 5) record_session_leave: caller closes their own open attendance interval.
GRANT SELECT ON public.session_attendance TO authenticated;
GRANT UPDATE (left_at) ON public.session_attendance TO authenticated;

DROP POLICY IF EXISTS "Users close own attendance interval" ON public.session_attendance;
CREATE POLICY "Users close own attendance interval" ON public.session_attendance
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND left_at IS NULL
  )
  WITH CHECK (
    user_id = auth.uid()
    AND left_at IS NOT NULL
  );

ALTER FUNCTION public.record_session_leave(UUID) SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';
