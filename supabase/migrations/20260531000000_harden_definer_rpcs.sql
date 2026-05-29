-- =============================================================================
-- Supabase advisor 0029 — "Signed-In Users Can Execute SECURITY DEFINER
-- Function" for public.is_suspended_self() and
-- public.get_or_create_conversation(uuid).
--
-- Both are reachable via /rest/v1/rpc by the `authenticated` role, which is
-- intentional, but neither needs to stay SECURITY DEFINER *in the exposed
-- public schema*. We clear the warning the same way 20260513100000 +
-- 20260523030000 handled the suspension helpers:
--
--   1. is_suspended_self: it only READS (through private.is_admin_suspended,
--      which is itself SECURITY DEFINER). authenticated already has USAGE on
--      private + EXECUTE on that helper, so flipping the public RPC to
--      SECURITY INVOKER keeps the suspended_at column hidden and breaks
--      nothing — the edge function still calls it under the user's JWT.
--
--   2. get_or_create_conversation: it INSERTs into public.conversations, where
--      authenticated holds only SELECT, so it genuinely needs definer rights.
--      Move the body into private.get_or_create_conversation (the private
--      schema is NOT exposed via PostgREST, so the advisor does not flag it)
--      and expose a thin public SECURITY INVOKER wrapper. Mirrors the
--      accept_session / complete_session pattern. The client RPC name and
--      signature are unchanged.
-- =============================================================================


-- ─── 1. is_suspended_self: SECURITY DEFINER → SECURITY INVOKER ────────────────
CREATE OR REPLACE FUNCTION public.is_suspended_self()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT COALESCE(private.is_admin_suspended(auth.uid()), false);
$$;
REVOKE EXECUTE ON FUNCTION public.is_suspended_self() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_suspended_self() TO authenticated;


-- ─── 2a. private.get_or_create_conversation: the definer body, off the API ────
CREATE OR REPLACE FUNCTION private.get_or_create_conversation(other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := (select auth.uid());
  v_low uuid;
  v_high uuid;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'P0001';
  END IF;
  IF other_user IS NULL OR other_user = v_me THEN
    RAISE EXCEPTION 'A conversation needs a different participant.' USING ERRCODE = 'P0001';
  END IF;

  IF v_me < other_user THEN
    v_low := v_me; v_high := other_user;
  ELSE
    v_low := other_user; v_high := v_me;
  END IF;

  SELECT id INTO v_id FROM public.conversations
   WHERE user_low = v_low AND user_high = v_high;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.conversations (user_low, user_high)
  VALUES (v_low, v_high)
  ON CONFLICT (user_low, user_high) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.conversations
     WHERE user_low = v_low AND user_high = v_high;
  END IF;

  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.get_or_create_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_or_create_conversation(uuid) TO authenticated;


-- ─── 2b. public.get_or_create_conversation: thin SECURITY INVOKER wrapper ─────
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.get_or_create_conversation(other_user);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) TO authenticated;


NOTIFY pgrst, 'reload schema';
