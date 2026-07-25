-- =============================================================================
-- Admin: remove strikes from any user.
--
-- Strikes (migration 20260512070000) are issued automatically by cancel_session
-- and auto_settle_session, and manually by the report queue. Three of them pause
-- teaching, five block every new session, eight are a permanent lockout — but
-- until now nothing in the product could take one back. admin_revoke_strike()
-- has existed since day one, yet 20260513050000 pulled its EXECUTE grant (it
-- had no caller), and it never wrote to the audit chain, so the admin console
-- had no path to it at all.
--
-- This migration adds the missing surface, built like every other privileged
-- admin action on the platform:
--
--   get_admin_user_strikes(user)         — the ledger for one user, plus their
--                                          current suspension state.
--   get_admin_user_strike_counts(ids[])  — active weight per user, so the user
--                                          table can badge who has strikes.
--   admin_revoke_user_strike(strike, …)  — remove one strike.
--   admin_clear_user_strikes(user, …)    — remove every strike a user still has.
--
-- Removal is a revoke, not a delete: revoked_at/revoked_by/revoke_reason are
-- stamped on the row. user_active_strike_weight() and user_suspension_state()
-- both filter on `revoked_at IS NULL`, so the penalty lifts the instant the row
-- is revoked, while the history stays intact for later review.
--
-- Reading requires moderation:read or users:read. Removing requires
-- moderation:override (moderators can review, trust leads and super admins can
-- overturn) and writes a tamper-evident audit event with reason code, ticket
-- reference, and justification.
--
-- Advisor 0028/0029: the privileged bodies live in `private` so PostgREST never
-- exposes a SECURITY DEFINER function directly; the public names are thin
-- SECURITY INVOKER wrappers. Same shape as 20260725000000.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;


-- ─── 1. Reason codes ─────────────────────────────────────────────────────────
-- Both are overrides of an existing penalty, so both require a ticket, matching
-- users:suspend / users:reinstate.

INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('moderation:strike_revoke', 'moderation', 'override', 'Strike removed on review', true),
  ('moderation:strike_clear',  'moderation', 'override', 'All strikes cleared on review', true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;


-- ─── 2. Read: one user's strike ledger ───────────────────────────────────────

CREATE OR REPLACE FUNCTION private.get_admin_user_strikes(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_state RECORD;
BEGIN
  IF v_actor IS NULL
     OR NOT (
       public.admin_has_permission(v_actor, 'moderation', 'read')
       OR public.admin_has_permission(v_actor, 'users', 'read')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation or users read permission is required.';
  END IF;

  SELECT s.kind, s.expires_at INTO v_state
  FROM public.user_suspension_state(p_user_id) s;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'suspension_kind', v_state.kind,
    'suspension_expires_at', v_state.expires_at,
    -- 90 days is the full decay window, so this matches what the user sees in
    -- their own StrikeIndicator.
    'active_weight', public.user_active_strike_weight(p_user_id, INTERVAL '90 days'),
    'strikes', COALESCE((
      SELECT jsonb_agg(row_to_json(x))
      FROM (
        SELECT
          s.id,
          s.reason,
          s.weight,
          s.notes,
          s.session_id,
          s.report_id,
          s.created_at,
          s.expires_at,
          s.revoked_at,
          s.revoke_reason,
          (s.revoked_at IS NULL AND s.expires_at > now()) AS is_active
        FROM public.user_strikes s
        WHERE s.user_id = p_user_id
        ORDER BY s.created_at DESC
        LIMIT 200
      ) x
    ), '[]'::jsonb)
  );
END;
$$;


-- ─── 3. Read: active weight for a batch of users ─────────────────────────────
-- One round trip for the whole visible page of the user table. Returns a
-- {user_id: weight} object; users with no active strikes are simply absent.

CREATE OR REPLACE FUNCTION private.get_admin_user_strike_counts(p_user_ids UUID[])
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
       public.admin_has_permission(v_actor, 'moderation', 'read')
       OR public.admin_has_permission(v_actor, 'users', 'read')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation or users read permission is required.';
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
    SELECT jsonb_object_agg(t.user_id::TEXT, t.weight)
    FROM (
      SELECT s.user_id, SUM(s.weight)::INT AS weight
      FROM public.user_strikes s
      WHERE s.user_id = ANY (p_user_ids)
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      GROUP BY s.user_id
    ) t
  ), '{}'::jsonb);
END;
$$;


-- ─── 4. Write: remove a single strike ────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.admin_revoke_user_strike(
  p_strike_id UUID,
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
  v_strike public.user_strikes;
  v_before JSONB;
  v_state RECORD;
BEGIN
  IF v_actor IS NULL
     OR NOT public.admin_has_permission(v_actor, 'moderation', 'override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation override permission is required to remove strikes.';
  END IF;

  IF coalesce(length(btrim(p_justification)), 0) < 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Justification must be at least 8 characters.';
  END IF;

  IF coalesce(length(btrim(p_ticket_ref)), 0) < 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Ticket reference is required to remove a strike.';
  END IF;

  SELECT * INTO v_strike
  FROM public.user_strikes
  WHERE id = p_strike_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'Strike was not found.';
  END IF;

  IF v_strike.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'That strike has already been removed.';
  END IF;

  v_before := jsonb_build_object(
    'user_id', v_strike.user_id,
    'reason', v_strike.reason,
    'weight', v_strike.weight,
    'created_at', v_strike.created_at,
    'revoked', false
  );

  UPDATE public.user_strikes
  SET revoked_at = now(),
      revoked_by = v_actor,
      revoke_reason = btrim(p_justification)
  WHERE id = p_strike_id
  RETURNING * INTO v_strike;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'override',
    'user_strike',
    p_strike_id::TEXT,
    p_reason_code,
    p_justification,
    v_before,
    jsonb_build_object(
      'user_id', v_strike.user_id,
      'revoked', true,
      'revoked_at', v_strike.revoked_at
    ),
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  SELECT s.kind, s.expires_at INTO v_state
  FROM public.user_suspension_state(v_strike.user_id) s;

  RETURN jsonb_build_object(
    'strike_id', v_strike.id,
    'user_id', v_strike.user_id,
    'removed_weight', v_strike.weight,
    'suspension_kind', v_state.kind,
    'active_weight', public.user_active_strike_weight(v_strike.user_id, INTERVAL '90 days')
  );
END;
$$;


-- ─── 5. Write: remove every strike a user still has ──────────────────────────
-- Targets every row that has not already been revoked, expired ones included,
-- so "remove all" leaves a genuinely clean ledger rather than a mix of revoked
-- and quietly-expired rows.

CREATE OR REPLACE FUNCTION private.admin_clear_user_strikes(
  p_user_id UUID,
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
  v_before_weight INT;
  v_before_kind TEXT;
  v_cleared INT;
  v_state RECORD;
BEGIN
  IF v_actor IS NULL
     OR NOT public.admin_has_permission(v_actor, 'moderation', 'override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation override permission is required to remove strikes.';
  END IF;

  IF coalesce(length(btrim(p_justification)), 0) < 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Justification must be at least 8 characters.';
  END IF;

  IF coalesce(length(btrim(p_ticket_ref)), 0) < 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Ticket reference is required to remove strikes.';
  END IF;

  v_before_weight := public.user_active_strike_weight(p_user_id, INTERVAL '90 days');
  SELECT s.kind INTO v_before_kind FROM public.user_suspension_state(p_user_id) s;

  WITH cleared AS (
    UPDATE public.user_strikes
    SET revoked_at = now(),
        revoked_by = v_actor,
        revoke_reason = btrim(p_justification)
    WHERE user_id = p_user_id
      AND revoked_at IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_cleared FROM cleared;

  IF v_cleared = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'This user has no strikes to remove.';
  END IF;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'override',
    'user_strike_ledger',
    p_user_id::TEXT,
    p_reason_code,
    p_justification,
    jsonb_build_object(
      'active_weight', v_before_weight,
      'suspension_kind', v_before_kind
    ),
    jsonb_build_object(
      'active_weight', 0,
      'suspension_kind', 'none',
      'strikes_removed', v_cleared
    ),
    p_ticket_ref,
    gen_random_uuid(),
    NULL,
    '{}'::jsonb
  );

  SELECT s.kind, s.expires_at INTO v_state
  FROM public.user_suspension_state(p_user_id) s;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'strikes_removed', v_cleared,
    'suspension_kind', v_state.kind,
    'active_weight', public.user_active_strike_weight(p_user_id, INTERVAL '90 days')
  );
END;
$$;


-- ─── 6. Grants on the private bodies ─────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION private.get_admin_user_strikes(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_user_strike_counts(UUID[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_revoke_user_strike(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_clear_user_strikes(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.get_admin_user_strikes(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_user_strike_counts(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_revoke_user_strike(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_clear_user_strikes(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ─── 7. Public SECURITY INVOKER wrappers ─────────────────────────────────────
-- auth.uid() reads the request JWT, not the effective role, so the permission
-- checks inside the bodies see the same caller through the wrapper.

CREATE OR REPLACE FUNCTION public.get_admin_user_strikes(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_user_strikes(p_user_id);
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_user_strikes(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_user_strikes(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION public.get_admin_user_strike_counts(p_user_ids UUID[])
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_user_strike_counts(p_user_ids);
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_user_strike_counts(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_user_strike_counts(UUID[]) TO authenticated;


CREATE OR REPLACE FUNCTION public.admin_revoke_user_strike(
  p_strike_id UUID,
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
  SELECT private.admin_revoke_user_strike(
    p_strike_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_user_strike(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_strike(UUID, TEXT, TEXT, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION public.admin_clear_user_strikes(
  p_user_id UUID,
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
  SELECT private.admin_clear_user_strikes(
    p_user_id, p_reason_code, p_justification, p_ticket_ref
  );
$$;
REVOKE EXECUTE ON FUNCTION public.admin_clear_user_strikes(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_clear_user_strikes(UUID, TEXT, TEXT, TEXT) TO authenticated;


NOTIFY pgrst, 'reload schema';
