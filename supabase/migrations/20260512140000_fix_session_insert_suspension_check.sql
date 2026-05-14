-- =============================================================================
-- Fix "permission denied for table profiles" when creating a session.
--
-- The RESTRICTIVE INSERT policy on `sessions` (from 20260512030000) inlined
-- a SELECT against `profiles.suspended_at`. That column was never added to
-- the column-level GRANT in 20260511050000_hide_public_credits.sql, so the
-- policy fails for every authenticated caller — sessions cannot be created
-- end-to-end.
--
-- Two paths to fix:
--   A. Grant SELECT (suspended_at) to authenticated. Simplest, but leaks the
--      moderation flag for every user.
--   B. Push the lookup behind a SECURITY DEFINER helper that runs as the
--      function owner. The policy calls the helper; the column stays hidden.
--
-- Going with B — keeps the privacy intent of hide_public_credits.sql intact.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_admin_suspended(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user
      AND suspended_at IS NOT NULL
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin_suspended(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_suspended(UUID) TO authenticated;

DROP POLICY IF EXISTS "Suspended users cannot create sessions" ON public.sessions;
CREATE POLICY "Suspended users cannot create sessions" ON public.sessions
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_admin_suspended(auth.uid()));
