-- Admin sessions investigation surface.

CREATE OR REPLACE FUNCTION public.get_admin_sessions_dashboard(
  p_limit INT DEFAULT 75,
  p_status TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_status TEXT := NULLIF(btrim(COALESCE(p_status, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'sessions', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Sessions read permission is required.';
  END IF;

  IF v_status IS NOT NULL AND v_status NOT IN ('pending', 'accepted', 'rejected', 'active', 'completed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid session status filter.';
  END IF;

  RETURN jsonb_build_object(
    'statusCounts', COALESCE((
      SELECT jsonb_object_agg(status, count)
      FROM (
        SELECT status, COUNT(*)::INT AS count
        FROM public.sessions
        GROUP BY status
      ) s
    ), '{}'::jsonb),
    'totalSessions', (
      SELECT COUNT(*)::INT FROM public.sessions
    ),
    'activeSessions', (
      SELECT COUNT(*)::INT
      FROM public.sessions
      WHERE status IN ('accepted', 'active')
    ),
    'scheduledNext7d', (
      SELECT COUNT(*)::INT
      FROM public.sessions
      WHERE scheduled_at >= now()
        AND scheduled_at < now() + interval '7 days'
        AND status IN ('pending', 'accepted', 'active')
    ),
    'stuckEscrow', (
      SELECT COUNT(*)::INT
      FROM public.sessions
      WHERE escrow_held = true
        AND status IN ('accepted', 'active')
        AND COALESCE(scheduled_at, updated_at, created_at) < now() - interval '14 days'
    ),
    'reportedSessions', (
      SELECT COUNT(DISTINCT session_id)::INT
      FROM public.reports
      WHERE session_id IS NOT NULL
        AND status IN ('open', 'reviewing')
    ),
    'recentSessions', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          s.id,
          s.status,
          s.credits,
          s.duration_minutes,
          s.escrow_held,
          s.scheduled_at,
          s.created_at,
          s.updated_at,
          s.learner_id,
          public.admin_mask_email(learner.email::TEXT) AS learner_email,
          s.teacher_id,
          public.admin_mask_email(teacher.email::TEXT) AS teacher_email,
          sk.name AS skill_name,
          sk.category AS skill_category,
          (
            SELECT COUNT(*)::INT
            FROM public.reports r
            WHERE r.session_id = s.id
              AND r.status IN ('open', 'reviewing')
          ) AS open_report_count
        FROM public.sessions s
        LEFT JOIN auth.users learner ON learner.id = s.learner_id
        LEFT JOIN auth.users teacher ON teacher.id = s.teacher_id
        LEFT JOIN public.skills sk ON sk.id = s.skill_id
        WHERE v_status IS NULL OR s.status::TEXT = v_status
        ORDER BY s.updated_at DESC
        LIMIT least(greatest(COALESCE(p_limit, 75), 1), 150)
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_sessions_dashboard(INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_sessions_dashboard(INT, TEXT) TO authenticated;
NOTIFY pgrst, 'reload schema';
