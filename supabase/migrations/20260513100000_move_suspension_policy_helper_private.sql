-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- is_admin_suspended is a policy helper, not a public API RPC. Move it out of
-- the exposed public schema while keeping the sessions INSERT policy working.
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.is_admin_suspended(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = p_user
      AND suspended_at IS NOT NULL
  );
$$;

GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_admin_suspended(UUID) TO authenticated;

DROP POLICY IF EXISTS "Suspended users cannot create sessions" ON public.sessions;
CREATE POLICY "Suspended users cannot create sessions" ON public.sessions
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (NOT private.is_admin_suspended(auth.uid()));

DO $$
BEGIN
  IF to_regprocedure('public.is_admin_suspended(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.is_admin_suspended(UUID) FROM PUBLIC, anon, authenticated;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.is_admin_suspended(UUID);

NOTIFY pgrst, 'reload schema';
