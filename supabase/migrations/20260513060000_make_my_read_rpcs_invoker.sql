-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- These read-only "my data" RPCs do not need creator privileges. Their base
-- tables already have participant/self RLS policies, so make the functions run
-- as the caller and grant only SELECT on the protected tables they read.

GRANT SELECT ON public.user_availability TO authenticated;
ALTER FUNCTION public.get_my_availability(TEXT) SECURITY INVOKER;

GRANT SELECT ON public.learning_tracks TO authenticated;
GRANT SELECT ON public.track_planned_sessions TO authenticated;
ALTER FUNCTION public.get_my_tracks() SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';
