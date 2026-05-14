-- =============================================================================
-- Bulk intersection status for the recommendation surfaces (Explore page,
-- dashboard matching panels).
--
-- compute_intersection_slots() answers "what slots are available for THIS
-- one pair?". The Explore and dashboard surfaces need the bulk version:
-- given N candidate teachers, which ones overlap with my availability at
-- all, and when is the earliest match?
--
-- This RPC takes an array of teacher UUIDs and returns one row per teacher
-- with their earliest matching slot (NULL if none in horizon). Frontend
-- uses the result to:
--   - sort teachers with available time above those without
--   - render a "Free Wed 7pm" badge on each card
--   - optionally hide teachers with no overlap via a filter toggle
--
-- Implemented as a thin loop over compute_intersection_slots(); each
-- iteration short-circuits via LIMIT 1 so we're not computing full
-- intersection plans for the explore page.
-- =============================================================================


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

  -- Cap at 100 — the explore page paginates above that anyway, and this
  -- caps per-request cost.
  IF array_length(p_teacher_ids, 1) > 100 THEN
    RAISE EXCEPTION 'Too many teacher IDs (max 100)';
  END IF;

  FOREACH v_tid IN ARRAY p_teacher_ids LOOP
    -- Skip self silently. compute_intersection_slots() would reject anyway.
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
      -- Per-teacher errors (e.g. auth check inside the inner function
      -- returning a "not allowed" for some edge case) shouldn't poison
      -- the whole bulk result. Treat as "no slot".
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
