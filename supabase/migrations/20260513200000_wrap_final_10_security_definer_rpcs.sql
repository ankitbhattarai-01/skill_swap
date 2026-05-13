-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Final public SECURITY DEFINER RPC wrapper batch from the security advisor
-- export. Public RPC names stay unchanged, while privileged implementations
-- move to a non-exposed schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.is_admin(UUID) SET SCHEMA private;
ALTER FUNCTION public.my_credit_balance() SET SCHEMA private;
ALTER FUNCTION public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) SET SCHEMA private;
ALTER FUNCTION public.record_session_join(UUID) SET SCHEMA private;
ALTER FUNCTION public.reject_session(UUID) SET SCHEMA private;
ALTER FUNCTION public.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.run_finance_reconciliation(TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) SET SCHEMA private;
ALTER FUNCTION public.teachers_intersection_status(UUID[], INT, INT) SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.is_admin(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.my_credit_balance() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.record_session_join(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.reject_session(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.run_finance_reconciliation(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.teachers_intersection_status(UUID[], INT, INT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.is_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.my_credit_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION private.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION private.record_session_join(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.reject_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.run_finance_reconciliation(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.teachers_intersection_status(UUID[], INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.is_admin(p_user);
$$;

CREATE OR REPLACE FUNCTION public.my_credit_balance()
RETURNS INT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.my_credit_balance();
$$;

CREATE OR REPLACE FUNCTION public.propose_track(
  p_teacher_id UUID,
  p_skill_id UUID,
  p_goal TEXT,
  p_pattern TEXT,
  p_planned_count INT,
  p_default_duration_minutes INT,
  p_first_start_at TIMESTAMPTZ
)
RETURNS public.learning_tracks
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.propose_track(
    p_teacher_id,
    p_skill_id,
    p_goal,
    p_pattern,
    p_planned_count,
    p_default_duration_minutes,
    p_first_start_at
  );
$$;

CREATE OR REPLACE FUNCTION public.record_session_join(p_session_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.record_session_join(p_session_id);
$$;

CREATE OR REPLACE FUNCTION public.reject_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.reject_session(p_session_id);
$$;

CREATE OR REPLACE FUNCTION public.reveal_admin_user_pii(
  p_user_id UUID,
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
  SELECT private.reveal_admin_user_pii(
    p_user_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.run_finance_reconciliation(
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.finance_reconciliation_runs
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.run_finance_reconciliation(
    p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.run_retention_purge(
  p_policy_id UUID,
  p_dry_run BOOLEAN,
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
  SELECT private.run_retention_purge(
    p_policy_id, p_dry_run, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.set_privacy_request_legal_hold(
  p_request_id UUID,
  p_legal_hold BOOLEAN,
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
  SELECT private.set_privacy_request_legal_hold(
    p_request_id, p_legal_hold, p_reason_code, p_justification, p_ticket_ref
  );
$$;

CREATE OR REPLACE FUNCTION public.teachers_intersection_status(
  p_teacher_ids UUID[],
  p_duration_minutes INT DEFAULT 30,
  p_horizon_days INT DEFAULT 7
)
RETURNS TABLE (teacher_id UUID, next_slot TIMESTAMPTZ)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
SET TimeZone = 'UTC'
AS $$
  SELECT * FROM private.teachers_intersection_status(
    p_teacher_ids, p_duration_minutes, p_horizon_days
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_credit_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_session_join(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_finance_reconciliation(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teachers_intersection_status(UUID[], INT, INT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_admin(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.my_credit_balance() FROM anon;
REVOKE EXECUTE ON FUNCTION public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_session_join(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_session(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reveal_admin_user_pii(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.run_finance_reconciliation(TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.run_retention_purge(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_privacy_request_legal_hold(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.teachers_intersection_status(UUID[], INT, INT) FROM anon;

NOTIFY pgrst, 'reload schema';
