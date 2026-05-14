-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Moderation/admin action wrapper batch. Public RPC names stay unchanged,
-- while privileged SECURITY DEFINER implementations move to a non-exposed
-- schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_delete_skill(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_suspend_user(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_delete_skill(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_suspend_user(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_delete_skill(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_suspend_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_add_case_note(
  p_case_id UUID,
  p_body TEXT,
  p_visibility TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_case_notes
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_add_case_note(
    p_case_id, p_body, p_visibility, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_assign_case(
  p_case_id UUID,
  p_assigned_to UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_cases
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_assign_case(
    p_case_id, p_assigned_to, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_broadcast_notification(
  p_title TEXT,
  p_body TEXT,
  p_link TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS INT
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.admin_broadcast_notification(
    p_title, p_body, p_link, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_create_case_from_report(
  p_report_id UUID,
  p_severity TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS public.admin_cases
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_create_case_from_report(
    p_report_id, p_severity, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_create_skill(
  p_name TEXT,
  p_category TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.skills
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_create_skill(
    p_name, p_category, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_skill(
  p_skill_id UUID,
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
  SELECT private.admin_delete_skill(
    p_skill_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_reinstate_user(
  p_user_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.profiles
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_reinstate_user(
    p_user_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_suspend_user(
  p_user_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.profiles
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_suspend_user(
    p_user_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_update_case_status(
  p_case_id UUID,
  p_status TEXT,
  p_disposition TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_cases
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_update_case_status(
    p_case_id, p_status, p_disposition, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_update_report_status(
  p_report_id UUID,
  p_status TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT,
  p_idempotency_key TEXT DEFAULT NULL,
  p_resolution TEXT DEFAULT NULL
)
RETURNS public.reports
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.admin_update_report_status(
    p_report_id, p_status, p_reason_code, p_justification, p_ticket_ref, p_idempotency_key, p_resolution
  );
$$;

GRANT EXECUTE ON FUNCTION public.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_skill(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_add_case_note(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_assign_case(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_case_from_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_delete_skill(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_case_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;

NOTIFY pgrst, 'reload schema';
