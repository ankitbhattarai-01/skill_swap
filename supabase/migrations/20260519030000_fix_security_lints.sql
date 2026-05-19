-- =============================================================================
-- Fix Supabase Security Lints (2026-05-19 advisor report)
--
-- Three findings to address, none of which require a behavior change:
--
--   1. INFO  rls_enabled_no_policy on private.email_dispatch_config
--      RLS is enabled on the table but no policies exist. The table lives
--      in `private` (not exposed via PostgREST) and already has all grants
--      revoked from anon/authenticated, so RLS adds nothing. Disable RLS
--      explicitly so the lint clears.
--
--   2. WARN  authenticated_security_definer_function_executable on
--           public.get_teacher_windows(uuid, int)
--   3. WARN  authenticated_security_definer_function_executable on
--           public.teachers_free_time_status(uuid[], int, int)
--
--      Both functions need to read OTHER users' raw `user_availability`
--      rows + sessions to compute a teacher's free windows. The current
--      privacy model keeps user_availability private (RLS = own rows
--      only), so the functions MUST run as definer.
--
--      Per the advisor remediation ("...or move it out of your exposed
--      API schema..."), relocate the privileged body to `private.*_impl`
--      and have the PostgREST-facing public functions become SECURITY
--      INVOKER wrappers that just delegate. Same pattern used in
--      20260513170000_move_settings_helper_to_private_schema.sql.
--
--      Externally-observable behavior is identical: same arguments, same
--      result rows, same EXECUTE grant on the public name, same RPC URL.
--
-- The fourth advisor finding (auth_leaked_password_protection) is a
-- project-level Auth setting and cannot be flipped from SQL. See the
-- companion note in the PR / chat: enable it in the Supabase dashboard
-- under Authentication > Policies > "Enable leaked password protection".
-- =============================================================================


-- ─── 1. Disable RLS on the private email-dispatch config table ─────────────
ALTER TABLE private.email_dispatch_config DISABLE ROW LEVEL SECURITY;


-- ─── 2. Relocate get_teacher_windows ───────────────────────────────────────
-- Body moves to private.get_teacher_windows_impl (SECURITY DEFINER, same
-- arguments, same logic). The public name is recreated as a thin SECURITY
-- INVOKER wrapper so PostgREST still serves /rest/v1/rpc/get_teacher_windows.

CREATE OR REPLACE FUNCTION private.get_teacher_windows_impl(
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

REVOKE EXECUTE ON FUNCTION private.get_teacher_windows_impl(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_teacher_windows_impl(UUID, INT) TO authenticated;

-- Replace the public function with an INVOKER wrapper. Drop first because
-- the previous version was SECURITY DEFINER and CREATE OR REPLACE doesn't
-- allow flipping the security mode in some Postgres versions.
DROP FUNCTION IF EXISTS public.get_teacher_windows(UUID, INT);

CREATE FUNCTION public.get_teacher_windows(
  p_teacher_id UUID,
  p_horizon_days INT DEFAULT 14
)
RETURNS TABLE (window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private
AS $$
  SELECT window_start, window_end
  FROM private.get_teacher_windows_impl(p_teacher_id, p_horizon_days);
$$;

REVOKE EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) TO authenticated;


-- ─── 3. Relocate teachers_free_time_status ────────────────────────────────
-- Same shape: definer body moves to private, public wrapper is invoker.
-- The impl calls private.get_teacher_windows_impl directly (not through
-- the public wrapper) so it stays within the privileged context.

CREATE OR REPLACE FUNCTION private.teachers_free_time_status_impl(
  p_teacher_ids UUID[],
  p_duration_minutes INT DEFAULT 30,
  p_horizon_days INT DEFAULT 7
)
RETURNS TABLE (teacher_id UUID, next_slot TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private
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
      SELECT gw.window_start INTO v_next
      FROM private.get_teacher_windows_impl(v_tid, v_horizon) gw
      WHERE (gw.window_end - gw.window_start) >= make_interval(mins => v_duration)
      ORDER BY gw.window_start
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

REVOKE EXECUTE ON FUNCTION private.teachers_free_time_status_impl(UUID[], INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.teachers_free_time_status_impl(UUID[], INT, INT) TO authenticated;

DROP FUNCTION IF EXISTS public.teachers_free_time_status(UUID[], INT, INT);

CREATE FUNCTION public.teachers_free_time_status(
  p_teacher_ids UUID[],
  p_duration_minutes INT DEFAULT 30,
  p_horizon_days INT DEFAULT 7
)
RETURNS TABLE (teacher_id UUID, next_slot TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private
AS $$
  SELECT teacher_id, next_slot
  FROM private.teachers_free_time_status_impl(p_teacher_ids, p_duration_minutes, p_horizon_days);
$$;

REVOKE EXECUTE ON FUNCTION public.teachers_free_time_status(UUID[], INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teachers_free_time_status(UUID[], INT, INT) TO authenticated;


-- ─── 4. Reload PostgREST schema cache so the wrapper is picked up ─────────
NOTIFY pgrst, 'reload schema';
