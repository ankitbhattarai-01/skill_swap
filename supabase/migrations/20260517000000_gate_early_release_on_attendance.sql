-- =============================================================================
-- Gate the early-release "Complete Session" path on real Jitsi attendance.
--
-- Auto-settle (post-scheduled-end) has read the server-attested attendance
-- log since 20260512060000 — no attendance there = full refund, no farming.
-- But the EARLY-release branch of complete_session (status = accepted/active,
-- before the scheduled end) still transferred credits on the learner's word
-- alone, with no attendance check at all.
--
-- That leaves a Sybil farming hole: spin up N learner accounts, each schedules
-- a session with one main teacher account, the fake learner clicks
-- "Complete Session" before the session ever runs, and N × sessions.credits
-- funnel into one account with zero teaching. The bug report that triggered
-- this migration showed an active "Complete Session" button on a session
-- still 21 hours from starting.
--
-- This migration adds two preconditions to the early-release branch only:
--   1. Wall-clock: ≥ 50% of the planned session time has elapsed since the
--      scheduled start. Gives the UI a deterministic "available at HH:MM"
--      hint.
--   2. Attendance: both learner and teacher have ≥ 50% of the planned
--      duration in the server-attested Jitsi log. Pure time-elapsed isn't
--      enough on its own — an attacker could schedule a sham session and
--      just wait. Forcing real Jitsi presence raises the per-session cost
--      to "two browsers connected for half the duration", which kills the
--      Sybil farming economics.
--
-- Auto-settle, dispute, admin-resolve, and the pending_review handoff are
-- unchanged. The function lives in the `private` schema since 20260513190000;
-- the `public.complete_session` wrapper is left alone.
-- =============================================================================

CREATE OR REPLACE FUNCTION private.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session        public.sessions;
  v_caller         UUID := auth.uid();
  v_learner_secs   INT;
  v_teacher_secs   INT;
  v_required_secs  INT;
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

  IF v_session.status = 'completed' THEN
    RETURN v_session;
  END IF;

  -- Pending_review: hand off to the attendance-aware auto-settle. That path
  -- already gates on attendance and falls back to refund, so no extra gates
  -- needed here.
  IF v_session.status = 'pending_review' THEN
    RETURN public.auto_settle_session(v_session.id);
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot complete a session in status %', v_session.status;
  END IF;

  IF v_caller = v_session.teacher_id THEN
    RAISE EXCEPTION 'Teachers can only complete after the session ends. The session will move to review automatically.';
  END IF;

  -- ─── Anti-farming gates on the early-release path ──────────────────────────
  -- All three must hold for a learner to release escrow before the scheduled
  -- end. Any one of them blocks the transfer; the learner can still cancel
  -- for a refund, or wait for the auto-settle path (which applies the same
  -- attendance rule with a refund fallback for no-shows).

  -- Gate 1: at least 50% of the planned session time must have elapsed
  -- since the scheduled start. Time-based so the UI can show a clear
  -- "available at HH:MM" hint without polling attendance, and so the
  -- learner can't release credits 30 seconds into a 60-minute session.
  IF v_session.scheduled_at IS NULL
     OR now() < v_session.scheduled_at + ((v_session.duration_minutes::numeric / 2.0) * INTERVAL '1 minute') THEN
    RAISE EXCEPTION 'Credits can only be released after at least half the planned session time has passed.';
  END IF;

  v_learner_secs := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  -- Gate 2: BOTH parties must have attended ≥ 50% of the planned duration.
  -- 50% mirrors auto_settle_session()'s "attended" classification — so
  -- early-release is just the learner skipping the post-session wait when
  -- both sides would already class as attended anyway.
  -- This also subsumes the "both must have joined" check (50% implies > 0)
  -- and blocks both the no-show-teacher farming case AND the "click
  -- Complete after 1 minute then leave" pattern.
  v_required_secs := (v_session.duration_minutes * 60) / 2;
  IF v_teacher_secs < v_required_secs OR v_learner_secs < v_required_secs THEN
    RAISE EXCEPTION 'Both you and your teacher must attend at least 50%% of the session (% seconds each, out of % planned) before credits can be released early. Wait for the session to wrap up — credits release automatically once attendance is confirmed.',
      v_required_secs, v_session.duration_minutes * 60;
  END IF;

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.teacher_id, v_session.credits, v_session.id,
      'Released from escrow (early)'
    );
  ELSE
    -- Legacy unescrowed path: no prior "Held" entry exists, so the transfer
    -- is genuinely learner → teacher in the ledger. Vanishingly rare.
    UPDATE public.profiles SET credits = credits - v_session.credits
    WHERE id = v_session.learner_id;
    UPDATE public.profiles SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id,
      'Session completed (legacy non-escrow)'
    );
  END IF;

  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, 'early_release', 'released_by_learner',
    v_learner_secs, v_teacher_secs, v_session.duration_minutes * 60,
    v_session.credits, 0, v_caller
  );

  UPDATE public.sessions
  SET status = 'completed', escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
