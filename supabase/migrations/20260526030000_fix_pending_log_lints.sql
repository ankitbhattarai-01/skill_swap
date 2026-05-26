-- Resolve three warnings flagged by the Supabase advisors for the
-- pending-message-cap subsystem added in 20260526020000.
--
-- 1+2. anon/authenticated_security_definer_function_executable on
--      public.my_pending_message_quota(): the quota RPC was declared
--      SECURITY DEFINER so it could read pending_message_send_log, which
--      had every privilege revoked. That makes the function trip the
--      advisor twice (anon + authenticated can hit it as definer).
--      Switch the function to SECURITY INVOKER now that we grant the
--      caller direct SELECT on the log table via the RLS policy below.
--
-- 3.   rls_enabled_no_policy on public.pending_message_send_log: RLS
--      was enabled but no policies existed, so signed-in users could
--      not read their own rows. Add a self-read policy and grant
--      SELECT to authenticated. INSERTs continue to be performed only
--      by the SECURITY DEFINER trigger (enforce_pending_message_caps),
--      which bypasses RLS as table owner — no insert policy needed.

CREATE POLICY "Own pending send log rows" ON public.pending_message_send_log
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = sender_id);

GRANT SELECT ON public.pending_message_send_log TO authenticated;

CREATE OR REPLACE FUNCTION public.my_pending_message_quota()
RETURNS TABLE(used int, daily_limit int, reset_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((
      SELECT COUNT(*)::int
      FROM public.pending_message_send_log
      WHERE sender_id = (select auth.uid())
        AND created_at >= date_trunc('day', timezone('UTC', now()))
    ), 0) AS used,
    15 AS daily_limit,
    (date_trunc('day', timezone('UTC', now())) + INTERVAL '1 day') AS reset_at;
$$;

REVOKE EXECUTE ON FUNCTION public.my_pending_message_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pending_message_quota() TO authenticated;

NOTIFY pgrst, 'reload schema';
