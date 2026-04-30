ALTER TYPE public.learning_mode ADD VALUE IF NOT EXISTS 'coaching';
ALTER TYPE public.learning_mode ADD VALUE IF NOT EXISTS 'peer_review';
ALTER TYPE public.learning_mode ADD VALUE IF NOT EXISTS 'project_based';
ALTER TYPE public.learning_mode ADD VALUE IF NOT EXISTS 'study_group';
ALTER TYPE public.learning_mode ADD VALUE IF NOT EXISTS 'hands_on';
ALTER TABLE public.user_teaching_skills
  ADD COLUMN IF NOT EXISTS teaching_mode public.learning_mode NOT NULL DEFAULT 'teaching';
ALTER TABLE public.user_learning_skills
  ADD COLUMN IF NOT EXISTS learning_mode public.learning_mode NOT NULL DEFAULT 'mentorship';
CREATE INDEX IF NOT EXISTS user_teaching_skills_teaching_mode_idx
  ON public.user_teaching_skills (teaching_mode);
CREATE INDEX IF NOT EXISTS user_learning_skills_learning_mode_idx
  ON public.user_learning_skills (learning_mode);
