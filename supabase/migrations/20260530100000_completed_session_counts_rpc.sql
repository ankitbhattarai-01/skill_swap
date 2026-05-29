-- Collapse the dashboard's teacher/seeker "completed sessions" fan-out.
--
-- The client used to count candidate experience by pulling EVERY completed
-- sessions row for a batch of candidate user ids across two queries
-- (one keyed on teacher_id, one on learner_id) and tallying them in JS — run
-- once for the teacher pipeline and again for the seeker pipeline, i.e. four
-- row-streaming round trips per dashboard load. This RPC does the grouping in
-- Postgres and returns only (user_id, completed_count).
--
-- SECURITY INVOKER on purpose: the function runs under the caller's RLS, so it
-- sees exactly the same completed sessions the previous client queries did. The
-- ranking signal is identical; only the round trips and payload shrink.
CREATE OR REPLACE FUNCTION public.completed_session_counts(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, completed_count bigint)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
  SELECT u AS user_id, count(*)::bigint AS completed_count
  FROM unnest(p_user_ids) AS u
  JOIN public.sessions s
    ON (s.teacher_id = u OR s.learner_id = u)
   AND s.status = 'completed'
  GROUP BY u;
$$;

REVOKE EXECUTE ON FUNCTION public.completed_session_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.completed_session_counts(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
