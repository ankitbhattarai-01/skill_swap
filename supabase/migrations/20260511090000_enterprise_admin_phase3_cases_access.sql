-- Enterprise admin Phase 3: case management and access governance workflows.

CREATE OR REPLACE FUNCTION public.get_admin_cases(p_limit INT DEFAULT 100)
RETURNS TABLE (
  id UUID,
  case_number TEXT,
  report_id UUID,
  severity TEXT,
  status TEXT,
  assigned_to UUID,
  assigned_to_email TEXT,
  sla_due_at TIMESTAMPTZ,
  escalation_level INT,
  disposition TEXT,
  created_by UUID,
  created_by_email TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  report_reason TEXT,
  report_status TEXT,
  reported_user_id UUID,
  reported_user_email TEXT,
  note_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation read permission is required.';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.case_number,
    c.report_id,
    c.severity,
    c.status,
    c.assigned_to,
    assignee.email::TEXT AS assigned_to_email,
    c.sla_due_at,
    c.escalation_level,
    c.disposition,
    c.created_by,
    creator.email::TEXT AS created_by_email,
    c.created_at,
    c.updated_at,
    r.reason AS report_reason,
    r.status AS report_status,
    r.reported_user_id,
    reported.email::TEXT AS reported_user_email,
    COALESCE(notes.note_count, 0)::INT AS note_count
  FROM public.admin_cases c
  LEFT JOIN public.reports r ON r.id = c.report_id
  LEFT JOIN auth.users assignee ON assignee.id = c.assigned_to
  LEFT JOIN auth.users creator ON creator.id = c.created_by
  LEFT JOIN auth.users reported ON reported.id = r.reported_user_id
  LEFT JOIN (
    SELECT case_id, COUNT(*)::INT AS note_count
    FROM public.admin_case_notes
    GROUP BY case_id
  ) notes ON notes.case_id = c.id
  ORDER BY
    CASE c.severity
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END,
    c.sla_due_at ASC,
    c.created_at DESC
  LIMIT v_limit;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_case_notes(p_case_id UUID)
RETURNS TABLE (
  id UUID,
  case_id UUID,
  author_id UUID,
  author_email TEXT,
  visibility TEXT,
  body TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation read permission is required.';
  END IF;

  RETURN QUERY
  SELECT
    n.id,
    n.case_id,
    n.author_id,
    u.email::TEXT AS author_email,
    n.visibility,
    n.body,
    n.created_at
  FROM public.admin_case_notes n
  LEFT JOIN auth.users u ON u.id = n.author_id
  WHERE n.case_id = p_case_id
  ORDER BY n.created_at DESC;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_create_case_from_report(
  p_report_id UUID,
  p_severity TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS public.admin_cases
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_case public.admin_cases%ROWTYPE;
  v_existing public.admin_cases%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'create') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation create permission is required.';
  END IF;

  IF p_severity NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid case severity.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.reports WHERE id = p_report_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Report was not found.';
  END IF;

  SELECT * INTO v_existing
  FROM public.admin_cases
  WHERE report_id = p_report_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.admin_cases (
    report_id,
    severity,
    status,
    created_by,
    sla_due_at
  )
  VALUES (
    p_report_id,
    p_severity,
    'open',
    v_actor,
    now() + CASE p_severity
      WHEN 'critical' THEN interval '4 hours'
      WHEN 'high' THEN interval '12 hours'
      WHEN 'medium' THEN interval '48 hours'
      ELSE interval '5 days'
    END
  )
  RETURNING * INTO v_case;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'create',
    'admin_case',
    v_case.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    to_jsonb(v_case),
    p_ticket_ref,
    v_correlation,
    p_idempotency_key,
    '{}'::jsonb
  );

  RETURN v_case;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_assign_case(
  p_case_id UUID,
  p_assigned_to UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS public.admin_cases
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before public.admin_cases%ROWTYPE;
  v_after public.admin_cases%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation update permission is required.';
  END IF;

  IF p_assigned_to IS NOT NULL
     AND NOT public.admin_has_permission(p_assigned_to, 'moderation', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Assignee must have moderation read permission.';
  END IF;

  SELECT * INTO v_before
  FROM public.admin_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Case was not found.';
  END IF;

  UPDATE public.admin_cases
  SET assigned_to = p_assigned_to,
      status = CASE WHEN p_assigned_to IS NULL THEN status ELSE 'assigned' END,
      updated_at = now()
  WHERE id = p_case_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'update',
    'admin_case',
    p_case_id::TEXT,
    p_reason_code,
    p_justification,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_update_case_status(
  p_case_id UUID,
  p_status TEXT,
  p_disposition TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS public.admin_cases
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before public.admin_cases%ROWTYPE;
  v_after public.admin_cases%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation update permission is required.';
  END IF;

  IF p_status NOT IN ('open', 'assigned', 'escalated', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid case status.';
  END IF;

  SELECT * INTO v_before
  FROM public.admin_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Case was not found.';
  END IF;

  UPDATE public.admin_cases
  SET status = p_status,
      disposition = NULLIF(btrim(COALESCE(p_disposition, '')), ''),
      escalation_level = CASE WHEN p_status = 'escalated' THEN escalation_level + 1 ELSE escalation_level END,
      updated_at = now()
  WHERE id = p_case_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'update',
    'admin_case',
    p_case_id::TEXT,
    p_reason_code,
    p_justification,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_add_case_note(
  p_case_id UUID,
  p_body TEXT,
  p_visibility TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS public.admin_case_notes
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_note public.admin_case_notes%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation update permission is required.';
  END IF;

  IF p_visibility NOT IN ('internal', 'compliance', 'incident-response') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid note visibility.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.admin_cases WHERE id = p_case_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Case was not found.';
  END IF;

  INSERT INTO public.admin_case_notes (case_id, author_id, visibility, body)
  VALUES (p_case_id, v_actor, p_visibility, btrim(p_body))
  RETURNING * INTO v_note;

  UPDATE public.admin_cases
  SET updated_at = now()
  WHERE id = p_case_id;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'update',
    'admin_case_note',
    v_note.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    jsonb_build_object(
      'case_id', v_note.case_id,
      'visibility', v_note.visibility,
      'body_length', char_length(v_note.body)
    ),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_note;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_access_governance()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL
     OR NOT (
       public.admin_has_permission(v_actor, 'access-governance', 'read')
       OR EXISTS (
         SELECT 1
         FROM public.admin_action_requests
         WHERE maker_id = v_actor
           AND request_type = 'access_grant'
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Access governance permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'pendingRequests', (
      SELECT COUNT(*)::INT
      FROM public.admin_action_requests
      WHERE request_type = 'access_grant'
        AND status = 'pending'
    ),
    'activeAssignments', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE revoked_at IS NULL
        AND starts_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
    ),
    'expiringSoon', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE revoked_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at > now()
        AND expires_at <= now() + interval '7 days'
    ),
    'overdueReviews', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE revoked_at IS NULL
        AND access_review_due_at < now()
    ),
    'breakGlassActive', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE break_glass = true
        AND revoked_at IS NULL
        AND starts_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
    ),
    'requests', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          ar.id,
          ar.status,
          ar.maker_id,
          maker.email::TEXT AS maker_email,
          ar.checker_id,
          checker.email::TEXT AS checker_email,
          ar.reason_code,
          ar.justification,
          ar.ticket_ref,
          ar.payload,
          ar.created_at,
          ar.expires_at,
          ar.decided_at,
          ar.executed_at
        FROM public.admin_action_requests ar
        LEFT JOIN auth.users maker ON maker.id = ar.maker_id
        LEFT JOIN auth.users checker ON checker.id = ar.checker_id
        WHERE ar.request_type = 'access_grant'
          AND (
            public.admin_has_permission(v_actor, 'access-governance', 'read')
            OR ar.maker_id = v_actor
          )
        ORDER BY ar.created_at DESC
        LIMIT 50
      ) x
    ), '[]'::jsonb),
    'assignments', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          a.id,
          a.user_id,
          u.email::TEXT AS user_email,
          r.slug AS role_slug,
          a.scope_type,
          a.scope_value,
          a.starts_at,
          a.expires_at,
          a.break_glass,
          a.incident_ticket_ref,
          a.access_review_due_at,
          a.revoked_at
        FROM public.admin_role_assignments a
        JOIN public.admin_roles r ON r.id = a.role_id
        LEFT JOIN auth.users u ON u.id = a.user_id
        WHERE public.admin_has_permission(v_actor, 'access-governance', 'read')
           OR a.user_id = v_actor
        ORDER BY COALESCE(a.expires_at, a.access_review_due_at) ASC
        LIMIT 50
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.request_admin_access(
  p_role_slug TEXT,
  p_duration_hours INT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_role public.admin_roles%ROWTYPE;
  v_request public.admin_action_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Sign in first.';
  END IF;

  SELECT * INTO v_role
  FROM public.admin_roles
  WHERE slug = p_role_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Requested role was not found.';
  END IF;

  IF p_duration_hours IS NULL OR p_duration_hours < 1 OR p_duration_hours > 720 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Duration must be 1 to 720 hours.';
  END IF;

  INSERT INTO public.admin_action_requests (
    request_type,
    domain,
    action,
    entity_type,
    entity_id,
    payload,
    maker_id,
    reason_code,
    justification,
    ticket_ref,
    required_permission_domain,
    required_permission_action,
    expires_at
  )
  VALUES (
    'access_grant',
    'access-governance',
    'approve',
    'admin_role_assignment',
    v_actor::TEXT,
    jsonb_build_object(
      'requested_user_id', v_actor,
      'requested_role_slug', p_role_slug,
      'duration_hours', p_duration_hours,
      'scope_type', 'global'
    ),
    v_actor,
    'access:jit_grant',
    p_justification,
    p_ticket_ref,
    'access-governance',
    'approve',
    now() + interval '7 days'
  )
  RETURNING * INTO v_request;

  RETURN v_request;
END;
$$;
CREATE OR REPLACE FUNCTION public.approve_admin_access_request(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_role_assignments
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_request public.admin_action_requests%ROWTYPE;
  v_role public.admin_roles%ROWTYPE;
  v_assignment public.admin_role_assignments%ROWTYPE;
  v_existing_assignment UUID;
  v_requested_user UUID;
  v_duration INT;
  v_role_slug TEXT;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'access-governance', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Access approval permission is required.';
  END IF;

  SELECT * INTO v_request
  FROM public.admin_action_requests
  WHERE id = p_request_id
    AND request_type = 'access_grant'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Access request was not found.';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Access request is not pending.';
  END IF;

  IF v_request.maker_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Maker cannot approve own access request.';
  END IF;

  v_requested_user := (v_request.payload ->> 'requested_user_id')::UUID;
  v_role_slug := v_request.payload ->> 'requested_role_slug';
  v_duration := (v_request.payload ->> 'duration_hours')::INT;

  SELECT * INTO v_role
  FROM public.admin_roles
  WHERE slug = v_role_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Requested role was not found.';
  END IF;

  SELECT id INTO v_existing_assignment
  FROM public.admin_role_assignments
  WHERE user_id = v_requested_user
    AND role_id = v_role.id
    AND scope_type = 'global'
    AND scope_value IS NULL
    AND revoked_at IS NULL
  FOR UPDATE;

  IF v_existing_assignment IS NULL THEN
    INSERT INTO public.admin_role_assignments (
      user_id,
      role_id,
      scope_type,
      starts_at,
      expires_at,
      granted_by,
      grant_reason
    )
    VALUES (
      v_requested_user,
      v_role.id,
      'global',
      now(),
      now() + make_interval(hours => v_duration),
      v_actor,
      p_justification
    )
    RETURNING * INTO v_assignment;
  ELSE
    UPDATE public.admin_role_assignments
    SET expires_at = now() + make_interval(hours => v_duration),
        granted_by = v_actor,
        grant_reason = p_justification,
        access_review_due_at = now() + interval '90 days'
    WHERE id = v_existing_assignment
    RETURNING * INTO v_assignment;
  END IF;

  UPDATE public.admin_action_requests
  SET status = 'approved',
      checker_id = v_actor,
      decided_at = now(),
      executed_at = now()
  WHERE id = p_request_id;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'access-governance',
    'approve',
    'admin_role_assignment',
    v_assignment.id::TEXT,
    p_reason_code,
    p_justification,
    to_jsonb(v_request),
    to_jsonb(v_assignment),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_assignment;
END;
$$;
CREATE OR REPLACE FUNCTION public.reject_admin_access_request(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_request public.admin_action_requests%ROWTYPE;
  v_after public.admin_action_requests%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'access-governance', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Access approval permission is required.';
  END IF;

  SELECT * INTO v_request
  FROM public.admin_action_requests
  WHERE id = p_request_id
    AND request_type = 'access_grant'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Access request was not found.';
  END IF;

  IF v_request.maker_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Maker cannot reject own access request.';
  END IF;

  UPDATE public.admin_action_requests
  SET status = 'rejected',
      checker_id = v_actor,
      decided_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'access-governance',
    'approve',
    'admin_action_request',
    p_request_id::TEXT,
    p_reason_code,
    p_justification,
    to_jsonb(v_request),
    to_jsonb(v_after),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_after;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_cases(INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_case_notes(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_access_governance() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.request_admin_access(TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_cases(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_case_notes(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_access_governance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_admin_access(TEXT, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
