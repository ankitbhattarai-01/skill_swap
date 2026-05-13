-- Supabase security advisor: Public Can Execute SECURITY DEFINER Function.
--
-- Feature flags are intentionally public, but they do not need definer
-- privileges. Let anon read only the whitelisted setting keys/values that the
-- RPC returns, then run the function as the caller.
DROP POLICY IF EXISTS "Public feature flags read" ON public.admin_active_settings;
CREATE POLICY "Public feature flags read" ON public.admin_active_settings
  FOR SELECT TO anon, authenticated
  USING (
    setting_key IN (
      'features.ai_suggestions.enabled',
      'features.video_calls.enabled',
      'features.public_explore.enabled',
      'signup.starting_credits',
      'sessions.default_credits_per_hour'
    )
  );

GRANT SELECT (setting_key, current_value) ON public.admin_active_settings TO anon;

ALTER FUNCTION public.get_admin_feature_flags() SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO anon, authenticated;

-- Admin checks are useful to signed-in clients and RLS policies, but anonymous
-- callers should not be able to invoke the definer function through PostgREST.
REVOKE EXECUTE ON FUNCTION public.is_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin(UUID) TO authenticated;

-- This helper is not part of the local migrations. Guard the revoke so SQL
-- editor rollouts succeed whether or not the hosted database has it.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
