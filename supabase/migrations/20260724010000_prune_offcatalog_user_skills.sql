-- Companion to 20260724000000_curated_skill_catalog.sql. OPTIONAL.
--
-- The catalog migration retires off-catalog skills but leaves the profile rows
-- that point at them, so a user who added "Bike Riding" still shows it on their
-- profile and still appears under it in Explore. This migration removes those
-- teaching / learning rows.
--
-- Run it only if you want existing profiles cleaned. It is the one destructive
-- step in this change: the rows are deleted, not archived, and there is no undo.
--
-- What it does NOT touch:
--   * public.skills            — retired skills stay, so history still renders.
--   * public.sessions          — completed and scheduled sessions carry their
--                                own skill_id and keep working. A session for a
--                                retired skill can still be attended, reviewed
--                                and counted; the teacher just cannot advertise
--                                that skill any more.
--   * skill_verifications      — a badge already earned is left alone.
--
-- Preview first. Run this on its own to see exactly what will go:
--
--   SELECT s.name, s.category,
--          count(*) FILTER (WHERE t.id IS NOT NULL) AS teaching_rows,
--          count(*) FILTER (WHERE l.id IS NOT NULL) AS learning_rows
--   FROM public.skills s
--   LEFT JOIN public.user_teaching_skills t ON t.skill_id = s.id
--   LEFT JOIN public.user_learning_skills l ON l.skill_id = s.id
--   WHERE NOT s.is_active
--   GROUP BY s.name, s.category
--   HAVING count(t.id) + count(l.id) > 0
--   ORDER BY s.name;

DELETE FROM public.user_teaching_skills t
USING public.skills s
WHERE t.skill_id = s.id AND NOT s.is_active;

DELETE FROM public.user_learning_skills l
USING public.skills s
WHERE l.skill_id = s.id AND NOT s.is_active;

-- Suggestion caches are keyed per user and hold rendered copy naming specific
-- skills ("2 learners want Bike Riding"). Drop them all so the next dashboard
-- load recomputes against the curated catalog instead of replaying advice about
-- skills nobody can select any more.
DELETE FROM public.ai_suggestions;

SELECT
  (SELECT count(*) FROM public.user_teaching_skills) AS teaching_rows_remaining,
  (SELECT count(*) FROM public.user_learning_skills) AS learning_rows_remaining;
