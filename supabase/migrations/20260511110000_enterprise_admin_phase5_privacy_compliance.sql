-- Enterprise admin Phase 5: privacy governance, retention dry-runs,
-- masked user administration, PII reveal audit, and compliance reporting.

CREATE TABLE IF NOT EXISTS public.data_classification_registry (
  entity_type TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK (
    classification IN ('public', 'internal', 'confidential', 'restricted')
  ),
  pii_fields TEXT[] NOT NULL DEFAULT '{}',
  retention_class TEXT NOT NULL,
  purpose TEXT NOT NULL,
  default_masking BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.data_classification_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Data classification read" ON public.data_classification_registry;
CREATE POLICY "Data classification read" ON public.data_classification_registry
  FOR SELECT TO authenticated
  USING (
    public.admin_has_permission(auth.uid(), 'compliance', 'read')
    OR public.admin_has_permission(auth.uid(), 'privacy', 'read')
  );
REVOKE ALL ON public.data_classification_registry FROM anon, authenticated;
GRANT SELECT ON public.data_classification_registry TO authenticated;
INSERT INTO public.data_classification_registry (
  entity_type,
  classification,
  pii_fields,
  retention_class,
  purpose,
  default_masking
)
VALUES
  ('profiles', 'restricted', ARRAY['full_name', 'bio', 'avatar_url', 'credits'], 'user_profile_2y', 'Account profile and learning identity', true),
  ('auth.users', 'restricted', ARRAY['email', 'phone', 'raw_user_meta_data'], 'auth_identity_provider', 'Authentication and account recovery', true),
  ('sessions', 'confidential', ARRAY['learner_id', 'teacher_id', 'meet_link'], 'session_history_3y', 'Skill exchange lifecycle and dispute evidence', true),
  ('messages', 'confidential', ARRAY['sender_id', 'text'], 'message_history_2y', 'Session communication and abuse investigation', true),
  ('reviews', 'internal', ARRAY['reviewer_id', 'reviewee_id', 'comment'], 'review_history_3y', 'Trust and reputation history', true),
  ('credit_transactions', 'restricted', ARRAY['from_user', 'to_user', 'amount'], 'ledger_7y', 'Credit ledger and financial reconciliation', true),
  ('reports', 'confidential', ARRAY['reporter_id', 'reported_user_id', 'details'], 'moderation_case_3y', 'Safety reporting and moderation evidence', true),
  ('admin_audit_events', 'restricted', ARRAY['actor_id', 'ip_address', 'user_agent'], 'admin_audit_7y', 'Privileged action accountability', false)
ON CONFLICT (entity_type) DO UPDATE SET
  classification = EXCLUDED.classification,
  pii_fields = EXCLUDED.pii_fields,
  retention_class = EXCLUDED.retention_class,
  purpose = EXCLUDED.purpose,
  default_masking = EXCLUDED.default_masking,
  updated_at = now();
INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('privacy:pii_reveal', 'privacy', 'reveal', 'Reveal masked PII', true),
  ('privacy:retention_purge', 'privacy', 'delete', 'Retention purge dry-run or execution', true),
  ('privacy:legal_hold', 'privacy', 'update', 'Legal hold update', true),
  ('compliance:summary_export', 'compliance', 'export', 'Compliance summary export', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;
CREATE OR REPLACE FUNCTION public.admin_mask_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_at INT;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN
    RETURN NULL;
  END IF;

  v_at := position('@' IN p_email);
  IF v_at <= 1 THEN
    RETURN '***';
  END IF;

  RETURN left(p_email, 1) || '***' || substring(p_email FROM v_at);
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_users(
  p_limit INT DEFAULT 50,
  p_search TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'users', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Users read permission is required.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(x))
    FROM (
      SELECT
        u.id,
        public.admin_mask_email(u.email::TEXT) AS masked_email,
        CASE
          WHEN p.full_name IS NULL OR p.full_name = '' THEN NULL
          ELSE left(p.full_name, 1) || repeat('*', greatest(char_length(p.full_name) - 1, 0))
        END AS masked_name,
        p.onboarded,
        p.learning_mode,
        p.created_at,
        u.last_sign_in_at,
        EXISTS (
          SELECT 1
          FROM public.admin_role_assignments ara
          WHERE ara.user_id = u.id
            AND ara.revoked_at IS NULL
            AND (ara.expires_at IS NULL OR ara.expires_at > now())
        ) AS has_admin_role,
        (
          SELECT COUNT(*)::INT
          FROM public.sessions s
          WHERE s.learner_id = u.id OR s.teacher_id = u.id
        ) AS session_count,
        (
          SELECT COUNT(*)::INT
          FROM public.reports r
          WHERE r.reporter_id = u.id OR r.reported_user_id = u.id
        ) AS report_count
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE p_search IS NULL
        OR u.id::TEXT = p_search
        OR lower(u.email::TEXT) LIKE '%' || lower(p_search) || '%'
      ORDER BY COALESCE(u.last_sign_in_at, p.created_at, u.created_at) DESC NULLS LAST
      LIMIT least(greatest(COALESCE(p_limit, 50), 1), 100)
    ) x
  ), '[]'::jsonb);
END;
$$;
CREATE OR REPLACE FUNCTION public.reveal_admin_user_pii(
  p_user_id UUID,
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
  v_payload JSONB;
BEGIN
  IF v_actor IS NULL OR NOT (
    public.admin_has_permission(v_actor, 'users', 'reveal')
    OR public.admin_has_permission(v_actor, 'privacy', 'reveal')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'PII reveal permission is required.';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id,
    'email', u.email::TEXT,
    'phone', u.phone::TEXT,
    'full_name', p.full_name,
    'bio', p.bio,
    'avatar_url', p.avatar_url,
    'credits', p.credits,
    'created_at', p.created_at,
    'last_sign_in_at', u.last_sign_in_at,
    'classification', 'restricted'
  )
  INTO v_payload
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = p_user_id;

  IF v_payload IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'User not found.';
  END IF;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'reveal',
    'user',
    p_user_id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    jsonb_build_object('revealed_fields', ARRAY['email', 'phone', 'full_name', 'bio', 'avatar_url', 'credits']),
    p_ticket_ref
  );

  RETURN v_payload;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_compliance_dashboard()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT (
    public.admin_has_permission(v_actor, 'compliance', 'read')
    OR public.admin_has_permission(v_actor, 'privacy', 'read')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Compliance or privacy read permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'privilegedActionVolume24h', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE created_at > now() - interval '24 hours'
        AND domain IN ('wallet', 'settings', 'privacy', 'access-governance', 'incident-response')
    ),
    'makerCheckerTurnaroundHours7d', (
      SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(decided_at, executed_at) - created_at)) / 3600)::NUMERIC, 2), 0)
      FROM public.admin_action_requests
      WHERE created_at > now() - interval '7 days'
        AND status IN ('approved', 'rejected', 'executed')
        AND COALESCE(decided_at, executed_at) IS NOT NULL
    ),
    'overdueAccessReviews', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE revoked_at IS NULL
        AND access_review_due_at < now()
    ),
    'openPrivacyRequests', (
      SELECT COUNT(*)::INT
      FROM public.privacy_requests
      WHERE status IN ('open', 'validating', 'in_progress')
    ),
    'overduePrivacyRequests', (
      SELECT COUNT(*)::INT
      FROM public.privacy_requests
      WHERE status IN ('open', 'validating', 'in_progress')
        AND due_at < now()
    ),
    'retentionPoliciesEnabled', (
      SELECT COUNT(*)::INT
      FROM public.data_retention_policies
      WHERE enabled = true
    ),
    'lastPurgeStatus', (
      SELECT status
      FROM public.retention_purge_runs
      ORDER BY started_at DESC
      LIMIT 1
    ),
    'moderationSlaBreaches', (
      SELECT COUNT(*)::INT
      FROM public.admin_cases
      WHERE status NOT IN ('resolved', 'dismissed')
        AND sla_due_at < now()
    ),
    'walletAnomalyCount', (
      SELECT
        (
          SELECT COUNT(*)::INT FROM public.profiles WHERE credits < 0
        )
        +
        (
          SELECT COUNT(*)::INT
          FROM public.sessions
          WHERE escrow_held = true
            AND status IN ('accepted', 'active')
            AND COALESCE(scheduled_at, updated_at, created_at) < now() - interval '14 days'
        )
    ),
    'privacyRequests', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          pr.id,
          pr.subject_user_id,
          public.admin_mask_email(u.email::TEXT) AS masked_subject_email,
          pr.request_type,
          pr.status,
          pr.due_at,
          pr.legal_hold,
          pr.reason_code,
          pr.justification,
          pr.export_manifest,
          pr.created_at,
          pr.updated_at
        FROM public.privacy_requests pr
        LEFT JOIN auth.users u ON u.id = pr.subject_user_id
        ORDER BY pr.created_at DESC
        LIMIT 50
      ) x
    ), '[]'::jsonb),
    'retentionPolicies', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          id,
          data_type,
          retention_class,
          retain_for::TEXT AS retain_for,
          legal_basis,
          anonymize_instead_of_delete,
          enabled,
          updated_at
        FROM public.data_retention_policies
        ORDER BY data_type
      ) x
    ), '[]'::jsonb),
    'purgeRuns', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          r.id,
          r.policy_id,
          p.data_type,
          r.dry_run,
          r.status,
          r.candidate_count,
          r.purged_count,
          r.manifest,
          r.started_at,
          r.completed_at
        FROM public.retention_purge_runs r
        LEFT JOIN public.data_retention_policies p ON p.id = r.policy_id
        ORDER BY r.started_at DESC
        LIMIT 25
      ) x
    ), '[]'::jsonb),
    'classifications', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT entity_type, classification, pii_fields, retention_class, purpose, default_masking
        FROM public.data_classification_registry
        ORDER BY classification DESC, entity_type
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.create_privacy_request(
  p_subject_user_id UUID,
  p_request_type TEXT,
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
  v_request public.privacy_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'privacy', 'create') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Privacy create permission is required.';
  END IF;

  IF p_request_type NOT IN ('dsar_export', 'delete', 'anonymize', 'restrict_processing') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid privacy request type.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_subject_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Subject user not found.';
  END IF;

  INSERT INTO public.privacy_requests (
    subject_user_id,
    request_type,
    status,
    requested_by,
    reason_code,
    justification
  )
  VALUES (
    p_subject_user_id,
    p_request_type,
    'open',
    v_actor,
    p_reason_code,
    btrim(p_justification)
  )
  RETURNING * INTO v_request;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'create',
    'privacy_request',
    v_request.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    to_jsonb(v_request),
    p_ticket_ref,
    gen_random_uuid(),
    p_idempotency_key
  );

  RETURN to_jsonb(v_request);
END;
$$;
CREATE OR REPLACE FUNCTION public.complete_privacy_export(
  p_request_id UUID,
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
  v_request public.privacy_requests%ROWTYPE;
  v_before JSONB;
  v_manifest JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'privacy', 'export') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Privacy export permission is required.';
  END IF;

  SELECT * INTO v_request
  FROM public.privacy_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Privacy request not found.';
  END IF;

  IF v_request.request_type <> 'dsar_export' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Only DSAR export requests can create export manifests.';
  END IF;

  v_before := to_jsonb(v_request);

  v_manifest := jsonb_build_object(
    'requestId', v_request.id,
    'subjectUserId', v_request.subject_user_id,
    'generatedAt', now(),
    'generatedBy', v_actor,
    'classification', 'restricted',
    'dataClasses', jsonb_build_array('profile', 'sessions', 'messages', 'reviews', 'ledger', 'reports'),
    'counts', jsonb_build_object(
      'profiles', (SELECT COUNT(*)::INT FROM public.profiles WHERE id = v_request.subject_user_id),
      'sessions', (SELECT COUNT(*)::INT FROM public.sessions WHERE learner_id = v_request.subject_user_id OR teacher_id = v_request.subject_user_id),
      'messages', (SELECT COUNT(*)::INT FROM public.messages WHERE sender_id = v_request.subject_user_id),
      'reviews', (SELECT COUNT(*)::INT FROM public.reviews WHERE reviewer_id = v_request.subject_user_id OR reviewee_id = v_request.subject_user_id),
      'creditTransactions', (SELECT COUNT(*)::INT FROM public.credit_transactions WHERE from_user = v_request.subject_user_id OR to_user = v_request.subject_user_id),
      'reports', (SELECT COUNT(*)::INT FROM public.reports WHERE reporter_id = v_request.subject_user_id OR reported_user_id = v_request.subject_user_id)
    )
  );

  v_manifest := v_manifest || jsonb_build_object(
    'manifestHash',
    encode(digest(v_manifest::TEXT, 'sha256'), 'hex')
  );

  UPDATE public.privacy_requests
  SET
    status = 'completed',
    export_manifest = v_manifest,
    reason_code = p_reason_code,
    justification = btrim(p_justification),
    updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'export',
    'privacy_request',
    p_request_id::TEXT,
    p_reason_code,
    p_justification,
    v_before,
    to_jsonb(v_request),
    p_ticket_ref
  );

  RETURN v_manifest;
END;
$$;
CREATE OR REPLACE FUNCTION public.execute_privacy_anonymization(
  p_request_id UUID,
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
  v_request public.privacy_requests%ROWTYPE;
  v_before_request JSONB;
  v_before_profile JSONB;
  v_result JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'privacy', 'delete') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Privacy delete permission is required.';
  END IF;

  SELECT * INTO v_request
  FROM public.privacy_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Privacy request not found.';
  END IF;

  IF v_request.request_type NOT IN ('delete', 'anonymize') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Only delete/anonymize requests can anonymize profile data.';
  END IF;

  IF v_request.legal_hold THEN
    UPDATE public.privacy_requests
    SET status = 'blocked_legal_hold', updated_at = now()
    WHERE id = p_request_id
    RETURNING * INTO v_request;

    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Request is blocked by legal hold.';
  END IF;

  SELECT to_jsonb(p) INTO v_before_profile
  FROM public.profiles p
  WHERE p.id = v_request.subject_user_id;

  v_before_request := to_jsonb(v_request);

  UPDATE public.profiles
  SET
    full_name = 'Deleted user',
    bio = NULL,
    avatar_url = NULL,
    learning_mode = NULL,
    onboarded = false
  WHERE id = v_request.subject_user_id;

  DELETE FROM public.user_teaching_skills
  WHERE user_id = v_request.subject_user_id;

  DELETE FROM public.user_learning_skills
  WHERE user_id = v_request.subject_user_id;

  v_result := jsonb_build_object(
    'requestId', v_request.id,
    'subjectUserId', v_request.subject_user_id,
    'anonymizedAt', now(),
    'anonymizedBy', v_actor,
    'profileFieldsAnonymized', ARRAY['full_name', 'bio', 'avatar_url', 'learning_mode', 'onboarded'],
    'authIdentityNote', 'Provider identity remains under Supabase Auth; use provider/admin API for full identity deletion after legal review.'
  );

  UPDATE public.privacy_requests
  SET
    status = 'completed',
    export_manifest = COALESCE(export_manifest, '{}'::jsonb) || v_result,
    reason_code = p_reason_code,
    justification = btrim(p_justification),
    updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'delete',
    'privacy_request',
    p_request_id::TEXT,
    p_reason_code,
    p_justification,
    jsonb_build_object('request', v_before_request, 'profile', v_before_profile),
    to_jsonb(v_request),
    p_ticket_ref
  );

  RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION public.set_privacy_request_legal_hold(
  p_request_id UUID,
  p_legal_hold BOOLEAN,
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
  v_request public.privacy_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'privacy', 'update') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Privacy update permission is required.';
  END IF;

  SELECT to_jsonb(pr) INTO v_before
  FROM public.privacy_requests pr
  WHERE pr.id = p_request_id
  FOR UPDATE;

  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Privacy request not found.';
  END IF;

  UPDATE public.privacy_requests
  SET
    legal_hold = p_legal_hold,
    status = CASE
      WHEN p_legal_hold THEN 'blocked_legal_hold'
      WHEN status = 'blocked_legal_hold' THEN 'open'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'update',
    'privacy_request',
    p_request_id::TEXT,
    p_reason_code,
    p_justification,
    v_before,
    to_jsonb(v_request),
    p_ticket_ref
  );

  RETURN to_jsonb(v_request);
END;
$$;
CREATE OR REPLACE FUNCTION public.run_retention_purge(
  p_policy_id UUID,
  p_dry_run BOOLEAN,
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
  v_policy public.data_retention_policies%ROWTYPE;
  v_candidate_count INT := 0;
  v_manifest JSONB;
  v_run public.retention_purge_runs%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'privacy', 'delete') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Privacy delete permission is required.';
  END IF;

  SELECT * INTO v_policy
  FROM public.data_retention_policies
  WHERE id = p_policy_id
    AND enabled = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Enabled retention policy not found.';
  END IF;

  IF v_policy.data_type = 'admin_audit_events' THEN
    SELECT COUNT(*)::INT INTO v_candidate_count
    FROM public.admin_audit_events
    WHERE purge_after < now()
      AND legal_hold = false;
  ELSIF v_policy.data_type = 'privacy_requests' THEN
    SELECT COUNT(*)::INT INTO v_candidate_count
    FROM public.privacy_requests
    WHERE status IN ('completed', 'rejected')
      AND legal_hold = false
      AND updated_at < now() - v_policy.retain_for;
  ELSIF v_policy.data_type = 'reports' THEN
    SELECT COUNT(*)::INT INTO v_candidate_count
    FROM public.reports
    WHERE status IN ('resolved', 'rejected')
      AND updated_at < now() - v_policy.retain_for;
  ELSE
    v_candidate_count := 0;
  END IF;

  v_manifest := jsonb_build_object(
    'policyId', v_policy.id,
    'dataType', v_policy.data_type,
    'retentionClass', v_policy.retention_class,
    'dryRun', p_dry_run,
    'candidateCount', v_candidate_count,
    'destructivePurgeDisabled', NOT p_dry_run,
    'note', CASE
      WHEN p_dry_run THEN 'Dry-run only; no rows changed.'
      ELSE 'Framework recorded the run but destructive purge is disabled pending archival/legal approval.'
    END,
    'generatedAt', now()
  );

  v_manifest := v_manifest || jsonb_build_object(
    'manifestHash',
    encode(digest(v_manifest::TEXT, 'sha256'), 'hex')
  );

  INSERT INTO public.retention_purge_runs (
    policy_id,
    dry_run,
    status,
    candidate_count,
    purged_count,
    manifest,
    started_by,
    completed_at
  )
  VALUES (
    v_policy.id,
    p_dry_run,
    'completed',
    v_candidate_count,
    0,
    v_manifest,
    v_actor,
    now()
  )
  RETURNING * INTO v_run;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'privacy',
    'delete',
    'retention_purge_run',
    v_run.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    to_jsonb(v_run),
    p_ticket_ref
  );

  RETURN to_jsonb(v_run);
END;
$$;
CREATE OR REPLACE FUNCTION public.create_compliance_summary_manifest(
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
  v_snapshot JSONB;
  v_manifest JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'compliance', 'export') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Compliance export permission is required.';
  END IF;

  v_snapshot := public.get_admin_compliance_dashboard();

  v_manifest := jsonb_build_object(
    'generatedAt', now(),
    'generatedBy', v_actor,
    'snapshot', v_snapshot
  );

  v_manifest := v_manifest || jsonb_build_object(
    'manifestHash',
    encode(digest(v_manifest::TEXT, 'sha256'), 'hex')
  );

  PERFORM public.admin_log_audit_event(
    v_actor,
    'compliance',
    'export',
    'compliance_summary',
    NULL,
    p_reason_code,
    p_justification,
    NULL,
    jsonb_build_object('manifestHash', v_manifest ->> 'manifestHash'),
    p_ticket_ref
  );

  RETURN v_manifest;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_mask_email(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_compliance_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.complete_privacy_export(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_compliance_summary_manifest(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_compliance_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_privacy_export(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_compliance_summary_manifest(TEXT, TEXT, TEXT) TO authenticated;
