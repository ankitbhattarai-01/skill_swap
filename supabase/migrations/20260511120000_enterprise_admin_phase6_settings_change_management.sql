-- Enterprise admin Phase 6: settings change management, versioned publish,
-- rollback proposals, and feature-flag-ready active config.

CREATE TABLE IF NOT EXISTS public.admin_active_settings (
  setting_key TEXT PRIMARY KEY,
  current_version_id UUID REFERENCES public.admin_settings_versions(id) ON DELETE RESTRICT,
  current_value JSONB NOT NULL,
  published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_settings_versions_status_idx
  ON public.admin_settings_versions (status, created_at DESC);
ALTER TABLE public.admin_active_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Active settings read" ON public.admin_active_settings;
CREATE POLICY "Active settings read" ON public.admin_active_settings
  FOR SELECT TO authenticated
  USING (public.admin_has_permission(auth.uid(), 'settings', 'read'));
REVOKE ALL ON public.admin_active_settings FROM anon, authenticated;
GRANT SELECT ON public.admin_active_settings TO authenticated;
INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('settings:proposal', 'settings', 'update', 'Settings change proposal', true),
  ('settings:publish', 'settings', 'approve', 'Settings publish', true),
  ('settings:rollback', 'settings', 'update', 'Settings rollback proposal', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;
CREATE OR REPLACE FUNCTION public.get_admin_settings_dashboard()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'settings', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Settings read permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'pendingApprovals', (
      SELECT COUNT(*)::INT
      FROM public.admin_settings_versions
      WHERE status = 'pending_approval'
    ),
    'publishedSettings', (
      SELECT COUNT(*)::INT
      FROM public.admin_active_settings
    ),
    'changes7d', (
      SELECT COUNT(*)::INT
      FROM public.admin_settings_versions
      WHERE created_at > now() - interval '7 days'
    ),
    'activeSettings', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          s.setting_key,
          s.current_version_id,
          s.current_value,
          s.published_by,
          u.email::TEXT AS published_by_email,
          s.published_at,
          s.updated_at
        FROM public.admin_active_settings s
        LEFT JOIN auth.users u ON u.id = s.published_by
        ORDER BY s.setting_key
      ) x
    ), '[]'::jsonb),
    'versions', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          v.id,
          v.setting_key,
          v.version,
          v.status,
          v.proposed_value,
          v.previous_value,
          v.proposer_id,
          proposer.email::TEXT AS proposer_email,
          v.approver_id,
          approver.email::TEXT AS approver_email,
          v.reason_code,
          v.justification,
          v.published_at,
          v.created_at
        FROM public.admin_settings_versions v
        LEFT JOIN auth.users proposer ON proposer.id = v.proposer_id
        LEFT JOIN auth.users approver ON approver.id = v.approver_id
        ORDER BY v.created_at DESC
        LIMIT 75
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.propose_admin_setting_change(
  p_setting_key TEXT,
  p_proposed_value JSONB,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_previous JSONB;
  v_next_version INT;
  v_version public.admin_settings_versions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'settings', 'update') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Settings update permission is required.';
  END IF;

  IF NULLIF(btrim(COALESCE(p_setting_key, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Setting key is required.';
  END IF;

  SELECT current_value INTO v_previous
  FROM public.admin_active_settings
  WHERE setting_key = p_setting_key;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM public.admin_settings_versions
  WHERE setting_key = p_setting_key;

  INSERT INTO public.admin_settings_versions (
    setting_key,
    version,
    status,
    proposed_value,
    previous_value,
    proposer_id,
    reason_code,
    justification
  )
  VALUES (
    btrim(p_setting_key),
    v_next_version,
    'pending_approval',
    p_proposed_value,
    v_previous,
    v_actor,
    p_reason_code,
    btrim(p_justification)
  )
  RETURNING * INTO v_version;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'settings',
    'update',
    'admin_settings_version',
    v_version.id::TEXT,
    p_reason_code,
    p_justification,
    jsonb_build_object('setting_key', p_setting_key, 'previous_value', v_previous),
    to_jsonb(v_version),
    p_ticket_ref,
    gen_random_uuid(),
    p_idempotency_key
  );

  RETURN to_jsonb(v_version);
END;
$$;
CREATE OR REPLACE FUNCTION public.approve_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_version public.admin_settings_versions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'settings', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Settings approve permission is required.';
  END IF;

  SELECT to_jsonb(v) INTO v_before
  FROM public.admin_settings_versions v
  WHERE v.id = p_version_id
  FOR UPDATE;

  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Settings version not found.';
  END IF;

  SELECT * INTO v_version
  FROM public.admin_settings_versions
  WHERE id = p_version_id;

  IF v_version.status <> 'pending_approval' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Only pending settings can be approved.';
  END IF;

  IF v_version.proposer_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Maker cannot approve their own settings change.';
  END IF;

  UPDATE public.admin_settings_versions
  SET status = 'approved', approver_id = v_actor
  WHERE id = p_version_id
  RETURNING * INTO v_version;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'settings',
    'approve',
    'admin_settings_version',
    p_version_id::TEXT,
    p_reason_code,
    p_justification,
    v_before,
    to_jsonb(v_version),
    p_ticket_ref
  );

  RETURN to_jsonb(v_version);
END;
$$;
CREATE OR REPLACE FUNCTION public.reject_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_version public.admin_settings_versions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'settings', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Settings approve permission is required.';
  END IF;

  SELECT to_jsonb(v) INTO v_before
  FROM public.admin_settings_versions v
  WHERE v.id = p_version_id
  FOR UPDATE;

  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Settings version not found.';
  END IF;

  SELECT * INTO v_version
  FROM public.admin_settings_versions
  WHERE id = p_version_id;

  IF v_version.status <> 'pending_approval' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Only pending settings can be rejected.';
  END IF;

  IF v_version.proposer_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Maker cannot reject their own settings change.';
  END IF;

  UPDATE public.admin_settings_versions
  SET status = 'rejected', approver_id = v_actor
  WHERE id = p_version_id
  RETURNING * INTO v_version;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'settings',
    'approve',
    'admin_settings_version',
    p_version_id::TEXT,
    p_reason_code,
    p_justification,
    v_before,
    to_jsonb(v_version),
    p_ticket_ref
  );

  RETURN to_jsonb(v_version);
END;
$$;
CREATE OR REPLACE FUNCTION public.publish_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_version public.admin_settings_versions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'settings', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Settings approve permission is required.';
  END IF;

  SELECT * INTO v_version
  FROM public.admin_settings_versions
  WHERE id = p_version_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Settings version not found.';
  END IF;

  IF v_version.status <> 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Only approved settings can be published.';
  END IF;

  IF v_version.proposer_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Maker cannot publish their own settings change.';
  END IF;

  SELECT to_jsonb(s) INTO v_before
  FROM public.admin_active_settings s
  WHERE s.setting_key = v_version.setting_key
  FOR UPDATE;

  INSERT INTO public.admin_active_settings (
    setting_key,
    current_version_id,
    current_value,
    published_by,
    published_at,
    updated_at
  )
  VALUES (
    v_version.setting_key,
    v_version.id,
    v_version.proposed_value,
    v_actor,
    now(),
    now()
  )
  ON CONFLICT (setting_key) DO UPDATE SET
    current_version_id = EXCLUDED.current_version_id,
    current_value = EXCLUDED.current_value,
    published_by = EXCLUDED.published_by,
    published_at = EXCLUDED.published_at,
    updated_at = now();

  UPDATE public.admin_settings_versions
  SET status = 'published', approver_id = COALESCE(approver_id, v_actor), published_at = now()
  WHERE id = p_version_id
  RETURNING * INTO v_version;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'settings',
    'approve',
    'admin_active_setting',
    v_version.setting_key,
    p_reason_code,
    p_justification,
    v_before,
    jsonb_build_object('version', to_jsonb(v_version), 'active_value', v_version.proposed_value),
    p_ticket_ref
  );

  RETURN to_jsonb(v_version);
END;
$$;
CREATE OR REPLACE FUNCTION public.propose_admin_setting_rollback(
  p_target_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_target public.admin_settings_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_target
  FROM public.admin_settings_versions
  WHERE id = p_target_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Rollback target not found.';
  END IF;

  RETURN public.propose_admin_setting_change(
    v_target.setting_key,
    v_target.proposed_value,
    p_reason_code,
    p_justification,
    p_ticket_ref,
    p_idempotency_key
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_settings_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_settings_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
