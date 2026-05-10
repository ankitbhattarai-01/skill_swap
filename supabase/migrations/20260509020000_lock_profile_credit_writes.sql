-- Lock ledger/admin-owned profile columns away from direct client writes.
--
-- RLS can decide which rows a user may update, but it cannot limit which
-- columns are changed. The original self-profile policy therefore let any
-- authenticated user PATCH their own `credits` balance. Use column privileges
-- to keep normal profile editing while reserving credits/admin fields for
-- trusted database code and service-role maintenance.

REVOKE INSERT, UPDATE ON public.profiles FROM anon, authenticated;
GRANT INSERT (
  id,
  full_name,
  bio,
  avatar_url,
  learning_mode,
  onboarded
) ON public.profiles TO authenticated;
GRANT UPDATE (
  full_name,
  bio,
  avatar_url,
  learning_mode,
  onboarded
) ON public.profiles TO authenticated;
DROP POLICY IF EXISTS "Users insert their own profile" ON public.profiles;
CREATE POLICY "Users insert their own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = id
    AND credits = 10
    AND is_admin = false
  );
DROP POLICY IF EXISTS "Users update their own profile" ON public.profiles;
CREATE POLICY "Users update their own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
