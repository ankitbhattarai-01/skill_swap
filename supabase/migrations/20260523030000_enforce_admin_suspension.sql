-- =============================================================================
-- Security #5 — Suspended users can still use the platform.
--
-- private.is_admin_suspended() (introduced in 20260513100000) is wired into
-- exactly one place: the RESTRICTIVE INSERT policy on `sessions` that blocks
-- a suspended user from CREATING a new session request. Every other action
-- bypasses the check entirely:
--
--   - accept_session(): a suspended user can still accept incoming requests,
--     escrow learner credits, and pull the counterparty into an active
--     session that they may then leverage to message and call out of band.
--   - complete_session(): a suspended user can still claim escrow credits
--     they already hold against unresolved sessions.
--   - messages INSERT policy: only checks session status + participant,
--     never the sender's suspension flag.
--   - mint-jitsi-token Edge Function: only checks participant + status +
--     join window, so a suspended user can still join the JaaS room.
--
-- This migration enforces is_admin_suspended at three of those four points
-- (the Edge Function patch lives alongside in supabase/functions/
-- mint-jitsi-token/index.ts). cancel_session() is intentionally NOT blocked
-- — a suspended user should still be able to release their counterparty
-- from a pending commitment rather than be forced to no-show.
--
-- All checks call the existing `private.is_admin_suspended(uuid)` helper so
-- the suspension flag stays hidden from anon/authenticated SELECTs (the
-- privacy guarantee from 20260511050000_hide_public_credits.sql).
-- =============================================================================


-- ─── 1. accept_session: refuse suspended actor ───────────────────────────────
--
-- The public wrapper from 20260513190000 is a SQL function that just passes
-- through to private.accept_session. We convert it to plpgsql so it can run
-- the suspension check before delegating. Signature, return type, and
-- search_path are unchanged so callers (client + RLS) keep working.

CREATE OR REPLACE FUNCTION public.accept_session(
  p_session_id UUID,
  p_meet_link TEXT DEFAULT NULL
)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_result public.sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF private.is_admin_suspended(auth.uid()) THEN
    RAISE EXCEPTION 'Your account is suspended and cannot accept sessions.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_result FROM private.accept_session(p_session_id, p_meet_link);
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) TO authenticated;
-- ─── 2. complete_session: refuse suspended actor ─────────────────────────────
--
-- Same conversion as above. Blocks both the "early release" path (learner
-- clicking Complete during accepted/active) and the pending_review-handoff
-- path. A suspended teacher cannot drain escrow; a suspended learner cannot
-- gift-release credits.

CREATE OR REPLACE FUNCTION public.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_result public.sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF private.is_admin_suspended(auth.uid()) THEN
    RAISE EXCEPTION 'Your account is suspended and cannot complete sessions.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_result FROM private.complete_session(p_session_id);
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.complete_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session(UUID) TO authenticated;
-- ─── 3. messages INSERT policy: block suspended senders ──────────────────────
--
-- Rebuild the permissive policy from 20260511020000 with an added
-- suspension guard. We keep the existing sender/session/status checks
-- unchanged so the only behavioural change is "suspended account cannot
-- send messages".

DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND NOT private.is_admin_suspended(auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- ─── 4. is_suspended_self: thin helper for the Edge Function ─────────────────
--
-- mint-jitsi-token already calls SECURITY DEFINER RPCs as the user's JWT;
-- it needs a way to ask "am I suspended?" without granting it access to
-- the underlying column or to the private schema directly. This wraps
-- private.is_admin_suspended(auth.uid()) so the function key in the Edge
-- Function (the user's session token, NOT service role) can call it.

CREATE OR REPLACE FUNCTION public.is_suspended_self()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT COALESCE(private.is_admin_suspended(auth.uid()), false);
$$;
REVOKE EXECUTE ON FUNCTION public.is_suspended_self() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_suspended_self() TO authenticated;
