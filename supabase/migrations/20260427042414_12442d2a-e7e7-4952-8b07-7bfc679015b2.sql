-- Fix function search paths
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- Lock down SECURITY DEFINER function execute
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- Tighten the always-true authenticated insert on skills (still authenticated-only, but explicit user check)
DROP POLICY IF EXISTS "Authenticated can add skills" ON public.skills;
CREATE POLICY "Authenticated can add skills" ON public.skills
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);
