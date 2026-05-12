-- Let unauthenticated visitors read the whitelisted feature flag bundle so
-- public surfaces (e.g. /explore) can honour features.public_explore.enabled
-- without requiring a logged-in session.
--
-- The RPC is read-only and returns only the explicit allow-list of keys, so
-- there is no risk of exposing other admin_active_settings rows.

GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO anon;
