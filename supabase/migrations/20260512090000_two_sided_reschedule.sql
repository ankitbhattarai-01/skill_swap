-- =============================================================================
-- Two-sided reschedule proposals.
--
-- Today the teacher can edit scheduled_at on any pending/accepted session
-- directly via UPDATE. The learner has no say — they find out by reloading.
-- Their only recourse is to cancel (which now costs them a strike if it's
-- close to start). That's not fair.
--
-- After this migration, scheduled_at on an *accepted* session is locked.
-- Either party can propose a new time via propose_reschedule(); the
-- counterparty must accept_reschedule() for the change to land. Direct
-- table UPDATE of scheduled_at is restricted to *pending* sessions (the
-- initial-schedule case, which is one-sided by design — the receiver
-- decides whether to accept the whole package when they accept_session()).
--
-- Closes:
--   H2 — unilateral reschedule on accepted sessions. Now requires
--        explicit consent from the other party.
-- =============================================================================


-- ─── 1. reschedule_proposals table ──────────────────────────────────────────
--
-- One row per proposal. status starts 'pending'; terminal states are
-- 'accepted', 'rejected', 'withdrawn', 'expired'. A session can have at
-- most one active (pending) proposal at a time — enforced by a partial
-- unique index. Past proposals stay in the table as an audit trail.

CREATE TABLE IF NOT EXISTS public.reschedule_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  proposer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  old_scheduled_at TIMESTAMPTZ,
  new_scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'expired')),
  responder_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (note IS NULL OR char_length(note) <= 280),
  CHECK ((responded_at IS NULL) = (responder_id IS NULL))
);
-- One active proposal per session. Enforces that a counterparty can't be
-- spammed with proposals or face a confusing "which one do I accept?" UI.
CREATE UNIQUE INDEX IF NOT EXISTS reschedule_proposals_one_pending_per_session
  ON public.reschedule_proposals (session_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reschedule_proposals_session_idx
  ON public.reschedule_proposals (session_id, created_at DESC);
ALTER TABLE public.reschedule_proposals ENABLE ROW LEVEL SECURITY;
-- Participants of the underlying session can see all proposals for it.
DROP POLICY IF EXISTS "Participants view session reschedules" ON public.reschedule_proposals;
CREATE POLICY "Participants view session reschedules" ON public.reschedule_proposals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = reschedule_proposals.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- Writes go through the SECURITY DEFINER RPCs below.
REVOKE INSERT, UPDATE, DELETE ON public.reschedule_proposals FROM anon, authenticated;
-- ─── 2. propose_reschedule ──────────────────────────────────────────────────
--
-- Either party can call this on an accepted session. Creates a pending
-- proposal that the counterparty must accept or reject. The session's
-- scheduled_at is NOT changed yet — only on accept.

CREATE OR REPLACE FUNCTION public.propose_reschedule(
  p_session_id UUID,
  p_new_scheduled_at TIMESTAMPTZ,
  p_note TEXT DEFAULT NULL
)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Same validation as check_session_schedule() for direct edits: must be
  -- in the future (5-minute clock-skew slack) and within one year.
  IF p_new_scheduled_at <= now() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Proposed time must be in the future';
  END IF;
  IF p_new_scheduled_at > now() + INTERVAL '1 year' THEN
    RAISE EXCEPTION 'Proposed time is too far in the future';
  END IF;

  -- Reject if there's already an active proposal — the counterparty
  -- should handle that one first. Surfaced as a friendly error rather
  -- than leaving the partial unique index to RAISE a 23505.
  IF EXISTS (
    SELECT 1 FROM public.reschedule_proposals
    WHERE session_id = p_session_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Another reschedule proposal is already pending on this session';
  END IF;

  -- Auto-expire any old non-pending proposals more than 30 days old?
  -- Not necessary for correctness — just audit hygiene. Skip for now.

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
REVOKE EXECUTE ON FUNCTION public.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(UUID, TIMESTAMPTZ, TEXT) TO authenticated;
-- ─── 3. accept_reschedule ───────────────────────────────────────────────────
--
-- Counterparty (NOT the proposer) accepts. Moves the session's
-- scheduled_at, marks the proposal accepted, records who responded.

CREATE OR REPLACE FUNCTION public.accept_reschedule(p_proposal_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Re-check the proposed time is still in the future, in case the
  -- counterparty took their time deciding.
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
REVOKE EXECUTE ON FUNCTION public.accept_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(UUID) TO authenticated;
-- ─── 4. reject_reschedule ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reject_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
REVOKE EXECUTE ON FUNCTION public.reject_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_reschedule(UUID) TO authenticated;
-- ─── 5. withdraw_reschedule ─────────────────────────────────────────────────
--
-- The proposer changes their mind. Doesn't need the counterparty to act.

CREATE OR REPLACE FUNCTION public.withdraw_reschedule(p_proposal_id UUID)
RETURNS public.reschedule_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
REVOKE EXECUTE ON FUNCTION public.withdraw_reschedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_reschedule(UUID) TO authenticated;
-- ─── 6. Lock direct scheduled_at writes for accepted sessions ───────────────
--
-- Teachers retain the existing pending-session edit (initial scheduling
-- is one-sided by design — the learner accepts the whole package via
-- accept_session). Once status moves to accepted, scheduled_at can only
-- change via accept_reschedule, which runs as the function owner and
-- bypasses this policy.

DROP POLICY IF EXISTS "Teachers update open session details" ON public.sessions;
DROP POLICY IF EXISTS "Teachers schedule pending sessions" ON public.sessions;
CREATE POLICY "Teachers schedule pending sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = teacher_id
    AND status = 'pending'
  )
  WITH CHECK (
    auth.uid() = teacher_id
    AND status = 'pending'
  );
-- ─── 7. Helpful index for the "active proposal on my session?" lookup ───────

CREATE INDEX IF NOT EXISTS reschedule_proposals_pending_idx
  ON public.reschedule_proposals (session_id, proposer_id)
  WHERE status = 'pending';
