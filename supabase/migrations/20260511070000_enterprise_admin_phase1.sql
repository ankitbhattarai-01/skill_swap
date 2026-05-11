-- Enterprise admin Phase 1: RBAC/ABAC foundation, immutable audit events,
-- SoD-ready action requests, and secured moderation status RPCs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- ---------------------------------------------------------------------------
-- Permission model
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_permission_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (
    domain IN (
      'moderation',
      'users',
      'sessions',
      'wallet',
      'analytics',
      'compliance',
      'settings',
      'incident-response',
      'access-governance',
      'security',
      'privacy'
    )
  ),
  action TEXT NOT NULL CHECK (
    action IN ('read', 'create', 'update', 'approve', 'export', 'override', 'reveal', 'delete')
  ),
  description TEXT NOT NULL DEFAULT '',
  high_risk BOOLEAN NOT NULL DEFAULT false,
  requires_reason BOOLEAN NOT NULL DEFAULT true,
  requires_reauth BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, action)
);
CREATE TABLE IF NOT EXISTS public.admin_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_]+$'),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_template BOOLEAN NOT NULL DEFAULT true,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_role_permissions (
  role_id UUID NOT NULL REFERENCES public.admin_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.admin_permission_definitions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS public.admin_policy_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'region', 'team', 'entity')),
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES public.admin_roles(id) ON DELETE RESTRICT,
  scope_id UUID REFERENCES public.admin_policy_scopes(id) ON DELETE SET NULL,
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'region', 'team', 'entity')),
  scope_value TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  grant_reason TEXT NOT NULL DEFAULT 'legacy_admin_bootstrap',
  break_glass BOOLEAN NOT NULL DEFAULT false,
  incident_ticket_ref TEXT,
  access_review_due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK (break_glass = false OR (expires_at IS NOT NULL AND incident_ticket_ref IS NOT NULL)),
  CHECK (scope_type = 'global' OR scope_value IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS admin_role_assignments_user_active_idx
  ON public.admin_role_assignments (user_id, revoked_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS admin_role_assignments_active_unique_idx
  ON public.admin_role_assignments (user_id, role_id, COALESCE(scope_value, '__global__'))
  WHERE revoked_at IS NULL;
-- ---------------------------------------------------------------------------
-- Reason codes, maker-checker queue, and immutable audit store
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_reason_codes (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9_:-]+$'),
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  label TEXT NOT NULL,
  requires_ticket BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type TEXT NOT NULL,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'executed')
  ),
  maker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  checker_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL REFERENCES public.admin_reason_codes(code) ON DELETE RESTRICT,
  justification TEXT NOT NULL CHECK (char_length(btrim(justification)) >= 8),
  ticket_ref TEXT,
  idempotency_key TEXT,
  required_permission_domain TEXT NOT NULL,
  required_permission_action TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  decided_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  UNIQUE (maker_id, request_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS admin_action_requests_status_idx
  ON public.admin_action_requests (status, created_at DESC);
CREATE TABLE IF NOT EXISTS public.admin_audit_events (
  sequence BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  action TEXT NOT NULL,
  domain TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason_code TEXT NOT NULL REFERENCES public.admin_reason_codes(code) ON DELETE RESTRICT,
  justification TEXT NOT NULL,
  ticket_ref TEXT,
  before_snapshot JSONB,
  after_snapshot JSONB,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key TEXT,
  ip_address INET,
  user_agent TEXT,
  device_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention_class TEXT NOT NULL DEFAULT 'admin_audit_7y',
  purge_after TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  checksum_version INT NOT NULL DEFAULT 1,
  prev_event_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(btrim(justification)) >= 8),
  UNIQUE (actor_id, action, entity_type, entity_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
  ON public.admin_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_actor_idx
  ON public.admin_audit_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_entity_idx
  ON public.admin_audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_correlation_idx
  ON public.admin_audit_events (correlation_id);
-- ---------------------------------------------------------------------------
-- Governance tables required for forward-compatible rollout.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.data_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_type TEXT NOT NULL UNIQUE,
  retention_class TEXT NOT NULL,
  retain_for INTERVAL NOT NULL,
  legal_basis TEXT NOT NULL DEFAULT 'contract',
  anonymize_instead_of_delete BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.retention_purge_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES public.data_retention_policies(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  candidate_count INT NOT NULL DEFAULT 0,
  purged_count INT NOT NULL DEFAULT 0,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS public.privacy_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('dsar_export', 'delete', 'anonymize', 'restrict_processing')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'validating', 'in_progress', 'blocked_legal_hold', 'completed', 'rejected')
  ),
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  reason_code TEXT REFERENCES public.admin_reason_codes(code) ON DELETE RESTRICT,
  justification TEXT,
  export_manifest JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_settings_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'published', 'rolled_back', 'rejected')
  ),
  proposed_value JSONB NOT NULL,
  previous_value JSONB,
  proposer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approver_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL REFERENCES public.admin_reason_codes(code) ON DELETE RESTRICT,
  justification TEXT NOT NULL CHECK (char_length(btrim(justification)) >= 8),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approver_id IS NULL OR approver_id <> proposer_id),
  UNIQUE (setting_key, version)
);
CREATE TABLE IF NOT EXISTS public.admin_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
  case_number TEXT NOT NULL UNIQUE DEFAULT ('CASE-' || upper(substr(gen_random_uuid()::text, 1, 8))),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'assigned', 'escalated', 'resolved', 'dismissed')
  ),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sla_due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '48 hours'),
  escalation_level INT NOT NULL DEFAULT 0,
  disposition TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_case_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.admin_cases(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'compliance', 'incident-response')),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ---------------------------------------------------------------------------
-- Seed templates and reason taxonomy.
-- ---------------------------------------------------------------------------

WITH domains(domain) AS (
  VALUES
    ('moderation'),
    ('users'),
    ('sessions'),
    ('wallet'),
    ('analytics'),
    ('compliance'),
    ('settings'),
    ('incident-response'),
    ('access-governance'),
    ('security'),
    ('privacy')
),
actions(action) AS (
  VALUES ('read'), ('create'), ('update'), ('approve'), ('export'), ('override'), ('reveal'), ('delete')
)
INSERT INTO public.admin_permission_definitions (domain, action, description, high_risk, requires_reauth)
SELECT
  d.domain,
  a.action,
  d.domain || ':' || a.action,
  a.action IN ('approve', 'export', 'override', 'reveal', 'delete') OR d.domain IN ('wallet', 'settings', 'privacy'),
  a.action IN ('approve', 'export', 'override', 'reveal', 'delete')
FROM domains d
CROSS JOIN actions a
ON CONFLICT (domain, action) DO UPDATE SET
  high_risk = EXCLUDED.high_risk,
  requires_reauth = EXCLUDED.requires_reauth;
INSERT INTO public.admin_roles (slug, name, description, is_template, is_system)
VALUES
  ('moderator', 'Moderator', 'Moderation queue reviewer with restricted user/session context.', true, true),
  ('trust_lead', 'Trust Lead', 'Senior trust operator with moderation approval and override authority.', true, true),
  ('finance_ops', 'Finance Ops', 'Wallet and escrow operator subject to maker-checker controls.', true, true),
  ('compliance_auditor', 'Compliance Auditor', 'Read/export-only compliance and audit reviewer.', true, true),
  ('super_admin', 'Super Admin', 'Platform administrator for emergency and bootstrap operations.', true, true),
  ('break_glass', 'Break Glass', 'Emergency access role requiring expiry and incident reference.', true, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_template = EXCLUDED.is_template,
  is_system = EXCLUDED.is_system,
  updated_at = now();
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p ON true
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p
  ON p.domain IN ('moderation', 'users', 'sessions') AND p.action IN ('read', 'update')
WHERE r.slug = 'moderator'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p
  ON (
    p.domain = 'moderation'
    OR (p.domain IN ('users', 'sessions', 'security') AND p.action IN ('read', 'update', 'export'))
  )
WHERE r.slug = 'trust_lead'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p
  ON p.domain = 'wallet'
  OR (p.domain IN ('sessions', 'analytics') AND p.action IN ('read', 'export'))
WHERE r.slug = 'finance_ops'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p
  ON p.action IN ('read', 'export')
WHERE r.slug = 'compliance_auditor'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.admin_roles r
JOIN public.admin_permission_definitions p ON true
WHERE r.slug = 'break_glass'
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('moderation:status_review', 'moderation', 'update', 'Moderation status review', false),
  ('moderation:policy_violation', 'moderation', 'update', 'Policy violation confirmed', false),
  ('moderation:false_positive', 'moderation', 'update', 'False positive / no violation', false),
  ('wallet:manual_adjustment', 'wallet', 'override', 'Manual wallet adjustment', true),
  ('wallet:escrow_intervention', 'wallet', 'override', 'Escrow intervention', true),
  ('privacy:dsar', 'privacy', 'export', 'Subject access request', true),
  ('privacy:anonymization', 'privacy', 'delete', 'Privacy anonymization request', true),
  ('settings:policy_change', 'settings', 'approve', 'Policy or configuration change', true),
  ('access:jit_grant', 'access-governance', 'approve', 'Time-bound privileged access', true),
  ('incident:break_glass', 'incident-response', 'override', 'Emergency break-glass action', true),
  ('audit:investigation', 'compliance', 'read', 'Audit investigation', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;
INSERT INTO public.data_retention_policies (data_type, retention_class, retain_for, legal_basis, anonymize_instead_of_delete)
VALUES
  ('admin_audit_events', 'admin_audit_7y', interval '7 years', 'legitimate_interest_security', false),
  ('reports', 'trust_safety_3y', interval '3 years', 'legitimate_interest_safety', true),
  ('messages', 'messages_2y', interval '2 years', 'contract', true),
  ('credit_transactions', 'finance_7y', interval '7 years', 'legal_obligation', false)
ON CONFLICT (data_type) DO UPDATE SET
  retention_class = EXCLUDED.retention_class,
  retain_for = EXCLUDED.retain_for,
  legal_basis = EXCLUDED.legal_basis,
  anonymize_instead_of_delete = EXCLUDED.anonymize_instead_of_delete,
  updated_at = now();
-- Bootstrap existing boolean admins into the new model while preserving rollout.
INSERT INTO public.admin_role_assignments (user_id, role_id, scope_type, grant_reason)
SELECT p.id, r.id, 'global', 'legacy_is_admin_bootstrap'
FROM public.profiles p
JOIN public.admin_roles r ON r.slug = 'super_admin'
WHERE p.is_admin = true
  AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
ON CONFLICT DO NOTHING;
-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_actor_role_snapshot(p_actor UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'role', r.slug,
        'scope_type', a.scope_type,
        'scope_value', a.scope_value,
        'break_glass', a.break_glass,
        'expires_at', a.expires_at
      )
      ORDER BY r.slug
    ),
    '[]'::jsonb
  )
  FROM public.admin_role_assignments a
  JOIN public.admin_roles r ON r.id = a.role_id
  WHERE a.user_id = p_actor
    AND a.revoked_at IS NULL
    AND a.starts_at <= now()
    AND (a.expires_at IS NULL OR a.expires_at > now());
$$;
CREATE OR REPLACE FUNCTION public.admin_has_permission(
  p_user UUID,
  p_domain TEXT,
  p_action TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_value TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT true
      FROM public.profiles p
      WHERE p.id = p_user
        AND p.is_admin = true
        AND (auth.uid() IS NULL OR auth.uid() = p_user)
      LIMIT 1
    ),
    false
  )
  OR EXISTS (
    SELECT 1
    FROM public.admin_role_assignments a
    JOIN public.admin_roles r ON r.id = a.role_id
    JOIN public.admin_role_permissions rp ON rp.role_id = r.id
    JOIN public.admin_permission_definitions pd ON pd.id = rp.permission_id
    WHERE a.user_id = p_user
      AND a.revoked_at IS NULL
      AND a.starts_at <= now()
      AND (a.expires_at IS NULL OR a.expires_at > now())
      AND pd.domain = p_domain
      AND pd.action = p_action
      AND (
        p_scope_type IS NULL
        OR a.scope_type = 'global'
        OR (a.scope_type = p_scope_type AND a.scope_value IS NOT DISTINCT FROM p_scope_value)
      )
      AND NOT (r.slug = 'compliance_auditor' AND pd.action NOT IN ('read', 'export'))
  );
$$;
CREATE OR REPLACE FUNCTION public.is_admin(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT (
    (auth.uid() IS NULL OR auth.uid() = p_user)
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user AND is_admin = true
      )
      OR EXISTS (
        SELECT 1
        FROM public.admin_role_assignments a
        WHERE a.user_id = p_user
          AND a.revoked_at IS NULL
          AND a.starts_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
      )
    )
  );
$$;
CREATE OR REPLACE FUNCTION public.require_admin_permission(
  p_domain TEXT,
  p_action TEXT,
  p_reason_code TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, p_domain, p_action) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Admin permission denied.';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_log_audit_event(
  p_actor UUID,
  p_domain TEXT,
  p_action TEXT,
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_before_snapshot JSONB DEFAULT NULL,
  p_after_snapshot JSONB DEFAULT NULL,
  p_ticket_ref TEXT DEFAULT NULL,
  p_correlation_id UUID DEFAULT gen_random_uuid(),
  p_idempotency_key TEXT DEFAULT NULL,
  p_device_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_sequence BIGINT;
  v_event_id UUID := gen_random_uuid();
  v_prev_hash TEXT;
  v_hash TEXT;
  v_reason public.admin_reason_codes%ROWTYPE;
  v_snapshot JSONB;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Audit actor is required.';
  END IF;

  SELECT * INTO v_reason
  FROM public.admin_reason_codes
  WHERE code = p_reason_code
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'A valid reason code is required.';
  END IF;

  IF v_reason.requires_ticket AND NULLIF(btrim(COALESCE(p_ticket_ref, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'A ticket or incident reference is required.';
  END IF;

  IF char_length(btrim(COALESCE(p_justification, ''))) < 8 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'A justification of at least 8 characters is required.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin_audit_events_hash_chain'));

  SELECT event_hash INTO v_prev_hash
  FROM public.admin_audit_events
  ORDER BY sequence DESC
  LIMIT 1;

  SELECT nextval(pg_get_serial_sequence('public.admin_audit_events', 'sequence')) INTO v_sequence;
  v_snapshot := public.admin_actor_role_snapshot(p_actor);

  v_hash := encode(
    digest(
      concat_ws(
        '|',
        v_sequence::text,
        v_event_id::text,
        COALESCE(p_actor::text, ''),
        p_domain,
        p_action,
        p_entity_type,
        COALESCE(p_entity_id, ''),
        p_reason_code,
        btrim(p_justification),
        COALESCE(p_before_snapshot::text, ''),
        COALESCE(p_after_snapshot::text, ''),
        COALESCE(v_prev_hash, ''),
        p_correlation_id::text
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.admin_audit_events (
    sequence,
    id,
    actor_id,
    actor_role_snapshot,
    action,
    domain,
    entity_type,
    entity_id,
    reason_code,
    justification,
    ticket_ref,
    before_snapshot,
    after_snapshot,
    correlation_id,
    idempotency_key,
    device_metadata,
    prev_event_hash,
    event_hash
  )
  VALUES (
    v_sequence,
    v_event_id,
    p_actor,
    v_snapshot,
    p_action,
    p_domain,
    p_entity_type,
    p_entity_id,
    p_reason_code,
    btrim(p_justification),
    NULLIF(btrim(COALESCE(p_ticket_ref, '')), ''),
    p_before_snapshot,
    p_after_snapshot,
    p_correlation_id,
    NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''),
    COALESCE(p_device_metadata, '{}'::jsonb),
    v_prev_hash,
    v_hash
  )
  ON CONFLICT (actor_id, action, entity_type, entity_id, idempotency_key) DO NOTHING;

  RETURN v_event_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.block_admin_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'insufficient_privilege',
    MESSAGE = 'Admin audit events are immutable.';
END;
$$;
DROP TRIGGER IF EXISTS admin_audit_events_immutable ON public.admin_audit_events;
CREATE TRIGGER admin_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.block_admin_audit_mutation();
CREATE OR REPLACE FUNCTION public.get_my_admin_permissions()
RETURNS TABLE (
  domain TEXT,
  action TEXT,
  high_risk BOOLEAN,
  requires_reauth BOOLEAN,
  role_slug TEXT,
  scope_type TEXT,
  scope_value TEXT,
  expires_at TIMESTAMPTZ,
  break_glass BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_admin = true) THEN
    RETURN QUERY
    SELECT
      pd.domain,
      pd.action,
      pd.high_risk,
      pd.requires_reauth,
      'super_admin'::TEXT,
      'global'::TEXT,
      NULL::TEXT,
      NULL::TIMESTAMPTZ,
      false
    FROM public.admin_permission_definitions pd
    ORDER BY pd.domain, pd.action;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pd.domain,
    pd.action,
    pd.high_risk,
    pd.requires_reauth,
    r.slug,
    a.scope_type,
    a.scope_value,
    a.expires_at,
    a.break_glass
  FROM public.admin_role_assignments a
  JOIN public.admin_roles r ON r.id = a.role_id
  JOIN public.admin_role_permissions rp ON rp.role_id = r.id
  JOIN public.admin_permission_definitions pd ON pd.id = rp.permission_id
  WHERE a.user_id = v_actor
    AND a.revoked_at IS NULL
    AND a.starts_at <= now()
    AND (a.expires_at IS NULL OR a.expires_at > now())
    AND NOT (r.slug = 'compliance_auditor' AND pd.action NOT IN ('read', 'export'))
  ORDER BY pd.domain, pd.action, r.slug;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_console_snapshot()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_snapshot JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin(v_actor) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Admin access is required.';
  END IF;

  SELECT jsonb_build_object(
    'reports', COALESCE((
      SELECT jsonb_object_agg(status, count)
      FROM (
        SELECT status, COUNT(*)::INT AS count
        FROM public.reports
        GROUP BY status
      ) s
    ), '{}'::jsonb),
    'pendingActionRequests', (
      SELECT COUNT(*)::INT FROM public.admin_action_requests WHERE status = 'pending'
    ),
    'auditEvents24h', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE created_at > now() - interval '24 hours'
    ),
    'breakGlassActive', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE break_glass = true
        AND revoked_at IS NULL
        AND starts_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
    ),
    'overdueAccessReviews', (
      SELECT COUNT(*)::INT
      FROM public.admin_role_assignments
      WHERE revoked_at IS NULL
        AND access_review_due_at < now()
    ),
    'policyDenials24h', (
      SELECT COUNT(*)::INT
      FROM public.admin_audit_events
      WHERE action = 'policy_denied'
        AND created_at > now() - interval '24 hours'
    ),
    'generatedAt', now()
  )
  INTO v_snapshot;

  RETURN v_snapshot;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_update_report_status(
  p_report_id UUID,
  p_status TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS public.reports
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before public.reports%ROWTYPE;
  v_after public.reports%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    IF v_actor IS NOT NULL THEN
      PERFORM public.admin_log_audit_event(
        v_actor,
        'moderation',
        'policy_denied',
        'report',
        p_report_id::text,
        COALESCE(NULLIF(p_reason_code, ''), 'audit:investigation'),
        'Denied report status update attempt.',
        NULL,
        jsonb_build_object('requested_status', p_status),
        p_ticket_ref,
        v_correlation,
        p_idempotency_key
      );
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'You do not have permission to update report status.';
  END IF;

  IF p_status NOT IN ('open', 'reviewing', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid report status.';
  END IF;

  SELECT *
  INTO v_before
  FROM public.reports
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Report was not found.';
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.admin_audit_events
    WHERE actor_id = v_actor
      AND action = 'update'
      AND domain = 'moderation'
      AND entity_type = 'report'
      AND entity_id = p_report_id::text
      AND idempotency_key = p_idempotency_key
  ) THEN
    RETURN v_before;
  END IF;

  UPDATE public.reports
  SET status = p_status,
      updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'update',
    'report',
    p_report_id::text,
    p_reason_code,
    p_justification,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ticket_ref,
    v_correlation,
    p_idempotency_key
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_admin_report_queue(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  reporter_id UUID,
  reported_user_id UUID,
  session_id UUID,
  message_id UUID,
  review_id UUID,
  reporter_name TEXT,
  reported_user_name TEXT,
  message_preview TEXT,
  review_preview TEXT,
  session_skill TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Only authorized moderators can view the moderation queue.';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.reason,
    r.details,
    r.status,
    r.created_at,
    r.reporter_id,
    r.reported_user_id,
    r.session_id,
    r.message_id,
    r.review_id,
    reporter.full_name AS reporter_name,
    reported.full_name AS reported_user_name,
    COALESCE(m.text, r.message_text_snapshot) AS message_preview,
    CASE
      WHEN rv.id IS NOT NULL
        THEN concat(rv.rating::TEXT, '/5 ', COALESCE(rv.comment, ''))
      WHEN r.review_rating_snapshot IS NOT NULL
        THEN concat(r.review_rating_snapshot::TEXT, '/5 ',
                    COALESCE(r.review_comment_snapshot, ''))
      ELSE NULL
    END AS review_preview,
    sk.name AS session_skill
  FROM public.reports r
  LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
  LEFT JOIN public.profiles reported ON reported.id = r.reported_user_id
  LEFT JOIN public.messages m ON m.id = r.message_id
  LEFT JOIN public.reviews rv ON rv.id = r.review_id
  LEFT JOIN public.sessions s ON s.id = COALESCE(r.session_id, m.session_id, rv.session_id)
  LEFT JOIN public.skills sk ON sk.id = s.skill_id
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;
-- ---------------------------------------------------------------------------
-- RLS and grants. Server-side RPCs are authoritative for writes.
-- ---------------------------------------------------------------------------

ALTER TABLE public.admin_permission_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_policy_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_reason_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_purge_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_case_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admin metadata read" ON public.admin_permission_definitions;
CREATE POLICY "Admin metadata read" ON public.admin_permission_definitions
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admin roles read" ON public.admin_roles;
CREATE POLICY "Admin roles read" ON public.admin_roles
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'access-governance', 'read'));
DROP POLICY IF EXISTS "Admin role permissions read" ON public.admin_role_permissions;
CREATE POLICY "Admin role permissions read" ON public.admin_role_permissions
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'access-governance', 'read'));
DROP POLICY IF EXISTS "Admin scopes read" ON public.admin_policy_scopes;
CREATE POLICY "Admin scopes read" ON public.admin_policy_scopes
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'access-governance', 'read'));
DROP POLICY IF EXISTS "Admin assignments read" ON public.admin_role_assignments;
CREATE POLICY "Admin assignments read" ON public.admin_role_assignments
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR public.admin_has_permission(auth.uid(), 'access-governance', 'read')
  );
DROP POLICY IF EXISTS "Admin reason codes read" ON public.admin_reason_codes;
CREATE POLICY "Admin reason codes read" ON public.admin_reason_codes
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admin action requests read" ON public.admin_action_requests;
CREATE POLICY "Admin action requests read" ON public.admin_action_requests
  FOR SELECT TO authenticated USING (
    maker_id = auth.uid()
    OR checker_id = auth.uid()
    OR public.admin_has_permission(auth.uid(), domain, 'read')
  );
DROP POLICY IF EXISTS "Admin audit read" ON public.admin_audit_events;
CREATE POLICY "Admin audit read" ON public.admin_audit_events
  FOR SELECT TO authenticated USING (
    public.admin_has_permission(auth.uid(), 'compliance', 'read')
    OR public.admin_has_permission(auth.uid(), 'security', 'read')
  );
DROP POLICY IF EXISTS "Retention policy read" ON public.data_retention_policies;
CREATE POLICY "Retention policy read" ON public.data_retention_policies
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'compliance', 'read'));
DROP POLICY IF EXISTS "Purge run read" ON public.retention_purge_runs;
CREATE POLICY "Purge run read" ON public.retention_purge_runs
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'compliance', 'read'));
DROP POLICY IF EXISTS "Privacy request read" ON public.privacy_requests;
CREATE POLICY "Privacy request read" ON public.privacy_requests
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'privacy', 'read'));
DROP POLICY IF EXISTS "Settings versions read" ON public.admin_settings_versions;
CREATE POLICY "Settings versions read" ON public.admin_settings_versions
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'settings', 'read'));
DROP POLICY IF EXISTS "Cases read" ON public.admin_cases;
CREATE POLICY "Cases read" ON public.admin_cases
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'moderation', 'read'));
DROP POLICY IF EXISTS "Case notes read" ON public.admin_case_notes;
CREATE POLICY "Case notes read" ON public.admin_case_notes
  FOR SELECT TO authenticated USING (public.admin_has_permission(auth.uid(), 'moderation', 'read'));
REVOKE ALL ON public.admin_permission_definitions FROM anon, authenticated;
REVOKE ALL ON public.admin_roles FROM anon, authenticated;
REVOKE ALL ON public.admin_role_permissions FROM anon, authenticated;
REVOKE ALL ON public.admin_policy_scopes FROM anon, authenticated;
REVOKE ALL ON public.admin_role_assignments FROM anon, authenticated;
REVOKE ALL ON public.admin_reason_codes FROM anon, authenticated;
REVOKE ALL ON public.admin_action_requests FROM anon, authenticated;
REVOKE ALL ON public.admin_audit_events FROM anon, authenticated;
REVOKE ALL ON public.data_retention_policies FROM anon, authenticated;
REVOKE ALL ON public.retention_purge_runs FROM anon, authenticated;
REVOKE ALL ON public.privacy_requests FROM anon, authenticated;
REVOKE ALL ON public.admin_settings_versions FROM anon, authenticated;
REVOKE ALL ON public.admin_cases FROM anon, authenticated;
REVOKE ALL ON public.admin_case_notes FROM anon, authenticated;
GRANT SELECT ON public.admin_permission_definitions TO authenticated;
GRANT SELECT ON public.admin_roles TO authenticated;
GRANT SELECT ON public.admin_role_permissions TO authenticated;
GRANT SELECT ON public.admin_policy_scopes TO authenticated;
GRANT SELECT ON public.admin_role_assignments TO authenticated;
GRANT SELECT ON public.admin_reason_codes TO authenticated;
GRANT SELECT ON public.admin_action_requests TO authenticated;
GRANT SELECT ON public.admin_audit_events TO authenticated;
GRANT SELECT ON public.data_retention_policies TO authenticated;
GRANT SELECT ON public.retention_purge_runs TO authenticated;
GRANT SELECT ON public.privacy_requests TO authenticated;
GRANT SELECT ON public.admin_settings_versions TO authenticated;
GRANT SELECT ON public.admin_cases TO authenticated;
GRANT SELECT ON public.admin_case_notes TO authenticated;
-- Close the existing direct admin write path for reports. Status changes now
-- require admin_update_report_status(reason, justification, idempotency_key).
REVOKE UPDATE ON public.reports FROM authenticated;
GRANT INSERT (
  reported_user_id,
  session_id,
  message_id,
  review_id,
  reason,
  details
) ON public.reports TO authenticated;
DROP POLICY IF EXISTS "Admins update reports" ON public.reports;
CREATE POLICY "Admins update reports via RPC only" ON public.reports
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);
DROP POLICY IF EXISTS "Admins view all reports" ON public.reports;
CREATE POLICY "Admins view authorized reports" ON public.reports
  FOR SELECT TO authenticated
  USING (public.admin_has_permission(auth.uid(), 'moderation', 'read'));
REVOKE EXECUTE ON FUNCTION public.admin_actor_role_snapshot(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_has_permission(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.require_admin_permission(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_log_audit_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.block_admin_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_admin_permissions() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_console_snapshot() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_report_queue(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_has_permission(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_admin_permissions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_console_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_report_queue(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(UUID) TO authenticated;
