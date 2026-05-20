-- =============================================================================
-- Switch to teacher-only availability model.
--
-- Earlier we built get_intersection_windows to constrain the booking dialog
-- to the overlap of learner + teacher availability. That's correct but
-- assumes the learner has filled in their own weekly schedule, which most
-- never will. For a peer-to-peer student app, the simpler model is:
--
--   - Teacher posts when they're free to teach.
--   - Learner picks any time inside the teacher's free window, minus the
--     teacher's existing accepted bookings.
--   - It's on the learner to know their own schedule.
--
-- This migration:
--   1. Drops the now-unused get_intersection_windows function.
--   2. Adds get_teacher_windows(teacher_id, horizon_days), which returns
--      the teacher's `teach` availability minus their existing accepted /
--      active / pending_review bookings for the next N days.
--
-- The teacher's `teach` schedule is essentially public-facing ("when I
-- offer sessions"), so we allow any authenticated user to read another
-- user's teach windows via this RPC — unlike the original
-- "schedules are private" rule that applied to raw user_availability.
-- =============================================================================

DROP FUNCTION IF EXISTS public.get_intersection_windows(UUID, UUID, INT);

CREATE OR REPLACE FUNCTION public.get_teacher_windows(
  p_teacher_id UUID,
  p_horizon_days INT DEFAULT 14
)
RETURNS TABLE (window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_horizon INT := LEAST(GREATEST(COALESCE(p_horizon_days, 14), 1), 30);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH RECURSIVE day_offsets AS (
    SELECT 0 AS d
    UNION ALL
    SELECT d + 1 FROM day_offsets WHERE d + 1 < v_horizon
  ),
  candidate_days AS (
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'UTC') + (d || ' day')::interval) AS day_start
    FROM day_offsets
  ),
  -- Each candidate day produces 0..N teach windows landing on that UTC DOW.
  teacher_windows AS (
    SELECT
      cd.day_start + ((ta.start_minute) || ' minutes')::interval AS w_start,
      cd.day_start + ((ta.end_minute)   || ' minutes')::interval AS w_end
    FROM candidate_days cd
    JOIN public.user_availability ta
      ON ta.user_id = p_teacher_id
     AND ta.mode = 'teach'
     AND ta.day_of_week = EXTRACT(DOW FROM cd.day_start)::smallint
  ),
  -- Conflicting bookings clamped to each teach window.
  conflicts AS (
    SELECT
      tw.w_start,
      tw.w_end,
      GREATEST(s.scheduled_at, tw.w_start) AS c_start,
      LEAST(
        s.scheduled_at + make_interval(mins => s.duration_minutes),
        tw.w_end
      ) AS c_end
    FROM teacher_windows tw
    JOIN public.sessions s
      ON s.teacher_id = p_teacher_id
     AND s.status IN ('accepted', 'active', 'pending_review')
     AND s.scheduled_at IS NOT NULL
     AND tstzrange(
           s.scheduled_at,
           s.scheduled_at + make_interval(mins => s.duration_minutes)
         ) && tstzrange(tw.w_start, tw.w_end)
  ),
  -- Gaps before each conflict (LAG-based) — one row per conflict.
  pre_gaps AS (
    SELECT
      c.w_start,
      c.w_end,
      LAG(c.c_end, 1, c.w_start) OVER (
        PARTITION BY c.w_start, c.w_end ORDER BY c.c_start
      ) AS gap_start,
      c.c_start AS gap_end
    FROM conflicts c
  ),
  -- Tail gap (after the last conflict) plus the full window when there are
  -- no conflicts at all.
  tail_gaps AS (
    SELECT
      tw.w_start,
      tw.w_end,
      COALESCE(MAX(c.c_end), tw.w_start) AS gap_start,
      tw.w_end AS gap_end
    FROM teacher_windows tw
    LEFT JOIN conflicts c
      ON c.w_start = tw.w_start AND c.w_end = tw.w_end
    GROUP BY tw.w_start, tw.w_end
  ),
  all_gaps AS (
    SELECT gap_start, gap_end FROM pre_gaps
    UNION ALL
    SELECT gap_start, gap_end FROM tail_gaps
  )
  SELECT
    GREATEST(gap_start, now()) AS window_start,
    gap_end                    AS window_end
  FROM all_gaps
  WHERE gap_end > gap_start
    AND gap_end > now()
  ORDER BY window_start;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) TO authenticated;
