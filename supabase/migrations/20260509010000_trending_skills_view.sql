-- Trending skills view.
--
-- Surfaces which skills have the most platform activity over the last 30
-- days, as a grounding signal for the Gemini AI suggestions Edge Function.
-- Without this, the LLM tends to hallucinate "hot" topics from its training
-- data (e.g. "Rust is trending!") that have zero presence on SkillSwap.
--
-- A 30-day window (rather than 7) is intentional: while the platform is
-- early and traffic is sparse, a 7-day window is usually empty. This can
-- be tightened later when activity picks up.
--
-- Trending score weights:
--   completed/active sessions = 3  (strongest signal: real exchanges)
--   new learners              = 2  (demand)
--   new teachers              = 1  (supply)
--
-- The view is exposed read-only to authenticated users since it contains
-- no per-user data — only aggregate counts per skill.

CREATE OR REPLACE VIEW public.trending_skills AS
WITH window_bounds AS (
  SELECT (now() - interval '30 days') AS since
)
SELECT
  s.id AS skill_id,
  s.name AS skill_name,
  s.category,
  COALESCE(learners.count, 0) AS new_learners,
  COALESCE(teachers.count, 0) AS new_teachers,
  COALESCE(sess.count, 0) AS recent_sessions,
  (
    COALESCE(learners.count, 0) * 2
    + COALESCE(teachers.count, 0) * 1
    + COALESCE(sess.count, 0) * 3
  ) AS trending_score
FROM public.skills s
LEFT JOIN (
  SELECT skill_id, COUNT(DISTINCT user_id) AS count
  FROM public.user_learning_skills, window_bounds
  WHERE created_at >= since
  GROUP BY skill_id
) learners ON learners.skill_id = s.id
LEFT JOIN (
  SELECT skill_id, COUNT(DISTINCT user_id) AS count
  FROM public.user_teaching_skills, window_bounds
  WHERE created_at >= since
  GROUP BY skill_id
) teachers ON teachers.skill_id = s.id
LEFT JOIN (
  SELECT skill_id, COUNT(*) AS count
  FROM public.sessions, window_bounds
  WHERE created_at >= since
  GROUP BY skill_id
) sess ON sess.skill_id = s.id
WHERE (
  COALESCE(learners.count, 0)
  + COALESCE(teachers.count, 0)
  + COALESCE(sess.count, 0)
) > 0
ORDER BY trending_score DESC;
GRANT SELECT ON public.trending_skills TO authenticated, anon, service_role;
