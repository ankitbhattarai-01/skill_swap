-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- These privileged admin action RPCs are not called by the current frontend or
-- Edge Functions. Keep them available for owner/service-side SQL use, but do
-- not expose them as directly callable PostgREST RPCs to every signed-in user.
DO $$
DECLARE
  v_signature TEXT;
  v_function REGPROCEDURE;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.admin_issue_strike(uuid, integer, text, text, uuid, uuid)',
    'public.admin_resolve_dispute(uuid, text, text)',
    'public.admin_revoke_strike(uuid, text)'
  ]
  LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
