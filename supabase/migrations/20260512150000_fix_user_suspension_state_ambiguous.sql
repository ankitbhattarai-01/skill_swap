-- =============================================================================
-- Fix "column reference 'expires_at' is ambiguous" inside user_suspension_state.
--
-- The function declares RETURNS TABLE (kind TEXT, expires_at TIMESTAMPTZ) and
-- also queries `public.user_strikes` which has its own `expires_at` column.
-- The unqualified WHERE clause `expires_at > now()` is ambiguous between the
-- RETURNS-TABLE OUT parameter and the table column — Postgres rejects it the
-- moment the function runs, which here is every session INSERT (via the
-- check_initiator_not_suspended trigger).
--
-- Fix: alias the table and qualify the column.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_suspension_state(p_user UUID)
RETURNS TABLE (kind TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_30d_weight INT;
  v_lifetime_weight INT;
  v_last_strike_at TIMESTAMPTZ;
BEGIN
  SELECT
    COALESCE(SUM(us.weight) FILTER (
      WHERE us.created_at > now() - INTERVAL '30 days'
    ), 0)::int,
    COALESCE(SUM(us.weight), 0)::int,
    MAX(us.created_at)
  INTO v_30d_weight, v_lifetime_weight, v_last_strike_at
  FROM public.user_strikes us
  WHERE us.user_id = p_user
    AND us.revoked_at IS NULL
    AND us.expires_at > now();

  IF v_lifetime_weight >= 8 THEN
    kind := 'permanent';
    expires_at := 'infinity'::TIMESTAMPTZ;
  ELSIF v_30d_weight >= 5 THEN
    kind := 'full';
    expires_at := v_last_strike_at + INTERVAL '30 days';
  ELSIF v_30d_weight >= 3 THEN
    kind := 'teaching_only';
    expires_at := v_last_strike_at + INTERVAL '7 days';
  ELSE
    kind := 'none';
    expires_at := NULL;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.user_suspension_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_suspension_state(UUID) TO authenticated;
