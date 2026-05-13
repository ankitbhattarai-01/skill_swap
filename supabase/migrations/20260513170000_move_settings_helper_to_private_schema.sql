-- Silence authenticated_security_definer_function_executable on
-- current_user_can_read_admin_settings.
--
-- The helper has to stay SECURITY DEFINER: it is called from the
-- "Active settings read" RLS policy, and admin_has_permission is revoked
-- from authenticated, so an INVOKER variant would 403 the policy.
--
-- Fix per the advisor remediation ("...or move it out of your exposed API
-- schema..."): relocate the helper to a `private` schema that PostgREST
-- does not expose. RLS still resolves it via the qualified name.

CREATE SCHEMA IF NOT EXISTS private;

-- Authenticated users need USAGE on the schema for the RLS policy
-- evaluation to reach the function. anon does not — the policy is
-- TO authenticated only.
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.current_user_can_read_admin_settings()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    public.admin_has_permission(auth.uid(), 'settings', 'read'),
    false
  );
$$;

REVOKE EXECUTE ON FUNCTION private.current_user_can_read_admin_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_user_can_read_admin_settings() TO authenticated;

-- Repoint the RLS policy at the relocated helper.
DROP POLICY IF EXISTS "Active settings read" ON public.admin_active_settings;
CREATE POLICY "Active settings read" ON public.admin_active_settings
  FOR SELECT TO authenticated
  USING (private.current_user_can_read_admin_settings());

-- Drop the now-unused public copy so PostgREST stops exposing it as an RPC.
DROP FUNCTION IF EXISTS public.current_user_can_read_admin_settings();

NOTIFY pgrst, 'reload schema';
