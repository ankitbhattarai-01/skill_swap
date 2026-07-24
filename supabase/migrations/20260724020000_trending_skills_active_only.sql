-- Restrict trending_skills to the curated catalog.
--
-- The view aggregates 30 days of activity straight off public.skills with no
-- activation filter, so a skill retired by 20260724000000_curated_skill_catalog
-- keeps trending on the strength of the sessions it ran before retirement. That
-- produces exactly the dead-end tile the curated catalog exists to prevent:
-- "Bike Riding is taking off on SkillSwap this week" pointing at a skill nobody
-- can select any more.
--
-- Same query shape as the original, plus `WHERE s.is_active`. Grants and the
-- security_invoker setting are re-applied below because CREATE OR REPLACE VIEW
-- is not guaranteed to carry either across.

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
WHERE s.is_active
  AND (
    COALESCE(learners.count, 0)
    + COALESCE(teachers.count, 0)
    + COALESCE(sess.count, 0)
  ) > 0
ORDER BY trending_score DESC;

ALTER VIEW public.trending_skills SET (security_invoker = true);
GRANT SELECT ON public.trending_skills TO authenticated, anon, service_role;
