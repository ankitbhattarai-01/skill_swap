-- Restore get_admin_feature_flags to SECURITY DEFINER.
--
-- Why: migration 20260513030000 switched the function to SECURITY INVOKER to
-- silence the security advisor. That made authenticated callers hit every RLS
-- policy on admin_active_settings, including "Active settings read" which
-- calls admin_has_permission(...) inside its USING clause. Migration
-- 20260513080000 then revoked EXECUTE on admin_has_permission from
-- authenticated, so the RLS evaluation now fails with "permission denied for
-- function admin_has_permission" → PostgREST returns 403 for every signed-in
-- caller of get_admin_feature_flags.
--
-- The function body hardcodes the setting_key whitelist, so SECURITY DEFINER
-- cannot leak other rows — the advisor warning is a false positive here.
ALTER FUNCTION public.get_admin_feature_flags() SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
