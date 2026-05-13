-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Admin workflow wrapper batch. Public RPC names stay unchanged, while
-- privileged SECURITY DEFINER implementations move to a non-exposed schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.approve_finance_action(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.approve_finance_action(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.approve_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_admin_access_request(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_role_assignments
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.approve_admin_access_request(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.revoke_admin_assignment(
  p_assignment_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_role_assignments
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.revoke_admin_assignment(
    p_assignment_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.approve_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.approve_admin_setting_version(
    p_version_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.reject_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.reject_admin_setting_version(
    p_version_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.publish_admin_setting_version(
  p_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.publish_admin_setting_version(
    p_version_id, p_reason_code, p_justification, p_ticket_ref
  );
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
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.propose_admin_setting_change(
    p_setting_key, p_proposed_value, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key
  );
$$;

CREATE OR REPLACE FUNCTION public.propose_admin_setting_rollback(
  p_target_version_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.propose_admin_setting_rollback(
    p_target_version_id, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key
  );
$$;

CREATE OR REPLACE FUNCTION public.approve_finance_action(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.approve_finance_action(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.request_finance_action(
  p_action_type TEXT,
  p_target_user_id UUID,
  p_amount INT,
  p_session_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS public.admin_action_requests
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.request_finance_action(
    p_action_type, p_target_user_id, p_amount, p_session_id, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key
  );
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
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.create_privacy_request(
    p_subject_user_id, p_request_type, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key
  );
$$;

GRANT EXECUTE ON FUNCTION public.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.approve_admin_access_request(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_admin_assignment(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.publish_admin_setting_version(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.propose_admin_setting_change(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.propose_admin_setting_rollback(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_finance_action(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_privacy_request(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;

NOTIFY pgrst, 'reload schema';
