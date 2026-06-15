-- =============================================================================
-- Hide already-booked times in the slot pickers (UX companion to the
-- double-booking trigger in 20260615020000).
--
-- The trigger guarantees a clashing session can't be ACCEPTED, but a learner
-- could still pick a doomed time and only discover it when the teacher's accept
-- fails. Better to never offer the time at all. Two gaps closed here:
--
--   1. get_teacher_windows only subtracted sessions where the teacher was the
--      `teacher_id`. When a person is the LEARNER of a session (e.g. Utsab
--      learning in the 8 PM leg of a swap), that row has teacher_id = the other
--      party, so it never narrowed Utsab's own teaching windows — and a third
--      learner was still offered Utsab's 8 PM slot. Now we subtract any session
--      the teacher is in, on either side.
--
--   2. There was no way to also hide times the REQUESTER themselves is busy. Add
--      get_my_busy_intervals(): the caller's own committed session windows, fed
--      into the picker so you can't pick a slot you're already booked for.
-- =============================================================================


-- ─── 1. get_teacher_windows: subtract sessions on EITHER side ────────────────
-- Body copied VERBATIM from 20260519010000 — the only change is the conflicts
-- join predicate, now (teacher_id = p OR learner_id = p) instead of teacher_id
-- alone, so the teacher's learning commitments also carve out their windows.
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
  -- Conflicting bookings clamped to each teach window. A session counts whether
  -- the teacher is teaching it OR attending it as a learner — either way they
  -- can't take a new booking in that slot.
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
      ON (s.teacher_id = p_teacher_id OR s.learner_id = p_teacher_id)
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


-- ─── 2. get_my_busy_intervals: the caller's own committed session windows ────
-- Returns [busy_start, busy_end) for every session the caller is committed to
-- (as teacher or learner) within the horizon. SECURITY INVOKER is fine: the
-- caller is a participant of every row returned, so the "Participants view
-- sessions" RLS policy already grants read access.
CREATE OR REPLACE FUNCTION public.get_my_busy_intervals(
  p_horizon_days INT DEFAULT 14
)
RETURNS TABLE (busy_start TIMESTAMPTZ, busy_end TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    s.scheduled_at AS busy_start,
    s.scheduled_at + make_interval(mins => s.duration_minutes) AS busy_end
  FROM public.sessions s
  WHERE (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    AND s.status IN ('accepted', 'active', 'pending_review')
    AND s.scheduled_at IS NOT NULL
    AND s.scheduled_at
        < now() + make_interval(days => LEAST(GREATEST(COALESCE(p_horizon_days, 14), 1), 30))
    AND s.scheduled_at + make_interval(mins => s.duration_minutes) > now();
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_busy_intervals(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_busy_intervals(INT) TO authenticated;

NOTIFY pgrst, 'reload schema';
