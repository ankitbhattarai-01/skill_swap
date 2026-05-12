-- Stop admin-enumeration via is_admin(uuid).
--
-- Before: is_admin(p_user) accepted any UUID, letting an authenticated user
-- iterate over every public profile id and discover who is staff (SEC-001 in
-- the audit). The function still needs to be callable by RLS policies, which
-- pass auth.uid() through it, so we cannot just revoke EXECUTE.
--
-- After: the function ignores its argument unless it matches the caller's
-- auth.uid(). The service role (auth.uid() IS NULL) keeps full access so
-- maintenance jobs and the protect_admin_flag trigger still work.

CREATE OR REPLACE FUNCTION public.is_admin(p_user uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = p_user
      AND is_admin = true
      AND (auth.uid() IS NULL OR auth.uid() = p_user)
  );
$$;
