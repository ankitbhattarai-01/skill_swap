-- Revoke an active admin role assignment.
--
-- Rounds out the access governance lifecycle (request → approve → revoke).
-- Mirrors the pattern of approve_admin_access_request: SECURITY DEFINER,
-- access-governance:approve permission required, separation-of-duties
-- enforced (cannot revoke own assignment), and every revocation is written
-- to the tamper-evident audit chain via admin_log_audit_event.

CREATE OR REPLACE FUNCTION public.revoke_admin_assignment(
  p_assignment_id UUID,
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
  v_before public.admin_role_assignments%ROWTYPE;
  v_after public.admin_role_assignments%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL
     OR NOT public.admin_has_permission(v_actor, 'access-governance', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Access approval permission is required to revoke an assignment.';
  END IF;

  IF coalesce(length(btrim(p_justification)), 0) < 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Justification must be at least 8 characters.';
  END IF;

  IF coalesce(length(btrim(p_ticket_ref)), 0) < 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Ticket reference is required to revoke an assignment.';
  END IF;

  SELECT * INTO v_before
  FROM public.admin_role_assignments
  WHERE id = p_assignment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'Assignment was not found.';
  END IF;

  IF v_before.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Assignment is already revoked.';
  END IF;

  -- Separation of duties: an approver cannot revoke their own assignment.
  IF v_before.user_id = v_actor THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You cannot revoke your own assignment.';
  END IF;

  UPDATE public.admin_role_assignments
  SET revoked_at = now(),
      revoked_by = v_actor,
      revoked_reason = btrim(p_justification)
  WHERE id = p_assignment_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'access-governance',
    'override',
    'admin_role_assignment',
    v_after.id::TEXT,
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
REVOKE EXECUTE ON FUNCTION public.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT)
  TO authenticated;
