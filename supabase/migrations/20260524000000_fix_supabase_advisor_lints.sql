-- Resolve two warnings flagged by the Supabase advisors.
--
-- 1. auth_rls_initplan on public.ai_suggestions / ai_suggestions_delete_own:
--    the DELETE policy added in 20260521000000 calls auth.uid() directly, so
--    PostgreSQL re-evaluates it for every candidate row. Wrap the call in a
--    SELECT initplan so it runs once per statement, matching the pattern
--    established in 20260514000000_fix_rls_performance_lints.sql.
--
-- 2. authenticated_security_definer_function_executable on
--    public.user_suspension_state(uuid): 20260513040000 revoked execute from
--    authenticated because the function is only called from other vetted
--    SECURITY DEFINER routines (user_strikes_and_penalties.sql,
--    learning_tracks.sql). The 20260522010000 rewrite reintroduced
--    `GRANT EXECUTE ... TO authenticated`, re-exposing the RPC. Revoke it
--    again so signed-in clients cannot hit /rest/v1/rpc/user_suspension_state.

ALTER POLICY ai_suggestions_delete_own ON public.ai_suggestions
  USING ((select auth.uid()) = user_id);

REVOKE EXECUTE ON FUNCTION public.user_suspension_state(UUID) FROM authenticated;

NOTIFY pgrst, 'reload schema';
