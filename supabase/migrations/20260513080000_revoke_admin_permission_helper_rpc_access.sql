-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- admin_has_permission is an internal helper used by RLS policies and other
-- SECURITY DEFINER admin RPCs. The frontend does not call it directly, so it
-- should not be exposed as a PostgREST RPC to every signed-in user.
REVOKE EXECUTE ON FUNCTION public.admin_has_permission(UUID, TEXT, TEXT, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
