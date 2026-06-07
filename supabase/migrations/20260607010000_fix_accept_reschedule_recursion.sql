-- =============================================================================
-- Fix the reschedule workflow end-to-end.
--
-- Two user-visible failures, one root cause:
--   * "Accept new time"  → "infinite recursion detected in policy for
--                           relation sessions"
--   * "Send proposal"    → "Session not found"
--
-- Root cause: 20260513090000 + 20260513130000 flipped the reschedule RPCs
-- (propose / accept / reject / withdraw) from SECURITY DEFINER to SECURITY
-- INVOKER and pushed their ownership rules into RLS. That made every RPC's
-- internal `SELECT ... FROM sessions FOR UPDATE` / `UPDATE sessions` depend on
-- RLS evaluated as the caller, which is brittle:
--   - accept's `UPDATE sessions` evaluated the sessions UPDATE policy, whose
--     WITH CHECK read reschedule_proposals, whose SELECT policy read sessions
--     → recursion.
--   - propose's `SELECT ... FOR UPDATE` on sessions came back empty under the
--     caller's row-locking RLS path → "Session not found".
--
-- These are participant-scoped workflow writes that legitimately need to touch
-- the locked session row. The right home for them is the same private-schema
-- DEFINER pattern already used for accept_session / complete_session /
-- get_or_create_conversation (20260531000000): the DEFINER body lives in the
-- `private` schema (not exposed via PostgREST, so advisor 0029 stays clear) and
-- each public RPC is a thin SECURITY INVOKER wrapper. As DEFINER, the bodies run
-- as the table owner and bypass RLS entirely — no policy is evaluated, so no
-- recursion and no row-locking visibility gaps. Client RPC names/signatures are
-- unchanged.
--
-- With every write going through a DEFINER again, the cross-referencing RLS
-- policies that caused the trouble are no longer needed. We:
--   - revert the sessions UPDATE policy to teacher-edits-pending-only (this also
--     restores the H2 lock: an accepted session's time can only move via
--     accept_reschedule, never a direct client UPDATE),
--   - drop the reschedule_proposals write policies and revoke client
--     INSERT/UPDATE, returning to "writes are RPC-only" (the original
--     20260512090000 design). SELECT stays so the client can still read
--     proposals for the session.
--
-- Idempotent: safe to run on a database that already has any subset applied.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;


-- ─── 1. propose_reschedule ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.propose_reschedule(
  p_session_id UUID,
  p_new_scheduled_at TIMESTAMPTZ,
  p_note TEXT DEFAULT NULL
)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions;
  v_caller  UUID := auth.uid();
  v_row     public.reschedule_proposals;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_caller IS NULL
     OR (v_caller <> v_session.learner_id AND v_caller <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Only accepted sessions can be rescheduled';
  END IF;

  IF p_new_scheduled_at <= now() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Proposed time must be in the future';
  END IF;
  IF p_new_scheduled_at > now() + INTERVAL '1 year' THEN
    RAISE EXCEPTION 'Proposed time is too far in the future';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reschedule_proposals
    WHERE session_id = p_session_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Another reschedule proposal is already pending on this session';
  END IF;

  INSERT INTO public.reschedule_proposals (
    session_id, proposer_id, old_scheduled_at, new_scheduled_at, note
  ) VALUES (
    p_session_id, v_caller, v_session.scheduled_at, p_new_scheduled_at,
    NULLIF(btrim(COALESCE(p_note, '')), '')
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.propose_reschedule(
  p_session_id UUID,
  p_new_scheduled_at TIMESTAMPTZ,
  p_note TEXT DEFAULT NULL
)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.propose_reschedule(p_session_id, p_new_scheduled_at, p_note);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) TO authenticated;


-- ─── 2. accept_reschedule ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.accept_reschedule(p_proposal_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_proposal public.reschedule_proposals;
  v_session  public.sessions;
  v_caller   UUID := auth.uid();
BEGIN
  SELECT * INTO v_proposal
  FROM public.reschedule_proposals
  WHERE id = p_proposal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal not found';
  END IF;

  IF v_proposal.status <> 'pending' THEN
    RAISE EXCEPTION 'Proposal is not pending (status: %)', v_proposal.status;
  END IF;

  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = v_proposal.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_caller IS NULL
     OR (v_caller <> v_session.learner_id AND v_caller <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_caller = v_proposal.proposer_id THEN
    RAISE EXCEPTION 'You proposed this reschedule — wait for the other party to accept';
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Session is no longer reschedulable (status: %)', v_session.status;
  END IF;

  IF v_proposal.new_scheduled_at <= now() - INTERVAL '5 minutes' THEN
    UPDATE public.reschedule_proposals
    SET status = 'expired', responder_id = v_caller, responded_at = now()
    WHERE id = p_proposal_id;
    RAISE EXCEPTION 'Proposed time has passed. The proposal has been auto-expired.';
  END IF;

  UPDATE public.sessions
  SET scheduled_at = v_proposal.new_scheduled_at
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.reschedule_proposals
  SET status = 'accepted', responder_id = v_caller, responded_at = now()
  WHERE id = p_proposal_id;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.accept_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.accept_reschedule(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_reschedule(p_proposal_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.accept_reschedule(p_proposal_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(UUID) TO authenticated;


-- ─── 3. reject_reschedule ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.reject_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_proposal public.reschedule_proposals;
  v_session  public.sessions;
  v_caller   UUID := auth.uid();
BEGIN
  SELECT * INTO v_proposal
  FROM public.reschedule_proposals
  WHERE id = p_proposal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal not found';
  END IF;

  IF v_proposal.status <> 'pending' THEN
    RAISE EXCEPTION 'Proposal is not pending';
  END IF;

  SELECT * INTO v_session FROM public.sessions WHERE id = v_proposal.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_caller IS NULL
     OR (v_caller <> v_session.learner_id AND v_caller <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF v_caller = v_proposal.proposer_id THEN
    RAISE EXCEPTION 'You proposed this — use withdraw_reschedule to take it back';
  END IF;

  UPDATE public.reschedule_proposals
  SET status = 'rejected', responder_id = v_caller, responded_at = now()
  WHERE id = p_proposal_id
  RETURNING * INTO v_proposal;

  RETURN v_proposal;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.reject_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.reject_reschedule(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.reject_reschedule(p_proposal_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_reschedule(UUID) TO authenticated;


-- ─── 4. withdraw_reschedule ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.withdraw_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_proposal public.reschedule_proposals;
  v_caller   UUID := auth.uid();
BEGIN
  SELECT * INTO v_proposal
  FROM public.reschedule_proposals
  WHERE id = p_proposal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal not found';
  END IF;
  IF v_proposal.status <> 'pending' THEN
    RAISE EXCEPTION 'Proposal is not pending';
  END IF;
  IF v_caller IS NULL OR v_caller <> v_proposal.proposer_id THEN
    RAISE EXCEPTION 'Only the proposer can withdraw';
  END IF;

  UPDATE public.reschedule_proposals
  SET status = 'withdrawn', responder_id = v_caller, responded_at = now()
  WHERE id = p_proposal_id
  RETURNING * INTO v_proposal;

  RETURN v_proposal;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.withdraw_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.withdraw_reschedule(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.withdraw_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.withdraw_reschedule(p_proposal_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.withdraw_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_reschedule(UUID) TO authenticated;


-- ─── 5. Revert the sessions UPDATE policy to teacher-edits-pending-only ───────
--
-- The reschedule branch (status accepted/active + reschedule_proposals EXISTS)
-- existed only to let the invoker-based accept_reschedule run, and was the
-- sessions→reschedule_proposals half of the recursion cycle. With the writes
-- back on DEFINERs, drop it. The teacher's initial pending-session scheduling
-- (the schedule editor on the session page) still works through this policy.
DROP POLICY IF EXISTS "Participants update schedulable sessions" ON public.sessions;
DROP POLICY IF EXISTS "Teachers schedule pending sessions" ON public.sessions;
CREATE POLICY "Teachers schedule pending sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    (select auth.uid()) = teacher_id
    AND status = 'pending'
  )
  WITH CHECK (
    (select auth.uid()) = teacher_id
    AND status = 'pending'
  );


-- ─── 6. Reschedule proposals: writes are RPC-only again ───────────────────────
--
-- All four RPCs now write through DEFINER bodies, so authenticated clients no
-- longer need direct INSERT/UPDATE. Drop the write policies and revoke the
-- grants. Keep SELECT (+ its policy) so the client can read proposals.
DROP POLICY IF EXISTS "Participants propose reschedules" ON public.reschedule_proposals;
DROP POLICY IF EXISTS "Counterparty accepts pending reschedules" ON public.reschedule_proposals;
DROP POLICY IF EXISTS "Counterparty rejects pending reschedules" ON public.reschedule_proposals;
DROP POLICY IF EXISTS "Proposers withdraw pending reschedules" ON public.reschedule_proposals;
REVOKE INSERT, UPDATE, DELETE ON public.reschedule_proposals FROM anon, authenticated;


NOTIFY pgrst, 'reload schema';
