-- Stop exposing every user's credit balance to anon/authenticated.
--
-- Before: the column-level GRANT on public.profiles included `credits`, so
-- any visitor could scrape balances across the whole user base (SEC-005 in
-- the audit). The credits column also leaked through the public user page
-- as a "{n} credits" badge.
--
-- After: `credits` is no longer in the public GRANT list. Users see their
-- own balance via a SECURITY DEFINER RPC, my_credit_balance(), which only
-- ever returns the caller's row. Everywhere else (other users' profiles,
-- explore cards, etc.) simply doesn't ask for the column anymore.

-- Re-issue the public GRANT without credits. The non-credit column list is
-- otherwise identical to migration 20260510000000.
REVOKE SELECT ON public.profiles FROM anon, authenticated;
GRANT SELECT (
  id,
  full_name,
  bio,
  avatar_url,
  learning_mode,
  onboarded,
  created_at,
  updated_at
) ON public.profiles TO anon, authenticated;
-- Service role keeps full access for Edge Functions / sweepers.
GRANT SELECT ON public.profiles TO service_role;
-- Self-balance RPC. SECURITY DEFINER so the function owner reads the
-- credits column even though authenticated cannot. Always keyed to
-- auth.uid() — there is no way to ask after someone else's balance.
CREATE OR REPLACE FUNCTION public.my_credit_balance()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT credits FROM public.profiles WHERE id = auth.uid()),
    0
  );
$$;
REVOKE EXECUTE ON FUNCTION public.my_credit_balance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_credit_balance() TO authenticated;
