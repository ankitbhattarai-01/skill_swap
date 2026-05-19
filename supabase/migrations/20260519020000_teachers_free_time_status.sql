-- =============================================================================
-- teachers_free_time_status — bulk "next free slot" lookup, teacher-only.
--
-- Sibling of teachers_intersection_status, but for the simpler model where
-- bookings depend only on the teacher's free `teach` time (no learner-side
-- availability check). Used by Explore and Dashboard to surface a per-card
-- "Free Tue 7pm" chip and to gate the "Only with free times" filter.
--
-- Returns the earliest 30-min-fitting free slot per teacher within the
-- horizon, where "free" = inside a `teach` window AND not already booked.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.teachers_free_time_status(
  p_teacher_ids UUID[],
  p_duration_minutes INT DEFAULT 30,
  p_horizon_days INT DEFAULT 7
)
RETURNS TABLE (teacher_id UUID, next_slot TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_tid UUID;
  v_next TIMESTAMPTZ;
  v_duration INT := LEAST(GREATEST(COALESCE(p_duration_minutes, 30), 5), 240);
  v_horizon INT  := LEAST(GREATEST(COALESCE(p_horizon_days, 7), 1), 30);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_teacher_ids IS NULL OR array_length(p_teacher_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_teacher_ids, 1) > 100 THEN
    RAISE EXCEPTION 'Too many teacher IDs (max 100)';
  END IF;

  FOREACH v_tid IN ARRAY p_teacher_ids LOOP
    IF v_tid = v_caller THEN
      CONTINUE;
    END IF;

    BEGIN
      -- Earliest window from get_teacher_windows that fits the duration.
      SELECT window_start INTO v_next
      FROM public.get_teacher_windows(v_tid, v_horizon)
      WHERE (window_end - window_start) >= make_interval(mins => v_duration)
      ORDER BY window_start
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_next := NULL;
    END;

    teacher_id := v_tid;
    next_slot := v_next;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.teachers_free_time_status(UUID[], INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teachers_free_time_status(UUID[], INT, INT) TO authenticated;
