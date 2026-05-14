-- Silence the Supabase advisor lints
--   - anon_security_definer_function_executable (0028)
--   - authenticated_security_definer_function_executable (0029)
-- for public.get_admin_feature_flags() without re-breaking signed-in reads.
--
-- Background: migration 20260513030000 originally switched the RPC to
-- SECURITY INVOKER, which made authenticated callers hit "Active settings
-- read" RLS on admin_active_settings. That policy calls
-- admin_has_permission(...), and migration 20260513080000 revoked EXECUTE on
-- admin_has_permission from authenticated → RLS evaluation failed with 403.
-- We had to temporarily restore SECURITY DEFINER (20260513150000), which
-- re-triggered the advisor lints.
--
-- Proper fix: keep authenticated locked OUT of admin_has_permission (good
-- hardening from 20260513080000), but wrap the settings-read check in a
-- SECURITY DEFINER helper that authenticated CAN execute. The wrapper takes
-- no arguments and only resolves admin_has_permission for the calling user,
-- so it cannot be used to probe permissions on arbitrary users.

CREATE OR REPLACE FUNCTION public.current_user_can_read_admin_settings()
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

REVOKE EXECUTE ON FUNCTION public.current_user_can_read_admin_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_read_admin_settings() TO authenticated;

-- Rewrite "Active settings read" so RLS no longer dereferences
-- admin_has_permission directly. The wrapper runs as definer and can call
-- admin_has_permission even though the invoker can't.
DROP POLICY IF EXISTS "Active settings read" ON public.admin_active_settings;
CREATE POLICY "Active settings read" ON public.admin_active_settings
  FOR SELECT TO authenticated
  USING (public.current_user_can_read_admin_settings());

-- Now it is safe to flip get_admin_feature_flags back to SECURITY INVOKER.
-- Whitelisted rows are still reachable via the "Public feature flags read"
-- policy (added in 20260513030000) for both anon and authenticated.
ALTER FUNCTION public.get_admin_feature_flags() SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO anon, authenticated;

-- anon needs column-level SELECT to actually return rows under INVOKER
-- semantics. Reasserted from 20260513030000 so this migration stands alone
-- if applied in isolation.
GRANT SELECT (setting_key, current_value) ON public.admin_active_settings TO anon;

NOTIFY pgrst, 'reload schema';
