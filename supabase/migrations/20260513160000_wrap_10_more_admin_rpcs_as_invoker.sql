-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Third wrapper batch. Public RPC names stay unchanged, while the privileged
-- SECURITY DEFINER implementations move to a non-exposed schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.get_admin_finance_dashboard() SET SCHEMA private;
ALTER FUNCTION public.get_admin_sessions_dashboard(INT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.get_admin_settings_dashboard() SET SCHEMA private;
ALTER FUNCTION public.verify_admin_audit_chain(INT) SET SCHEMA private;
ALTER FUNCTION public.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.create_compliance_summary_manifest(TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.request_admin_access(TEXT, INT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.reject_finance_action(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.get_admin_finance_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_sessions_dashboard(INT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_settings_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.verify_admin_audit_chain(INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.create_compliance_summary_manifest(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.request_admin_access(TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.reject_finance_action(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.get_admin_finance_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_sessions_dashboard(INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_settings_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION private.verify_admin_audit_chain(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.create_compliance_summary_manifest(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.request_admin_access(TEXT, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.reject_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_finance_dashboard()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_finance_dashboard();
$$;

CREATE OR REPLACE FUNCTION public.get_admin_sessions_dashboard(
  p_limit INT DEFAULT 100,
  p_status TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_sessions_dashboard(p_limit, p_status);
$$;

CREATE OR REPLACE FUNCTION public.get_admin_settings_dashboard()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_settings_dashboard();
$$;

CREATE OR REPLACE FUNCTION public.verify_admin_audit_chain(p_limit INT DEFAULT 1000)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.verify_admin_audit_chain(p_limit);
$$;

CREATE OR REPLACE FUNCTION public.create_admin_audit_export_manifest(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.create_admin_audit_export_manifest(
    p_from, p_to, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.create_compliance_summary_manifest(
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.create_compliance_summary_manifest(
    p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.create_finance_report_manifest(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.create_finance_report_manifest(
    p_from, p_to, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.request_admin_access(
  p_role_slug TEXT,
  p_duration_hours INT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.request_admin_access(
    p_role_slug, p_duration_hours, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.reject_admin_access_request(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.reject_admin_access_request(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.reject_finance_action(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.reject_finance_action(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_finance_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_sessions_dashboard(INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_settings_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_compliance_summary_manifest(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_admin_access(TEXT, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_admin_finance_dashboard() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_sessions_dashboard(INT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_settings_dashboard() FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_admin_audit_chain(INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_admin_audit_export_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_compliance_summary_manifest(TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_admin_access(TEXT, INT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_finance_action(UUID, TEXT, TEXT, TEXT) FROM anon;

NOTIFY pgrst, 'reload schema';
