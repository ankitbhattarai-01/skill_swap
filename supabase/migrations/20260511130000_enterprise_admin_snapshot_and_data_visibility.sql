-- Admin data visibility hardening: expose real platform totals in the admin
-- snapshot and keep empty states distinguishable from RPC failures.

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
    'users', jsonb_build_object(
      'total', (SELECT COUNT(*)::INT FROM auth.users),
      'profiles', (SELECT COUNT(*)::INT FROM public.profiles),
      'onboarded', (SELECT COUNT(*)::INT FROM public.profiles WHERE onboarded = true),
      'admins', (
        SELECT COUNT(DISTINCT a.user_id)::INT
        FROM public.admin_role_assignments a
        WHERE a.revoked_at IS NULL
          AND a.starts_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
      )
    ),
    'sessions', COALESCE((
      SELECT jsonb_object_agg(status, count)
      FROM (
        SELECT status, COUNT(*)::INT AS count
        FROM public.sessions
        GROUP BY status
      ) s
    ), '{}'::jsonb),
    'reports', COALESCE((
      SELECT jsonb_object_agg(status, count)
      FROM (
        SELECT status, COUNT(*)::INT AS count
        FROM public.reports
        GROUP BY status
      ) s
    ), '{}'::jsonb),
    'ledger', jsonb_build_object(
      'transactions', (SELECT COUNT(*)::INT FROM public.credit_transactions),
      'creditsMoved24h', (
        SELECT COALESCE(SUM(ABS(amount)), 0)::INT
        FROM public.credit_transactions
        WHERE created_at > now() - interval '24 hours'
      ),
      'negativeBalances', (SELECT COUNT(*)::INT FROM public.profiles WHERE credits < 0)
    ),
    'privacy', jsonb_build_object(
      'openRequests', (
        SELECT COUNT(*)::INT
        FROM public.privacy_requests
        WHERE status IN ('open', 'validating', 'in_progress')
      ),
      'legalHolds', (
        SELECT COUNT(*)::INT
        FROM public.privacy_requests
        WHERE legal_hold = true
      )
    ),
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
GRANT EXECUTE ON FUNCTION public.get_admin_console_snapshot() TO authenticated;
