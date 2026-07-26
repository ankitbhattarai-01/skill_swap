-- =============================================================================
-- Admin: add credits to any user's balance, straight from the Users page.
--
-- Credits could already be created three ways — the welcome bonus, teaching,
-- and (since 20260726000000) buying them — plus one admin path: the finance
-- maker-checker flow, where `manual_adjustment` is raised by one admin and
-- executed by a *different* one. That separation is right for a bank, but it
-- means a single admin can never settle a support case ("the gateway took my
-- money and I got nothing", "sorry about the failed session, here's 5 back")
-- without a second person on shift.
--
-- This adds the one-admin path for the common, low-risk direction only:
--
--   get_admin_user_credits(ids[])      — balances for the visible user rows.
--   admin_grant_user_credits(user, n)  — add n credits to one account.
--
-- Deliberately add-only. Taking credits away can push a balance somewhere the
-- user did not put it, so deductions stay on the maker-checker route in
-- /admin/finance (request_finance_action → approve_finance_action), which is
-- untouched by this migration.
--
-- Guards, in order of how likely they are to matter:
--   * wallet:override — the same permission the maker-checker adjustment needs.
--     Reading balances only needs wallet:read or users:read.
--   * 1..1000 credits per action, so a slipped keypress cannot mint a fortune.
--     Larger corrections are several audited actions, or the finance flow.
--   * Ticket reference + 8-char justification, enforced here and again inside
--     admin_log_audit_event.
--   * A grant to your own account is allowed (an admin is a user too) but is
--     stamped `self_grant: true` in the audit event, so it stands out in a
--     later review rather than blending in.
--
-- Every grant writes three rows: the profile balance, a credit_transactions
-- entry the recipient sees in /credits, and a tamper-evident audit event. The
-- recipient also gets an in-app notification — type 'credit_grant', which the
-- email fanout trigger ignores (it only dispatches on session_*).
--
-- Advisor 0028/0029: privileged bodies live in `private`, the public names are
-- thin SECURITY INVOKER wrappers. Same shape as 20260726010000.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;


-- ─── 1. Reason code ──────────────────────────────────────────────────────────
-- Ticket required, matching the other two wallet overrides.

INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES ('wallet:admin_grant', 'wallet', 'override', 'Credits added by an admin', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;


-- ─── 2. Read: balances for a batch of users ──────────────────────────────────
-- One round trip for the whole visible page of the user table, same shape as
-- get_admin_user_strike_counts. Returns {user_id: credits}.

CREATE OR REPLACE FUNCTION private.get_admin_user_credits(p_user_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL
     OR NOT (
       public.admin_has_permission(v_actor, 'wallet', 'read')
       OR public.admin_has_permission(v_actor, 'users', 'read')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet or users read permission is required.';
  END IF;

  IF p_user_ids IS NULL OR array_length(p_user_ids, 1) IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  IF array_length(p_user_ids, 1) > 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'At most 200 users can be summarised at once.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_object_agg(p.id::TEXT, p.credits)
    FROM public.profiles p
    WHERE p.id = ANY (p_user_ids)
  ), '{}'::jsonb);
END;
$$;


-- ─── 3. Write: add credits to one account ────────────────────────────────────

CREATE OR REPLACE FUNCTION private.admin_grant_user_credits(
  p_user_id UUID,
  p_amount INT,
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
  -- The ceiling on a single grant. Not a daily budget: an admin who needs more
  -- can run the action again, and each run is its own audit event.
  c_max_grant CONSTANT INT := 1000;
  v_actor          UUID := auth.uid();
  v_before_credits INT;
  v_after_credits  INT;
  v_transaction_id UUID;
BEGIN
  IF v_actor IS NULL
     OR NOT public.admin_has_permission(v_actor, 'wallet', 'override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Wallet override permission is required to add credits.';
  END IF;

  IF p_amount IS NULL OR p_amount < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Amount must be at least 1 credit.';
  END IF;

  IF p_amount > c_max_grant THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('At most %s credits can be added in one action.', c_max_grant);
  END IF;

  IF coalesce(length(btrim(p_justification)), 0) < 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Justification must be at least 8 characters.';
  END IF;

  IF coalesce(length(btrim(p_ticket_ref)), 0) < 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Ticket reference is required to add credits.';
  END IF;

  -- FOR UPDATE serialises a double-clicked button against itself, and against
  -- anything else moving this balance (a session settling mid-grant).
  SELECT p.credits INTO v_before_credits
  FROM public.profiles p
  WHERE p.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'That user was not found.';
  END IF;

  UPDATE public.profiles
  SET credits = credits + p_amount
  WHERE id = p_user_id
  RETURNING credits INTO v_after_credits;

  -- from_user NULL with session_id NULL marks credits entering the system
  -- rather than moving between two students, the same shape a purchase writes.
  -- /credits matches this description to render it as an admin grant — keep
  -- the two in step if you ever reword it.
  INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
  VALUES (NULL, p_user_id, p_amount, NULL, 'Credits added by an admin')
  RETURNING id INTO v_transaction_id;

  -- In-app only: dispatch_session_email returns early for anything that is not
  -- a session_* type, so this sends no mail.
  INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
  VALUES (
    p_user_id,
    'credit_grant',
    format('%s credit%s added to your balance', p_amount, CASE WHEN p_amount = 1 THEN '' ELSE 's' END),
    'An admin topped up your account. Your new balance is ' || v_after_credits || ' credits.',
    '/credits',
    jsonb_build_object('amount', p_amount, 'new_balance', v_after_credits)
  );

  PERFORM public.admin_log_audit_event(
    v_actor,
    'wallet',
    'override',
    'profile',
    p_user_id::TEXT,
    p_reason_code,
    p_justification,
    jsonb_build_object('user_id', p_user_id, 'credits', v_before_credits),
    jsonb_build_object(
      'user_id', p_user_id,
      'credits', v_after_credits,
      'amount', p_amount,
      'transaction_id', v_transaction_id,
      'self_grant', v_actor = p_user_id
    ),
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'amount', p_amount,
    'previous_balance', v_before_credits,
    'new_balance', v_after_credits,
    'transaction_id', v_transaction_id
  );
END;
$$;


-- ─── 4. Grants on the private bodies ─────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION private.get_admin_user_credits(UUID[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_grant_user_credits(UUID, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.get_admin_user_credits(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_grant_user_credits(UUID, INT, TEXT, TEXT, TEXT) TO authenticated;


-- ─── 5. Public SECURITY INVOKER wrappers ─────────────────────────────────────
-- auth.uid() reads the request JWT, not the effective role, so the permission
-- checks inside the bodies see the same caller through the wrapper.

CREATE OR REPLACE FUNCTION public.get_admin_user_credits(p_user_ids UUID[])
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_user_credits(p_user_ids);
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_user_credits(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_user_credits(UUID[]) TO authenticated;


CREATE OR REPLACE FUNCTION public.admin_grant_user_credits(
  p_user_id UUID,
  p_amount INT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.admin_grant_user_credits(
    p_user_id, p_amount, p_reason_code, p_justification, p_ticket_ref
  );
$$;
REVOKE EXECUTE ON FUNCTION public.admin_grant_user_credits(UUID, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_user_credits(UUID, INT, TEXT, TEXT, TEXT) TO authenticated;


NOTIFY pgrst, 'reload schema';
