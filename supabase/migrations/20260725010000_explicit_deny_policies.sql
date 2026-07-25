-- =============================================================================
-- Supabase security advisor 0008 — "RLS Enabled No Policy" (INFO).
--
-- Two tables are flagged: public.session_email_deliveries and
-- public.skill_verification_questions. In both cases the empty policy list is
-- the intended design, not an oversight:
--
--   * session_email_deliveries holds recipients' email addresses and the
--     dispatch outcome for every notification email. 20260611120000 enabled RLS
--     and revoked ALL from PUBLIC/anon/authenticated. Only send-session-email
--     reads or writes it, using SUPABASE_SERVICE_ROLE_KEY.
--
--   * skill_verification_questions holds correct_index — the quiz answer key —
--     and, since 20260720000000, chosen_index. 20260719000000 split it out of
--     skill_verification_attempts for exactly this reason: RLS is row-level,
--     not column-level, so a user who can read their own attempt row would also
--     read the answers if the key lived there. Only verify-skill grades against
--     it, again with the service-role key.
--
-- The linter cannot distinguish a deliberate deny-all from a forgotten policy;
-- it only counts rows in pg_policy for a table with relrowsecurity set. So make
-- the intent explicit and give it something to count.
--
-- Why this cannot break anything:
--
--   1. Both policies are PERMISSIVE with USING (false) / WITH CHECK (false).
--      A permissive policy that never matches a row leaves the effective
--      outcome identical to having no policy at all — deny. It grants nothing;
--      RLS policies can only ever narrow what a table grant already allows, and
--      here the grants are revoked anyway.
--
--   2. They are scoped `TO anon, authenticated`, so they are not even evaluated
--      for any other role. service_role has BYPASSRLS in Supabase, meaning RLS
--      is skipped for it regardless — both Edge Functions keep working
--      untouched, as does anything run from the SQL editor as postgres.
--
--   3. PERMISSIVE, not RESTRICTIVE, on purpose. A restrictive USING (false)
--      would silently veto any future read policy someone adds to these tables
--      and be miserable to debug. Permissive means a later policy would simply
--      OR alongside this one and work as written.
--
-- Net effect on the running site: none. This is a documentation change that the
-- advisor happens to be able to read.
-- =============================================================================

-- ─── 1. session_email_deliveries ─────────────────────────────────────────────

DROP POLICY IF EXISTS "Delivery log is service-role only"
  ON public.session_email_deliveries;

CREATE POLICY "Delivery log is service-role only"
  ON public.session_email_deliveries
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Re-assert the grant state the policy is documenting, in case a later
-- CREATE TABLE ... or a dashboard action re-granted the defaults. Idempotent.
ALTER TABLE public.session_email_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_email_deliveries FROM PUBLIC, anon, authenticated;


-- ─── 2. skill_verification_questions ─────────────────────────────────────────

DROP POLICY IF EXISTS "Answer key is service-role only"
  ON public.skill_verification_questions;

CREATE POLICY "Answer key is service-role only"
  ON public.skill_verification_questions
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.skill_verification_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.skill_verification_questions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.skill_verification_questions TO service_role;
