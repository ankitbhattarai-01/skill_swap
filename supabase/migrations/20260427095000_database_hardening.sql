-- Data quality constraints
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_credits_nonnegative CHECK (credits >= 0) NOT VALID;
ALTER TABLE public.user_teaching_skills
  ADD CONSTRAINT user_teaching_skills_credits_positive CHECK (credits_per_hour > 0) NOT VALID;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_credits_positive CHECK (credits > 0) NOT VALID,
  ADD CONSTRAINT sessions_not_self CHECK (learner_id <> teacher_id) NOT VALID;
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_not_self CHECK (reviewer_id <> reviewee_id) NOT VALID;
-- Query performance for dashboard, chat, history, and matching screens
CREATE INDEX IF NOT EXISTS profiles_onboarded_idx
  ON public.profiles (onboarded);
CREATE INDEX IF NOT EXISTS user_teaching_skills_user_id_idx
  ON public.user_teaching_skills (user_id);
CREATE INDEX IF NOT EXISTS user_teaching_skills_skill_id_idx
  ON public.user_teaching_skills (skill_id);
CREATE INDEX IF NOT EXISTS user_learning_skills_user_id_idx
  ON public.user_learning_skills (user_id);
CREATE INDEX IF NOT EXISTS user_learning_skills_skill_id_idx
  ON public.user_learning_skills (skill_id);
CREATE INDEX IF NOT EXISTS sessions_learner_status_created_idx
  ON public.sessions (learner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_teacher_status_created_idx
  ON public.sessions (teacher_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_skill_id_idx
  ON public.sessions (skill_id);
CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON public.messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS credit_transactions_from_user_created_idx
  ON public.credit_transactions (from_user, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_transactions_to_user_created_idx
  ON public.credit_transactions (to_user, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_session_id_idx
  ON public.reviews (session_id);
CREATE INDEX IF NOT EXISTS reviews_reviewee_created_idx
  ON public.reviews (reviewee_id, created_at DESC);
-- Keep chat tied to live/open sessions only.
DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('pending', 'accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
