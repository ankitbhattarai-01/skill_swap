-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- Keep these admin read APIs callable at the same public RPC names, but move
-- the privileged implementations to a non-exposed schema. The public functions
-- become SECURITY INVOKER wrappers, so they no longer appear as public
-- SECURITY DEFINER RPCs.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.get_admin_console_snapshot() SET SCHEMA private;
ALTER FUNCTION public.get_admin_security_dashboard() SET SCHEMA private;
ALTER FUNCTION public.get_admin_skills_catalog() SET SCHEMA private;
ALTER FUNCTION public.get_admin_system_health() SET SCHEMA private;
ALTER FUNCTION public.get_admin_users(INT, TEXT) SET SCHEMA private;

REVOKE EXECUTE ON FUNCTION private.get_admin_console_snapshot() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_security_dashboard() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_skills_catalog() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_system_health() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_admin_users(INT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.get_admin_console_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_security_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_skills_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_system_health() TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_admin_users(INT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_console_snapshot()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_console_snapshot();
$$;

CREATE OR REPLACE FUNCTION public.get_admin_security_dashboard()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_security_dashboard();
$$;

CREATE OR REPLACE FUNCTION public.get_admin_skills_catalog()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_skills_catalog();
$$;

CREATE OR REPLACE FUNCTION public.get_admin_system_health()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_system_health();
$$;

CREATE OR REPLACE FUNCTION public.get_admin_users(
  p_limit INT DEFAULT 50,
  p_search TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.get_admin_users(p_limit, p_search);
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_console_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_security_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_skills_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_system_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_admin_console_snapshot() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_security_dashboard() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_skills_catalog() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_system_health() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) FROM anon;

NOTIFY pgrst, 'reload schema';
