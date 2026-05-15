-- Resolve Supabase RLS performance advisor warnings without changing the
-- authorization surface.
--
-- 1. Wrap auth.uid() calls in SELECT initplans so they are evaluated once per
--    statement instead of once per row.
-- 2. Consolidate equivalent permissive policies that target the same command.

-- auth_rls_initplan

ALTER POLICY "Users manage own teaching skills" ON public.user_teaching_skills
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Users manage own learning skills" ON public.user_learning_skills
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Participants view sessions" ON public.sessions
  USING ((select auth.uid()) = teacher_id OR (select auth.uid()) = learner_id);

ALTER POLICY "Users view their notifications" ON public.notifications
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Participants view messages" ON public.messages
  USING (
    EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Users view their credit transactions" ON public.credit_transactions
  USING ((select auth.uid()) = from_user OR (select auth.uid()) = to_user);

ALTER POLICY "Authenticated can add skills" ON public.skills
  WITH CHECK ((select auth.uid()) IS NOT NULL);

ALTER POLICY "Participants create one review after completion" ON public.reviews
  WITH CHECK (
    (select auth.uid()) = reviewer_id
    AND reviewer_id <> reviewee_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status = 'completed'
        AND (
          (s.teacher_id = (select auth.uid()) AND s.learner_id = reviewee_id)
          OR (s.learner_id = (select auth.uid()) AND s.teacher_id = reviewee_id)
        )
    )
  );

ALTER POLICY "Users mark their notifications read" ON public.notifications
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Users view their own reports" ON public.reports
  USING ((select auth.uid()) = reporter_id);

ALTER POLICY "Senders update own messages" ON public.messages
  USING ((select auth.uid()) = sender_id)
  WITH CHECK ((select auth.uid()) = sender_id);

ALTER POLICY "Senders delete own messages" ON public.messages
  USING ((select auth.uid()) = sender_id);

ALTER POLICY "Users delete their notifications" ON public.notifications
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Authors view own reviews" ON public.reviews
  USING ((select auth.uid()) = reviewer_id);

ALTER POLICY "Authors edit own review within 24h" ON public.reviews
  USING (
    (select auth.uid()) = reviewer_id
    AND created_at > now() - interval '24 hours'
  )
  WITH CHECK (
    (select auth.uid()) = reviewer_id
    AND created_at > now() - interval '24 hours'
  );

ALTER POLICY "Admins view audit log" ON public.report_actions
  USING (public.is_admin((select auth.uid())));

ALTER POLICY "Admins create audit entries" ON public.report_actions
  WITH CHECK (
    public.is_admin((select auth.uid()))
    AND (select auth.uid()) = moderator_id
  );

ALTER POLICY ai_suggestions_select_own ON public.ai_suggestions
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Admin metadata read" ON public.admin_permission_definitions
  USING (public.is_admin((select auth.uid())));

ALTER POLICY "Admin roles read" ON public.admin_roles
  USING (public.admin_has_permission((select auth.uid()), 'access-governance', 'read'));

ALTER POLICY "Admin role permissions read" ON public.admin_role_permissions
  USING (public.admin_has_permission((select auth.uid()), 'access-governance', 'read'));

ALTER POLICY "Admin scopes read" ON public.admin_policy_scopes
  USING (public.admin_has_permission((select auth.uid()), 'access-governance', 'read'));

ALTER POLICY "Admin assignments read" ON public.admin_role_assignments
  USING (
    user_id = (select auth.uid())
    OR public.admin_has_permission((select auth.uid()), 'access-governance', 'read')
  );

ALTER POLICY "Admin reason codes read" ON public.admin_reason_codes
  USING (public.is_admin((select auth.uid())));

ALTER POLICY "Admin action requests read" ON public.admin_action_requests
  USING (
    maker_id = (select auth.uid())
    OR checker_id = (select auth.uid())
    OR public.admin_has_permission((select auth.uid()), domain, 'read')
  );

ALTER POLICY "Admin audit read" ON public.admin_audit_events
  USING (
    public.admin_has_permission((select auth.uid()), 'compliance', 'read')
    OR public.admin_has_permission((select auth.uid()), 'security', 'read')
  );

ALTER POLICY "Retention policy read" ON public.data_retention_policies
  USING (public.admin_has_permission((select auth.uid()), 'compliance', 'read'));

ALTER POLICY "Purge run read" ON public.retention_purge_runs
  USING (public.admin_has_permission((select auth.uid()), 'compliance', 'read'));

ALTER POLICY "Privacy request read" ON public.privacy_requests
  USING (public.admin_has_permission((select auth.uid()), 'privacy', 'read'));

ALTER POLICY "Settings versions read" ON public.admin_settings_versions
  USING (public.admin_has_permission((select auth.uid()), 'settings', 'read'));

ALTER POLICY "Cases read" ON public.admin_cases
  USING (public.admin_has_permission((select auth.uid()), 'moderation', 'read'));

ALTER POLICY "Case notes read" ON public.admin_case_notes
  USING (public.admin_has_permission((select auth.uid()), 'moderation', 'read'));

ALTER POLICY "Admins view authorized reports" ON public.reports
  USING (public.admin_has_permission((select auth.uid()), 'moderation', 'read'));

ALTER POLICY "Users insert their own profile" ON public.profiles
  WITH CHECK ((select auth.uid()) = id);

ALTER POLICY "Users update their own profile" ON public.profiles
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

ALTER POLICY "Participants create pending sessions" ON public.sessions
  WITH CHECK (
    (select auth.uid()) IS NOT NULL
    AND (select auth.uid()) = initiator_id
    AND ((select auth.uid()) = learner_id OR (select auth.uid()) = teacher_id)
    AND learner_id IS NOT NULL
    AND teacher_id IS NOT NULL
    AND learner_id <> teacher_id
    AND status = 'pending'
    AND escrow_held = false
    AND credits > 0
    AND duration_minutes IN (30, 60, 90)
  );

ALTER POLICY "Users create their own reports" ON public.reports
  WITH CHECK (
    (select auth.uid()) = reporter_id
    AND status = 'open'
  );

ALTER POLICY "Participants send messages" ON public.messages
  WITH CHECK (
    (select auth.uid()) = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Finance reconciliation read" ON public.finance_reconciliation_runs
  USING (
    public.admin_has_permission((select auth.uid()), 'wallet', 'read')
    OR public.admin_has_permission((select auth.uid()), 'compliance', 'read')
  );

ALTER POLICY "Data classification read" ON public.data_classification_registry
  USING (
    public.admin_has_permission((select auth.uid()), 'compliance', 'read')
    OR public.admin_has_permission((select auth.uid()), 'privacy', 'read')
  );

ALTER POLICY "Participants view session attendance" ON public.session_attendance
  USING (
    EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_attendance.session_id
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Participants view their tracks" ON public.learning_tracks
  USING (learner_id = (select auth.uid()) OR teacher_id = (select auth.uid()));

ALTER POLICY "Track participants view planned sessions" ON public.track_planned_sessions
  USING (
    EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = (select auth.uid()) OR lt.teacher_id = (select auth.uid()))
    )
  );

ALTER POLICY "Participants view their settlement" ON public.session_settlement
  USING (
    EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_settlement.session_id
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Users view own strikes" ON public.user_strikes
  USING (user_id = (select auth.uid()));

ALTER POLICY "Participants propose reschedules" ON public.reschedule_proposals
  WITH CHECK (
    proposer_id = (select auth.uid())
    AND status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Participants view session reschedules" ON public.reschedule_proposals
  USING (
    EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
    )
  );

ALTER POLICY "Users view own availability" ON public.user_availability
  USING (user_id = (select auth.uid()));

ALTER POLICY "Users insert own availability" ON public.user_availability
  WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY "Users delete own availability" ON public.user_availability
  USING (user_id = (select auth.uid()));

ALTER POLICY "Suspended users cannot create sessions" ON public.sessions
  WITH CHECK (NOT private.is_admin_suspended((select auth.uid())));

ALTER POLICY "Users close own attendance interval" ON public.session_attendance
  USING (user_id = (select auth.uid()) AND left_at IS NULL)
  WITH CHECK (user_id = (select auth.uid()) AND left_at IS NOT NULL);

ALTER POLICY "Teachers create planned sessions for accepted tracks" ON public.track_planned_sessions
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND lt.teacher_id = (select auth.uid())
        AND lt.status = 'proposed'
    )
  );

ALTER POLICY "Participants cancel pending planned track sessions" ON public.track_planned_sessions
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = (select auth.uid()) OR lt.teacher_id = (select auth.uid()))
    )
  )
  WITH CHECK (
    status = 'cancelled'
    AND EXISTS (
      SELECT 1
      FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = (select auth.uid()) OR lt.teacher_id = (select auth.uid()))
    )
  );

-- multiple_permissive_policies

DROP POLICY IF EXISTS "Active settings read" ON public.admin_active_settings;
DROP POLICY IF EXISTS "Public feature flags read" ON public.admin_active_settings;
CREATE POLICY "Active settings read" ON public.admin_active_settings
  FOR SELECT TO authenticated
  USING (
    private.current_user_can_read_admin_settings()
    OR setting_key IN (
      'features.ai_suggestions.enabled',
      'features.video_calls.enabled',
      'features.public_explore.enabled',
      'signup.starting_credits',
      'sessions.default_credits_per_hour'
    )
  );
CREATE POLICY "Public feature flags read" ON public.admin_active_settings
  FOR SELECT TO anon
  USING (
    setting_key IN (
      'features.ai_suggestions.enabled',
      'features.video_calls.enabled',
      'features.public_explore.enabled',
      'signup.starting_credits',
      'sessions.default_credits_per_hour'
    )
  );

DROP POLICY IF EXISTS "Teachers accept proposed tracks" ON public.learning_tracks;
DROP POLICY IF EXISTS "Teachers reject proposed tracks" ON public.learning_tracks;
DROP POLICY IF EXISTS "Participants end active or proposed tracks" ON public.learning_tracks;
CREATE POLICY "Participants update active or proposed tracks" ON public.learning_tracks
  FOR UPDATE TO authenticated
  USING (
    (
      teacher_id = (select auth.uid())
      AND status = 'proposed'
    )
    OR (
      status IN ('active', 'proposed')
      AND (learner_id = (select auth.uid()) OR teacher_id = (select auth.uid()))
    )
  )
  WITH CHECK (
    (
      teacher_id = (select auth.uid())
      AND status = 'active'
    )
    OR (
      teacher_id = (select auth.uid())
      AND status = 'rejected'
      AND ended_by = (select auth.uid())
      AND ended_at IS NOT NULL
    )
    OR (
      status = 'cancelled'
      AND ended_by = (select auth.uid())
      AND ended_at IS NOT NULL
      AND (learner_id = (select auth.uid()) OR teacher_id = (select auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Admins view authorized reports" ON public.reports;
DROP POLICY IF EXISTS "Users view their own reports" ON public.reports;
CREATE POLICY "Authorized users view reports" ON public.reports
  FOR SELECT TO authenticated
  USING (
    reporter_id = (select auth.uid())
    OR public.admin_has_permission((select auth.uid()), 'moderation', 'read')
  );

DROP POLICY IF EXISTS "Counterparty accepts pending reschedules" ON public.reschedule_proposals;
DROP POLICY IF EXISTS "Counterparty rejects pending reschedules" ON public.reschedule_proposals;
DROP POLICY IF EXISTS "Proposers withdraw pending reschedules" ON public.reschedule_proposals;
CREATE POLICY "Participants update pending reschedules" ON public.reschedule_proposals
  FOR UPDATE TO authenticated
  USING (
    (
      status = 'pending'
      AND proposer_id <> (select auth.uid())
      AND EXISTS (
        SELECT 1
        FROM public.sessions s
        WHERE s.id = reschedule_proposals.session_id
          AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
      )
    )
    OR (
      status = 'pending'
      AND proposer_id = (select auth.uid())
    )
  )
  WITH CHECK (
    (
      status IN ('accepted', 'expired')
      AND responder_id = (select auth.uid())
      AND responded_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.sessions s
        WHERE s.id = reschedule_proposals.session_id
          AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
      )
    )
    OR (
      status = 'rejected'
      AND responder_id = (select auth.uid())
      AND responded_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.sessions s
        WHERE s.id = reschedule_proposals.session_id
          AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
      )
    )
    OR (
      status = 'withdrawn'
      AND responder_id = (select auth.uid())
      AND responded_at IS NOT NULL
    )
  );

DROP POLICY IF EXISTS "Authors view own reviews" ON public.reviews;
DROP POLICY IF EXISTS "Public views matured reviews" ON public.reviews;
CREATE POLICY "Authorized users view reviews" ON public.reviews
  FOR SELECT
  USING (
    (select auth.uid()) = reviewer_id
    OR created_at < now() - interval '14 days'
    OR private.review_counterpart_exists(session_id, reviewer_id, reviewee_id)
  );

DROP POLICY IF EXISTS "Teachers schedule pending sessions" ON public.sessions;
DROP POLICY IF EXISTS "Counterparty applies accepted reschedules" ON public.sessions;
CREATE POLICY "Participants update schedulable sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    (
      (select auth.uid()) = teacher_id
      AND status = 'pending'
    )
    OR (
      status IN ('accepted', 'active')
      AND (teacher_id = (select auth.uid()) OR learner_id = (select auth.uid()))
    )
  )
  WITH CHECK (
    (
      (select auth.uid()) = teacher_id
      AND status = 'pending'
    )
    OR (
      status IN ('accepted', 'active')
      AND (teacher_id = (select auth.uid()) OR learner_id = (select auth.uid()))
      AND EXISTS (
        SELECT 1
        FROM public.reschedule_proposals rp
        WHERE rp.session_id = sessions.id
          AND rp.status = 'pending'
          AND rp.proposer_id <> (select auth.uid())
          AND rp.new_scheduled_at = sessions.scheduled_at
      )
    )
  );

DROP POLICY IF EXISTS "Users manage own learning skills" ON public.user_learning_skills;
CREATE POLICY "Users insert own learning skills" ON public.user_learning_skills
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users update own learning skills" ON public.user_learning_skills
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users delete own learning skills" ON public.user_learning_skills
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users manage own teaching skills" ON public.user_teaching_skills;
CREATE POLICY "Users insert own teaching skills" ON public.user_teaching_skills
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users update own teaching skills" ON public.user_teaching_skills
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "Users delete own teaching skills" ON public.user_teaching_skills
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

NOTIFY pgrst, 'reload schema';
