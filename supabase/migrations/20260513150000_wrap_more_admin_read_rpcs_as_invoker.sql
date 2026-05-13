-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Second admin read wrapper batch. Public RPC names stay unchanged, while the
-- privileged SECURITY DEFINER implementations move to a non-exposed schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.get_admin_access_governance() SET SCHEMA private;
ALTER FUNCTION public.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) SET SCHEMA private;
ALTER FUNCTION public.get_admin_cases(INT) SET SCHEMA private;
ALTER FUNCTION public.get_admin_case_notes(UUID) SET SCHEMA private;
ALTER FUNCTION public.get_admin_compliance_dashboard() SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.get_admin_access_governance() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_cases(INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_case_notes(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_compliance_dashboard() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.get_admin_access_governance() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_cases(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_case_notes(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_compliance_dashboard() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_access_governance()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_access_governance();
$$;

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
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT *
  FROM private.get_admin_audit_events(
    p_limit, p_domain, p_action, p_actor_id, p_entity_type, p_entity_id, p_from, p_to
  );
$$;

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
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.get_admin_cases(p_limit);
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
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.get_admin_case_notes(p_case_id);
$$;

CREATE OR REPLACE FUNCTION public.get_admin_compliance_dashboard()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_compliance_dashboard();
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_access_governance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_cases(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_case_notes(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_compliance_dashboard() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_admin_access_governance() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_audit_events(INT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_cases(INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_case_notes(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_compliance_dashboard() FROM anon;

NOTIFY pgrst, 'reload schema';
