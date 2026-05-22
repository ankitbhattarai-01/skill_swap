-- =============================================================================
-- Fix: user_suspension_state() kept reporting 'teaching_only' / 'full' even
-- after the per-tier pause window had already elapsed.
--
-- The original logic only checked the strike count in the 30-day window and
-- always returned the tier label with last_strike + 7d (or +30d). If the
-- user accumulated 3 strikes 9 days ago, the 7-day teaching pause is over,
-- but the strikes are still inside the 30-day window so the function kept
-- reporting `teaching_only` with a past expiry timestamp. The UI then shows
-- "Teaching paused until <past date>" indefinitely until the strikes age out.
--
-- Once `now() >= expires_at` for a tier, the suspension is over even if the
-- strikes themselves are still active (they still count toward future
-- escalation, but no current restriction applies).
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
  v_full_expires TIMESTAMPTZ;
  v_teaching_expires TIMESTAMPTZ;
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
  ELSIF v_30d_weight >= 5 AND (v_last_strike_at + INTERVAL '30 days') > now() THEN
    kind := 'full';
    expires_at := v_last_strike_at + INTERVAL '30 days';
  ELSIF v_30d_weight >= 3 AND (v_last_strike_at + INTERVAL '7 days') > now() THEN
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
