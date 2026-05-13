-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- set_my_availability only replaces the caller's own availability windows.
-- Move that ownership rule into RLS and run the RPC as the caller.
GRANT SELECT, INSERT, DELETE ON public.user_availability TO authenticated;
GRANT UPDATE (availability_tz) ON public.profiles TO authenticated;

DROP POLICY IF EXISTS "Users insert own availability" ON public.user_availability;
CREATE POLICY "Users insert own availability" ON public.user_availability
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users delete own availability" ON public.user_availability;
CREATE POLICY "Users delete own availability" ON public.user_availability
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

ALTER FUNCTION public.set_my_availability(TEXT, JSONB, TEXT) SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';
