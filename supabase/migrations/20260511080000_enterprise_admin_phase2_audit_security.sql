-- Enterprise admin Phase 2: audit viewer RPCs, hash-chain verification,
-- export manifest support, and security operations dashboard.

CREATE OR REPLACE FUNCTION public.get_admin_audit_events(
  p_limit INT DEFAULT 100,
  p_domain TEXT DEFAULT NULL,
  p_action TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  sequence BIGINT,
  id UUID,
  created_at TIMESTAMPTZ,
  actor_id UUID,
  actor_email TEXT,
  actor_role_snapshot JSONB,
  domain TEXT,
  action TEXT,
  entity_type TEXT,
  entity_id TEXT,
  reason_code TEXT,
  justification TEXT,
  ticket_ref TEXT,
  correlation_id UUID,
  idempotency_key TEXT,
  retention_class TEXT,
  purge_after TIMESTAMPTZ,
  legal_hold BOOLEAN,
  checksum_version INT,
  prev_event_hash TEXT,
  event_hash TEXT,
  before_snapshot JSONB,
  after_snapshot JSONB
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
  IF v_actor IS NULL
     OR NOT (
       public.admin_has_permission(v_actor, 'compliance', 'read')
       OR public.admin_has_permission(v_actor, 'security', 'read')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Audit read permission is required.';
  END IF;

  RETURN QUERY
  SELECT
    e.sequence,
    e.id,
    e.created_at,
    e.actor_id,
    u.email::TEXT AS actor_email,
    e.actor_role_snapshot,
    e.domain,
    e.action,
    e.entity_type,
    e.entity_id,
    e.reason_code,
    e.justification,
    e.ticket_ref,
    e.correlation_id,
    e.idempotency_key,
    e.retention_class,
    e.purge_after,
    e.legal_hold,
    e.checksum_version,
    e.prev_event_hash,
    e.event_hash,
    e.before_snapshot,
    e.after_snapshot
  FROM public.admin_audit_events e
  LEFT JOIN auth.users u ON u.id = e.actor_id
  WHERE (p_domain IS NULL OR e.domain = p_domain)
    AND (p_action IS NULL OR e.action = p_action)
    AND (p_actor_id IS NULL OR e.actor_id = p_actor_id)
    AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
    AND (p_entity_id IS NULL OR e.entity_id = p_entity_id)
    AND (p_from IS NULL OR e.created_at >= p_from)
    AND (p_to IS NULL OR e.created_at <= p_to)
  ORDER BY e.sequence DESC
  LIMIT v_limit;
END;
$$;
CREATE OR REPLACE FUNCTION public.verify_admin_audit_chain(p_limit INT DEFAULT 1000)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 10000);
  v_expected_prev TEXT := NULL;
  v_recomputed TEXT;
  v_checked INT := 0;
  v_first_failure BIGINT := NULL;
  v_latest_hash TEXT := NULL;
  v_row public.admin_audit_events%ROWTYPE;
BEGIN
  IF v_actor IS NULL
     OR NOT (
       public.admin_has_permission(v_actor, 'compliance', 'read')
       OR public.admin_has_permission(v_actor, 'security', 'read')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Audit verification permission is required.';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.admin_audit_events
    ORDER BY sequence ASC
    LIMIT v_limit
  LOOP
    v_checked := v_checked + 1;

    IF v_row.prev_event_hash IS DISTINCT FROM v_expected_prev THEN
      v_first_failure := v_row.sequence;
      EXIT;
    END IF;

    v_recomputed := encode(
      digest(
        concat_ws(
          '|',
          v_row.sequence::TEXT,
          v_row.id::TEXT,
          COALESCE(v_row.actor_id::TEXT, ''),
          v_row.domain,
          v_row.action,
          v_row.entity_type,
          COALESCE(v_row.entity_id, ''),
          v_row.reason_code,
          v_row.justification,
          COALESCE(v_row.before_snapshot::TEXT, ''),
          COALESCE(v_row.after_snapshot::TEXT, ''),
          COALESCE(v_row.prev_event_hash, ''),
          v_row.correlation_id::TEXT
        ),
        'sha256'
      ),
      'hex'
    );

    IF v_recomputed IS DISTINCT FROM v_row.event_hash THEN
      v_first_failure := v_row.sequence;
      EXIT;
    END IF;

    v_expected_prev := v_row.event_hash;
    v_latest_hash := v_row.event_hash;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_first_failure IS NULL,
    'checkedEvents', v_checked,
    'firstFailureSequence', v_first_failure,
    'latestHash', v_latest_hash,
    'checksumVersion', 1,
    'verifiedAt', now()
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.create_admin_audit_export_manifest(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_count INT;
  v_manifest_hash TEXT;
  v_correlation UUID := gen_random_uuid();
  v_manifest JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'compliance', 'export') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Audit export permission is required.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A valid export time range is required.';
  END IF;

  SELECT
    COUNT(*)::INT,
    encode(digest(COALESCE(string_agg(event_hash, '' ORDER BY sequence), ''), 'sha256'), 'hex')
  INTO v_count, v_manifest_hash
  FROM public.admin_audit_events
  WHERE created_at >= p_from
    AND created_at <= p_to;

  v_manifest := jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'eventCount', v_count,
    'manifestHash', v_manifest_hash,
    'generatedAt', now(),
    'generatedBy', v_actor,
    'correlationId', v_correlation
  );

  PERFORM public.admin_log_audit_event(
    v_actor,
    'compliance',
    'export',
    'admin_audit_events',
    'audit-export',
    p_reason_code,
    p_justification,
    NULL,
    v_manifest,
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN v_manifest;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_security_dashboard()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'security', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Security read permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'policyDenials24h', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE action = 'policy_denied'
        AND created_at > now() - interval '24 hours'
    ),
    'policyDenials7d', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE action = 'policy_denied'
        AND created_at > now() - interval '7 days'
    ),
    'breakGlassActive', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE break_glass = true
        AND revoked_at IS NULL
        AND starts_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
    ),
    'privilegedActions24h', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE created_at > now() - interval '24 hours'
        AND action <> 'policy_denied'
    ),
    'suspiciousBursts24h', (
      SELECT COUNT(*)::INT
      FROM (
        SELECT actor_id
        FROM public.admin_audit_events
        WHERE created_at > now() - interval '24 hours'
        GROUP BY actor_id
        HAVING COUNT(*) >= 25
      ) bursts
    ),
    'recentPolicyDenials', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          e.created_at,
          e.actor_id,
          u.email::TEXT AS actor_email,
          e.domain,
          e.entity_type,
          e.entity_id,
          e.reason_code,
          e.correlation_id
        FROM public.admin_audit_events e
        LEFT JOIN auth.users u ON u.id = e.actor_id
        WHERE e.action = 'policy_denied'
        ORDER BY e.sequence DESC
        LIMIT 10
      ) x
    ), '[]'::jsonb),
    'activeBreakGlass', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          a.user_id,
          u.email::TEXT AS user_email,
          a.starts_at,
          a.expires_at,
          a.incident_ticket_ref,
          a.grant_reason
        FROM public.admin_role_assignments a
        LEFT JOIN auth.users u ON u.id = a.user_id
        WHERE a.break_glass = true
          AND a.revoked_at IS NULL
          AND a.starts_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
        ORDER BY a.expires_at ASC
        LIMIT 10
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.verify_admin_audit_chain(INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_security_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_security_dashboard() TO authenticated;
