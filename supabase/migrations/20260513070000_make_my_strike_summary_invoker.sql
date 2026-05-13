-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- my_strike_summary only reports the caller's own strike/suspension state.
-- Let it run under caller RLS and compute directly from user_strikes, whose
-- policy already limits authenticated reads to user_id = auth.uid().
GRANT SELECT ON public.user_strikes TO authenticated;

CREATE OR REPLACE FUNCTION public.my_strike_summary()
RETURNS TABLE (
  kind TEXT,
  suspension_expires_at TIMESTAMPTZ,
  active_strike_weight INT,
  next_strike_expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH active AS (
    SELECT
      weight,
      created_at,
      expires_at
    FROM public.user_strikes
    WHERE user_id = auth.uid()
      AND revoked_at IS NULL
      AND expires_at > now()
  ),
  rollup AS (
    SELECT
      COALESCE(SUM(weight) FILTER (
        WHERE created_at > now() - INTERVAL '30 days'
      ), 0)::int AS weight_30d,
      COALESCE(SUM(weight), 0)::int AS weight_90d,
      MAX(created_at) AS last_strike_at,
      MIN(expires_at) AS next_expires_at
    FROM active
  )
  SELECT
    CASE
      WHEN weight_90d >= 8 THEN 'permanent'
      WHEN weight_30d >= 5 THEN 'full'
      WHEN weight_30d >= 3 THEN 'teaching_only'
      ELSE 'none'
    END AS kind,
    CASE
      WHEN weight_90d >= 8 THEN 'infinity'::timestamptz
      WHEN weight_30d >= 5 THEN last_strike_at + INTERVAL '30 days'
      WHEN weight_30d >= 3 THEN last_strike_at + INTERVAL '7 days'
      ELSE NULL::timestamptz
    END AS suspension_expires_at,
    weight_90d AS active_strike_weight,
    next_expires_at AS next_strike_expires_at
  FROM rollup;
$$;

REVOKE EXECUTE ON FUNCTION public.my_strike_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_strike_summary() TO authenticated;

NOTIFY pgrst, 'reload schema';
