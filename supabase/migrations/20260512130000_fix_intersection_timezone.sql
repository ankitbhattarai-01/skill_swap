-- =============================================================================
-- Pin TimeZone='UTC' inside the intersection RPCs.
--
-- The original compute_intersection_slots() does its math in naive
-- timestamps (date_trunc on `now() AT TIME ZONE 'UTC'`). When that naive
-- value is later compared against now() (timestamptz), Postgres uses the
-- session TimeZone to cast — so if the PostgREST session is not UTC,
-- slot timestamps shift and valid overlaps get filtered out.
-- Pinning SET TimeZone='UTC' on the function makes it independent of
-- whatever the caller's session has configured.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.compute_intersection_slots(
  p_learner_id UUID,
  p_teacher_id UUID,
  p_duration_minutes INT,
  p_horizon_days INT DEFAULT 7,
  p_max_slots INT DEFAULT 3
)
RETURNS TABLE (proposed_start TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET TimeZone = 'UTC'
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_horizon INT := LEAST(GREATEST(COALESCE(p_horizon_days, 7), 1), 30);
  v_max    INT := LEAST(GREATEST(COALESCE(p_max_slots, 3), 1), 10);
  v_duration_min INT := LEAST(GREATEST(p_duration_minutes, 5), 240);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_caller <> p_learner_id
     AND v_caller <> p_teacher_id
     AND NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not allowed to compute slots for this pair';
  END IF;

  RETURN QUERY
  WITH RECURSIVE day_offsets AS (
    SELECT 0 AS d
    UNION ALL
    SELECT d + 1 FROM day_offsets WHERE d + 1 < v_horizon
  ),
  -- day_start is a true timestamptz anchored at UTC midnight. The trailing
  -- AT TIME ZONE 'UTC' converts the naive timestamp produced by date_trunc
  -- back into timestamptz, which is what the function signature requires
  -- (PL/pgSQL RETURN QUERY does NOT do the implicit cast that plain SQL
  -- would — without this, the function raises a type-mismatch error on
  -- every call and teachers_intersection_status silently turns that into
  -- next_slot = NULL).
  candidate_days AS (
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'UTC') + (d || ' day')::interval) AT TIME ZONE 'UTC' AS day_start
    FROM day_offsets
  ),
  learner_windows AS (
    SELECT
      cd.day_start + ((la.start_minute) || ' minutes')::interval AS w_start,
      cd.day_start + ((la.end_minute)   || ' minutes')::interval AS w_end
    FROM candidate_days cd
    JOIN public.user_availability la
      ON la.user_id = p_learner_id
     AND la.mode = 'learn'
     AND la.day_of_week = EXTRACT(DOW FROM cd.day_start)::smallint
  ),
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
  intersections AS (
    SELECT
      GREATEST(lw.w_start, tw.w_start) AS int_start,
      LEAST(lw.w_end, tw.w_end)        AS int_end
    FROM learner_windows lw, teacher_windows tw
    WHERE GREATEST(lw.w_start, tw.w_start) < LEAST(lw.w_end, tw.w_end)
  ),
  candidate_slots AS (
    SELECT int_start AS slot_start
    FROM intersections
    WHERE int_start > now()
      AND (int_end - int_start) >= make_interval(mins => v_duration_min)
  ),
  slots_minus_conflicts AS (
    SELECT cs.slot_start
    FROM candidate_slots cs
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.teacher_id = p_teacher_id
        AND s.status IN ('accepted', 'active', 'pending_review')
        AND s.scheduled_at IS NOT NULL
        AND tstzrange(
              s.scheduled_at,
              s.scheduled_at + make_interval(mins => s.duration_minutes)
            )
            && tstzrange(
              cs.slot_start,
              cs.slot_start + make_interval(mins => v_duration_min)
            )
    )
  )
  SELECT slot_start
  FROM slots_minus_conflicts
  ORDER BY slot_start
  LIMIT v_max;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) TO authenticated;


-- Re-create teachers_intersection_status with the same UTC pin, since it
-- calls compute_intersection_slots inline and the EXCEPTION block swallows
-- any session-TZ-related casting errors silently.

CREATE OR REPLACE FUNCTION public.teachers_intersection_status(
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
      SELECT proposed_start INTO v_next
      FROM public.compute_intersection_slots(
        v_caller, v_tid, p_duration_minutes, p_horizon_days, 1
      )
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

REVOKE EXECUTE ON FUNCTION public.teachers_intersection_status(UUID[], INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teachers_intersection_status(UUID[], INT, INT) TO authenticated;
