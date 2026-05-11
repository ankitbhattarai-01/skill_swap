-- Enterprise admin Phase 4: finance maker-checker controls, ledger
-- reconciliation, anomaly reporting, and finance report manifests.

CREATE TABLE IF NOT EXISTS public.finance_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL DEFAULT 'manual' CHECK (run_type IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  total_profiles INT NOT NULL DEFAULT 0,
  negative_balance_count INT NOT NULL DEFAULT 0,
  stuck_escrow_count INT NOT NULL DEFAULT 0,
  unusual_velocity_count INT NOT NULL DEFAULT 0,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.finance_reconciliation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Finance reconciliation read" ON public.finance_reconciliation_runs;
CREATE POLICY "Finance reconciliation read" ON public.finance_reconciliation_runs
  FOR SELECT TO authenticated
  USING (
    public.admin_has_permission(auth.uid(), 'wallet', 'read')
    OR public.admin_has_permission(auth.uid(), 'compliance', 'read')
  );
REVOKE ALL ON public.finance_reconciliation_runs FROM anon, authenticated;
GRANT SELECT ON public.finance_reconciliation_runs TO authenticated;
INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('wallet:refund_override', 'wallet', 'override', 'Refund or reversal override', true),
  ('wallet:reconciliation', 'wallet', 'read', 'Ledger reconciliation review', true),
  ('wallet:report_export', 'wallet', 'export', 'Finance report pack export', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;
CREATE OR REPLACE FUNCTION public.get_admin_finance_dashboard()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet read permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'pendingFinanceRequests', (
      SELECT COUNT(*)::INT
      FROM public.admin_action_requests
      WHERE request_type = 'finance_action'
        AND status = 'pending'
    ),
    'negativeBalances', (
      SELECT COUNT(*)::INT
      FROM public.profiles
      WHERE credits < 0
    ),
    'stuckEscrow', (
      SELECT COUNT(*)::INT
      FROM public.sessions
      WHERE escrow_held = true
        AND status IN ('accepted', 'active')
        AND COALESCE(scheduled_at, updated_at, created_at) < now() - interval '14 days'
    ),
    'unusualVelocity24h', (
      SELECT COUNT(*)::INT
      FROM (
        SELECT COALESCE(from_user, to_user) AS user_id
        FROM public.credit_transactions
        WHERE created_at > now() - interval '24 hours'
        GROUP BY COALESCE(from_user, to_user)
        HAVING COUNT(*) >= 20 OR SUM(ABS(amount)) >= 200
      ) velocity
    ),
    'ledgerEntries24h', (
      SELECT COUNT(*)::INT
      FROM public.credit_transactions
      WHERE created_at > now() - interval '24 hours'
    ),
    'creditsMoved24h', (
      SELECT COALESCE(SUM(ABS(amount)), 0)::INT
      FROM public.credit_transactions
      WHERE created_at > now() - interval '24 hours'
    ),
    'requests', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          ar.id,
          ar.status,
          ar.maker_id,
          maker.email::TEXT AS maker_email,
          ar.checker_id,
          checker.email::TEXT AS checker_email,
          ar.reason_code,
          ar.justification,
          ar.ticket_ref,
          ar.payload,
          ar.created_at,
          ar.decided_at,
          ar.executed_at
        FROM public.admin_action_requests ar
        LEFT JOIN auth.users maker ON maker.id = ar.maker_id
        LEFT JOIN auth.users checker ON checker.id = ar.checker_id
        WHERE ar.request_type = 'finance_action'
        ORDER BY ar.created_at DESC
        LIMIT 50
      ) x
    ), '[]'::jsonb),
    'negativeBalanceRows', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT p.id AS user_id, u.email::TEXT AS user_email, p.credits
        FROM public.profiles p
        LEFT JOIN auth.users u ON u.id = p.id
        WHERE p.credits < 0
        ORDER BY p.credits ASC
        LIMIT 25
      ) x
    ), '[]'::jsonb),
    'stuckEscrowRows', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          s.id,
          s.learner_id,
          learner.email::TEXT AS learner_email,
          s.teacher_id,
          teacher.email::TEXT AS teacher_email,
          s.credits,
          s.status,
          s.scheduled_at,
          s.updated_at
        FROM public.sessions s
        LEFT JOIN auth.users learner ON learner.id = s.learner_id
        LEFT JOIN auth.users teacher ON teacher.id = s.teacher_id
        WHERE s.escrow_held = true
          AND s.status IN ('accepted', 'active')
          AND COALESCE(s.scheduled_at, s.updated_at, s.created_at) < now() - interval '14 days'
        ORDER BY COALESCE(s.scheduled_at, s.updated_at, s.created_at) ASC
        LIMIT 25
      ) x
    ), '[]'::jsonb),
    'recentReconciliations', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          r.id,
          r.run_type,
          r.status,
          r.negative_balance_count,
          r.stuck_escrow_count,
          r.unusual_velocity_count,
          r.started_at,
          r.completed_at
        FROM public.finance_reconciliation_runs r
        ORDER BY r.started_at DESC
        LIMIT 10
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  );
END;
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
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_request public.admin_action_requests%ROWTYPE;
  v_session public.sessions%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet override permission is required.';
  END IF;

  IF p_action_type NOT IN ('manual_adjustment', 'escrow_refund', 'escrow_release') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid finance action type.';
  END IF;

  IF NULLIF(btrim(COALESCE(p_ticket_ref, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Ticket reference is required.';
  END IF;

  IF p_action_type = 'manual_adjustment' THEN
    IF p_target_user_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Manual adjustments require target user and non-zero amount.';
    END IF;
  ELSE
    IF p_session_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Escrow interventions require a session.';
    END IF;

    SELECT * INTO v_session
    FROM public.sessions
    WHERE id = p_session_id;

    IF NOT FOUND OR v_session.escrow_held = false THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session has no held escrow.';
    END IF;
  END IF;

  INSERT INTO public.admin_action_requests (
    request_type,
    domain,
    action,
    entity_type,
    entity_id,
    payload,
    maker_id,
    reason_code,
    justification,
    ticket_ref,
    idempotency_key,
    required_permission_domain,
    required_permission_action,
    expires_at
  )
  VALUES (
    'finance_action',
    'wallet',
    'override',
    CASE WHEN p_action_type = 'manual_adjustment' THEN 'profile' ELSE 'session' END,
    COALESCE(p_target_user_id::TEXT, p_session_id::TEXT),
    jsonb_build_object(
      'action_type', p_action_type,
      'target_user_id', p_target_user_id,
      'amount', p_amount,
      'session_id', p_session_id
    ),
    v_actor,
    p_reason_code,
    p_justification,
    p_ticket_ref,
    NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''),
    'wallet',
    'approve',
    now() + interval '7 days'
  )
  RETURNING * INTO v_request;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'override',
    'admin_action_request',
    v_request.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    to_jsonb(v_request),
    p_ticket_ref,
    gen_random_uuid(),
    p_idempotency_key,
    '{}'::jsonb
  );

  RETURN v_request;
END;
$$;
CREATE OR REPLACE FUNCTION public.approve_finance_action(
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
  v_request public.admin_action_requests%ROWTYPE;
  v_action_type TEXT;
  v_target_user UUID;
  v_amount INT;
  v_session_id UUID;
  v_session public.sessions%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_transaction_id UUID;
  v_correlation UUID := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet approval permission is required.';
  END IF;

  SELECT * INTO v_request
  FROM public.admin_action_requests
  WHERE id = p_request_id
    AND request_type = 'finance_action'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Finance request was not found.';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Finance request is not pending.';
  END IF;

  IF v_request.maker_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Maker cannot approve own finance request.';
  END IF;

  v_action_type := v_request.payload ->> 'action_type';
  v_target_user := NULLIF(v_request.payload ->> 'target_user_id', '')::UUID;
  v_amount := NULLIF(v_request.payload ->> 'amount', '')::INT;
  v_session_id := NULLIF(v_request.payload ->> 'session_id', '')::UUID;

  IF v_action_type = 'manual_adjustment' THEN
    SELECT jsonb_build_object('user_id', p.id, 'credits', p.credits)
    INTO v_before
    FROM public.profiles p
    WHERE p.id = v_target_user
    FOR UPDATE;

    IF v_before IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Target user was not found.';
    END IF;

    IF ((v_before ->> 'credits')::INT + v_amount) < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Adjustment would create negative balance.';
    END IF;

    UPDATE public.profiles
    SET credits = credits + v_amount
    WHERE id = v_target_user;

    INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
    VALUES (
      CASE WHEN v_amount < 0 THEN v_target_user ELSE NULL END,
      CASE WHEN v_amount > 0 THEN v_target_user ELSE NULL END,
      ABS(v_amount),
      NULL,
      'Admin finance adjustment: ' || COALESCE(v_request.ticket_ref, p_ticket_ref)
    )
    RETURNING id INTO v_transaction_id;

    SELECT jsonb_build_object('user_id', p.id, 'credits', p.credits, 'transaction_id', v_transaction_id)
    INTO v_after
    FROM public.profiles p
    WHERE p.id = v_target_user;
  ELSIF v_action_type IN ('escrow_refund', 'escrow_release') THEN
    SELECT * INTO v_session
    FROM public.sessions
    WHERE id = v_session_id
    FOR UPDATE;

    IF NOT FOUND OR v_session.escrow_held = false THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session has no held escrow.';
    END IF;

    v_before := to_jsonb(v_session);

    IF v_action_type = 'escrow_refund' THEN
      UPDATE public.profiles
      SET credits = credits + v_session.credits
      WHERE id = v_session.learner_id;

      INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
      VALUES (NULL, v_session.learner_id, v_session.credits, v_session.id, 'Admin escrow refund override')
      RETURNING id INTO v_transaction_id;
    ELSE
      UPDATE public.profiles
      SET credits = credits + v_session.credits
      WHERE id = v_session.teacher_id;

      INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
      VALUES (v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id, 'Admin escrow release override')
      RETURNING id INTO v_transaction_id;
    END IF;

    UPDATE public.sessions
    SET escrow_held = false,
        status = CASE WHEN v_action_type = 'escrow_refund' THEN 'cancelled' ELSE 'completed' END
    WHERE id = v_session.id
    RETURNING * INTO v_session;

    v_after := to_jsonb(v_session) || jsonb_build_object('transaction_id', v_transaction_id);
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Unsupported finance action.';
  END IF;

  UPDATE public.admin_action_requests
  SET status = 'approved',
      checker_id = v_actor,
      decided_at = now(),
      executed_at = now()
  WHERE id = p_request_id;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'approve',
    CASE WHEN v_action_type = 'manual_adjustment' THEN 'profile' ELSE 'session' END,
    COALESCE(v_target_user::TEXT, v_session_id::TEXT),
    p_reason_code,
    p_justification,
    v_before,
    v_after,
    p_ticket_ref,
    v_correlation,
    v_request.idempotency_key,
    '{}'::jsonb
  );

  RETURN jsonb_build_object(
    'requestId', p_request_id,
    'actionType', v_action_type,
    'transactionId', v_transaction_id,
    'correlationId', v_correlation
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.reject_finance_action(
  p_request_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.admin_action_requests
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before public.admin_action_requests%ROWTYPE;
  v_after public.admin_action_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet approval permission is required.';
  END IF;

  SELECT * INTO v_before
  FROM public.admin_action_requests
  WHERE id = p_request_id
    AND request_type = 'finance_action'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Finance request was not found.';
  END IF;

  IF v_before.maker_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Maker cannot reject own finance request.';
  END IF;

  UPDATE public.admin_action_requests
  SET status = 'rejected',
      checker_id = v_actor,
      decided_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'approve',
    'admin_action_request',
    p_request_id::TEXT,
    p_reason_code,
    p_justification,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.run_finance_reconciliation(
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.finance_reconciliation_runs
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_run public.finance_reconciliation_runs%ROWTYPE;
  v_manifest JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet read permission is required.';
  END IF;

  v_manifest := jsonb_build_object(
    'totalProfiles', (SELECT COUNT(*)::INT FROM public.profiles),
    'negativeBalances', (SELECT COUNT(*)::INT FROM public.profiles WHERE credits < 0),
    'stuckEscrow', (
      SELECT COUNT(*)::INT
      FROM public.sessions
      WHERE escrow_held = true
        AND status IN ('accepted', 'active')
        AND COALESCE(scheduled_at, updated_at, created_at) < now() - interval '14 days'
    ),
    'unusualVelocity', (
      SELECT COUNT(*)::INT
      FROM (
        SELECT COALESCE(from_user, to_user)
        FROM public.credit_transactions
        WHERE created_at > now() - interval '24 hours'
        GROUP BY COALESCE(from_user, to_user)
        HAVING COUNT(*) >= 20 OR SUM(ABS(amount)) >= 200
      ) v
    ),
    'generatedAt', now()
  );

  INSERT INTO public.finance_reconciliation_runs (
    run_type,
    status,
    total_profiles,
    negative_balance_count,
    stuck_escrow_count,
    unusual_velocity_count,
    manifest,
    started_by
  )
  VALUES (
    'manual',
    'completed',
    (v_manifest ->> 'totalProfiles')::INT,
    (v_manifest ->> 'negativeBalances')::INT,
    (v_manifest ->> 'stuckEscrow')::INT,
    (v_manifest ->> 'unusualVelocity')::INT,
    v_manifest,
    v_actor
  )
  RETURNING * INTO v_run;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'read',
    'finance_reconciliation_run',
    v_run.id::TEXT,
    p_reason_code,
    p_justification,
    NULL,
    to_jsonb(v_run),
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  RETURN v_run;
END;
$$;
CREATE OR REPLACE FUNCTION public.create_finance_report_manifest(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
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
  v_manifest JSONB;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'wallet', 'export') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet export permission is required.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Valid report range is required.';
  END IF;

  v_manifest := jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'transactionCount', (
      SELECT COUNT(*)::INT
      FROM public.credit_transactions
      WHERE created_at >= p_from AND created_at <= p_to
    ),
    'creditsMoved', (
      SELECT COALESCE(SUM(ABS(amount)), 0)::INT
      FROM public.credit_transactions
      WHERE created_at >= p_from AND created_at <= p_to
    ),
    'manifestHash', (
      SELECT encode(digest(COALESCE(string_agg(id::TEXT || ':' || amount::TEXT, '' ORDER BY created_at, id), ''), 'sha256'), 'hex')
      FROM public.credit_transactions
      WHERE created_at >= p_from AND created_at <= p_to
    ),
    'generatedBy', v_actor,
    'generatedAt', now()
  );

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'export',
    'credit_transactions',
    'finance-report',
    p_reason_code,
    p_justification,
    NULL,
    v_manifest,
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  RETURN v_manifest;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_finance_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_finance_action(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_finance_action(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.run_finance_reconciliation(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_finance_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_finance_action(TEXT, UUID, INT, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_finance_action(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_finance_reconciliation(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_finance_report_manifest(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated;
