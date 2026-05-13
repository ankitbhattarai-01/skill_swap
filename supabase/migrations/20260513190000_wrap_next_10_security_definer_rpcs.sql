-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Next mixed RPC wrapper batch. Public RPC names stay unchanged, while
-- privileged SECURITY DEFINER implementations move to a non-exposed schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.accept_session(UUID, TEXT) SET SCHEMA private;
ALTER FUNCTION public.cancel_session(UUID) SET SCHEMA private;
ALTER FUNCTION public.complete_privacy_export(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.complete_session(UUID) SET SCHEMA private;
ALTER FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) SET SCHEMA private;
ALTER FUNCTION public.delete_my_account() SET SCHEMA private;
ALTER FUNCTION public.dispute_session(UUID) SET SCHEMA private;
ALTER FUNCTION public.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.get_admin_report_queue(INT) SET SCHEMA private;
ALTER FUNCTION public.get_my_admin_permissions() SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.accept_session(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.cancel_session(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.complete_privacy_export(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.complete_session(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.compute_intersection_slots(UUID, UUID, INT, INT, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.delete_my_account() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.dispute_session(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_report_queue(INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_my_admin_permissions() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.accept_session(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.cancel_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.complete_privacy_export(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.complete_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.compute_intersection_slots(UUID, UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.delete_my_account() TO authenticated;
GRANT EXECUTE ON FUNCTION private.dispute_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_report_queue(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_my_admin_permissions() TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_session(
  p_session_id UUID,
  p_meet_link TEXT DEFAULT NULL
)
RETURNS public.sessions
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.accept_session(p_session_id, p_meet_link);
$$;

CREATE OR REPLACE FUNCTION public.cancel_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.cancel_session(p_session_id);
$$;

CREATE OR REPLACE FUNCTION public.complete_privacy_export(
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
  SELECT private.complete_privacy_export(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.complete_session(p_session_id);
$$;

CREATE OR REPLACE FUNCTION public.compute_intersection_slots(
  p_learner_id UUID,
  p_teacher_id UUID,
  p_duration_minutes INT,
  p_horizon_days INT DEFAULT 7,
  p_max_slots INT DEFAULT 3
)
RETURNS TABLE (proposed_start TIMESTAMPTZ)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
SET TimeZone = 'UTC'
AS $$
  SELECT * FROM private.compute_intersection_slots(
    p_learner_id, p_teacher_id, p_duration_minutes, p_horizon_days, p_max_slots
  );
$$;

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.delete_my_account();
$$;

CREATE OR REPLACE FUNCTION public.dispute_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.dispute_session(p_session_id);
$$;

CREATE OR REPLACE FUNCTION public.execute_privacy_anonymization(
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
  SELECT private.execute_privacy_anonymization(
    p_request_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.get_admin_report_queue(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
  resolution TEXT,
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
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.get_admin_report_queue(p_limit);
$$;

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
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.get_my_admin_permissions();
$$;

GRANT EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_privacy_export(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_report_queue(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_admin_permissions() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_session(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_privacy_export(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_session(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_my_account() FROM anon;
REVOKE EXECUTE ON FUNCTION public.dispute_session(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.execute_privacy_anonymization(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_report_queue(INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_admin_permissions() FROM anon;

NOTIFY pgrst, 'reload schema';
