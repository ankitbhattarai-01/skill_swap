-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- These functions are internal helpers or service/scheduled workflows. They
-- are called by other vetted SECURITY DEFINER RPCs, policies, or service-role
-- jobs, so signed-in clients do not need direct PostgREST execute access.
DO $$
DECLARE
  v_signature TEXT;
  v_function REGPROCEDURE;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.auto_settle_session(uuid)',
    'public.has_any_intersection(uuid, uuid, integer, integer)',
    'public.rls_auto_enable()',
    'public.session_attended_seconds(uuid, uuid)',
    'public.user_active_strike_weight(uuid, interval)',
    'public.user_suspension_state(uuid)'
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
