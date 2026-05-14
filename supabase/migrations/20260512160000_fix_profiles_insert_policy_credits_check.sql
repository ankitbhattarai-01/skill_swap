-- =============================================================================
-- Drop the `credits = 10` reference from the profiles INSERT policy.
--
-- 20260510000000 already noted this hazard for is_admin: "RLS expressions
-- evaluate with the invoker's column privileges". It dropped is_admin = false
-- but kept credits = 10. That was fine at the time because credits SELECT was
-- still granted to authenticated. Then 20260511050000_hide_public_credits.sql
-- revoked SELECT on credits — and the INSERT policy's `credits = 10` clause
-- silently became unenforceable, causing every profile INSERT/UPSERT from a
-- regular client to error with "permission denied for table profiles".
--
-- The check is also redundant: the column-level INSERT GRANT excludes
-- `credits`, so a client can't set it; the column DEFAULT is 10, so the
-- starting balance is fixed by schema. No client write path can ever land
-- a row with credits != 10.
-- =============================================================================

DROP POLICY IF EXISTS "Users insert their own profile" ON public.profiles;
CREATE POLICY "Users insert their own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);
