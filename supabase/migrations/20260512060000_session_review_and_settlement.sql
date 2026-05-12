-- =============================================================================
-- Attendance-based session settlement.
--
-- Replaces the honor-system complete_session() with a flow that reads the
-- server-attested session_attendance log from the previous migration and
-- decides who gets the escrow based on who actually showed up.
--
-- New lifecycle:
--
--   pending → accepted → (scheduled end passes) → pending_review
--                                                       ↓
--                              "All good" click   OR    24h auto-settle
--                                                       ↓
--                                          completed | cancelled
--
--                                  (or "Something's wrong" → disputed → admin resolves)
--
-- Closes:
--   C1 — teacher could complete 35 min after creating an unattended session.
--        Teachers now never call complete on accepted/active; the sweeper
--        moves the session to pending_review, and auto_settle reads the
--        attendance log. No attendance → full refund. No farming.
--   C2 — unscheduled accepted sessions auto-settled to teacher after 7d.
--        They now route through pending_review and the attendance rule,
--        so an empty attendance log → full refund instead of free credits.
--   C3 (downstream) — settlement audit table makes attendance visible to
--        future strike logic in migration #3.
-- =============================================================================


-- ─── 1. session_settlement audit table ───────────────────────────────────────
--
-- One row per terminal settlement (full transfer / partial split / refund /
-- admin resolution). Stores the attendance snapshot at settlement time so
-- the next migration's strike system has a stable "did this user no-show?"
-- signal even after the live attendance rows get archived/deleted.

CREATE TABLE IF NOT EXISTS public.session_settlement (
  session_id UUID PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'full_transfer',     -- both attended → escrow to teacher
    'partial_split',     -- one or both left early → escrow split 50/50
    'full_refund',       -- one or both no-show → full refund to learner
    'early_release',     -- learner clicked Complete during accepted/active
    'admin_transfer',    -- admin resolved dispute toward teacher
    'admin_split',       -- admin resolved dispute as 50/50 split
    'admin_refund'       -- admin resolved dispute toward learner
  )),
  reason TEXT NOT NULL,
  learner_attended_seconds INT NOT NULL DEFAULT 0,
  teacher_attended_seconds INT NOT NULL DEFAULT 0,
  duration_seconds INT NOT NULL,
  amount_to_teacher INT NOT NULL CHECK (amount_to_teacher >= 0),
  amount_refunded_to_learner INT NOT NULL CHECK (amount_refunded_to_learner >= 0),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS session_settlement_settled_at_idx
  ON public.session_settlement (settled_at DESC);
ALTER TABLE public.session_settlement ENABLE ROW LEVEL SECURITY;
-- Participants can see their own session's settlement (for the post-session UI:
-- "Refunded because the teacher didn't attend", etc.).
DROP POLICY IF EXISTS "Participants view their settlement" ON public.session_settlement;
CREATE POLICY "Participants view their settlement" ON public.session_settlement
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_settlement.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- No direct writes from clients. All inserts come from SECURITY DEFINER
-- functions below.
REVOKE INSERT, UPDATE, DELETE ON public.session_settlement FROM anon, authenticated;
-- ─── 2. Updated integrity trigger: allow new state transitions ───────────────
--
-- Adds the four new transition arcs that the settlement flow needs:
--   accepted       → pending_review     (sweeper, when scheduled end passes)
--   active         → pending_review     (sweeper, same)
--   pending_review → completed|cancelled (auto_settle / "All good" click)
--   pending_review → disputed           ("Something's wrong" click)
--   disputed       → completed|cancelled (admin_resolve_dispute)
--
-- The escrow-and-status client-write block at the top is unchanged: only
-- SECURITY DEFINER RPCs (which run as the function owner, not as the
-- authenticated role) can move status or escrow_held.

CREATE OR REPLACE FUNCTION public.protect_session_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
    AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.escrow_held IS DISTINCT FROM NEW.escrow_held
      OR OLD.initiator_id IS DISTINCT FROM NEW.initiator_id
    )
  THEN
    RAISE EXCEPTION 'Session status and escrow can only be changed through session actions';
  END IF;

  IF OLD.learner_id IS DISTINCT FROM NEW.learner_id
    OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id
    OR OLD.skill_id IS DISTINCT FROM NEW.skill_id
    OR OLD.credits IS DISTINCT FROM NEW.credits
    OR OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes THEN
    RAISE EXCEPTION 'Session participants, skill, credits, and duration cannot be changed';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected', 'cancelled'))
      OR (OLD.status = 'accepted' AND NEW.status IN ('completed', 'cancelled', 'active', 'pending_review'))
      OR (OLD.status = 'active' AND NEW.status IN ('completed', 'cancelled', 'pending_review'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('completed', 'cancelled', 'disputed'))
      OR (OLD.status = 'disputed' AND NEW.status IN ('completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Invalid session status transition from % to %', OLD.status, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
-- ─── 3. auto_settle_session: the attendance-driven settlement rule ───────────
--
-- Reads session_attended_seconds for both parties, classifies each as
--   attended    (≥ 50% of duration)
--   left_early  (>0 but < 50%)
--   no_show     (= 0)
-- ...and applies the outcome table. Writes an audit row and a credit
-- transaction trail, flips the session to completed (credits moved) or
-- cancelled (refunded). 50% is the attendance threshold — generous enough
-- that brief tech glitches don't punish either party.

CREATE OR REPLACE FUNCTION public.auto_settle_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session       public.sessions;
  v_caller        UUID := auth.uid();
  v_learner_secs  INT;
  v_teacher_secs  INT;
  v_duration_secs INT;
  v_learner_pct   NUMERIC;
  v_teacher_pct   NUMERIC;
  v_learner_class TEXT;
  v_teacher_class TEXT;
  v_outcome       TEXT;
  v_reason        TEXT;
  v_to_teacher    INT;
  v_to_learner    INT;
  v_terminal      public.session_status;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  -- Permission: anyone can trigger settlement on a pending_review session
  -- they're part of (it's just the auto-rule, no privileged decision); the
  -- service role / sweeper can trigger on any session; nobody else.
  IF v_caller IS NOT NULL
     AND v_caller <> v_session.learner_id
     AND v_caller <> v_session.teacher_id THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status NOT IN ('pending_review', 'accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot settle session in status %', v_session.status;
  END IF;

  IF NOT v_session.escrow_held THEN
    RAISE EXCEPTION 'Session has no escrow to settle';
  END IF;

  v_duration_secs := v_session.duration_minutes * 60;
  v_learner_secs  := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs  := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  v_learner_pct := CASE WHEN v_duration_secs > 0
                        THEN v_learner_secs::numeric / v_duration_secs
                        ELSE 0 END;
  v_teacher_pct := CASE WHEN v_duration_secs > 0
                        THEN v_teacher_secs::numeric / v_duration_secs
                        ELSE 0 END;

  v_learner_class := CASE
    WHEN v_learner_secs = 0 THEN 'no_show'
    WHEN v_learner_pct < 0.5 THEN 'left_early'
    ELSE 'attended'
  END;
  v_teacher_class := CASE
    WHEN v_teacher_secs = 0 THEN 'no_show'
    WHEN v_teacher_pct < 0.5 THEN 'left_early'
    ELSE 'attended'
  END;

  -- Rule table. The asymmetry between learner_no_show and teacher_no_show
  -- isn't material for credits (both refund fully) but matters for the
  -- strike system: the reason string is the canonical signal of who
  -- failed to show.
  IF v_learner_class = 'attended' AND v_teacher_class = 'attended' THEN
    v_outcome := 'full_transfer';
    v_reason  := 'both_attended';
    v_to_teacher := v_session.credits;
    v_to_learner := 0;

  ELSIF v_learner_class = 'no_show' AND v_teacher_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'mutual_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;

  ELSIF v_teacher_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'teacher_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;

  ELSIF v_learner_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'learner_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;

  ELSE
    -- Both present at some point, but at least one left early.
    v_outcome := 'partial_split';
    v_reason  := CASE
      WHEN v_learner_class = 'left_early' AND v_teacher_class = 'attended' THEN 'learner_left_early'
      WHEN v_teacher_class = 'left_early' AND v_learner_class = 'attended' THEN 'teacher_left_early'
      ELSE 'both_left_early'
    END;
    v_to_teacher := v_session.credits / 2;  -- integer division: 3 → 1, 4 → 2
    v_to_learner := v_session.credits - v_to_teacher;
  END IF;

  -- Apply credit movements. The learner's portion was already debited at
  -- accept_session() time and is sitting in escrow (off-profile), so a
  -- "refund" is a credit back; a "transfer" credits the teacher. We never
  -- touch the learner's balance for the teacher portion here — that
  -- money is already gone from their balance.
  IF v_to_teacher > 0 THEN
    UPDATE public.profiles
    SET credits = credits + v_to_teacher
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      v_session.learner_id, v_session.teacher_id, v_to_teacher, v_session.id,
      CASE WHEN v_outcome = 'partial_split'
           THEN 'Session partial settlement'
           ELSE 'Session completed' END
    );
  END IF;

  IF v_to_learner > 0 THEN
    UPDATE public.profiles
    SET credits = credits + v_to_learner
    WHERE id = v_session.learner_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.learner_id, v_to_learner, v_session.id,
      'Refund: ' || v_reason
    );
  END IF;

  -- Audit
  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, v_outcome, v_reason,
    v_learner_secs, v_teacher_secs, v_duration_secs,
    v_to_teacher, v_to_learner, v_caller
  );

  -- Terminal state: 'completed' if any credit reached the teacher,
  -- otherwise 'cancelled'. (A full_refund — including no-show outcomes —
  -- ends in 'cancelled' so the existing UI distinguishing completed-vs-
  -- cancelled sessions still works.)
  v_terminal := CASE WHEN v_to_teacher > 0 THEN 'completed'::session_status
                                            ELSE 'cancelled'::session_status END;

  UPDATE public.sessions
  SET status = v_terminal, escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.auto_settle_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_settle_session(UUID) TO authenticated;
-- ─── 4. Reworked complete_session(): two paths ───────────────────────────────
--
-- During pending_review (the normal "happy path" after a session ends):
--   Either party clicks "All good" → call auto_settle_session() now,
--   skip the 24h wait. Outcome respects attendance.
--
-- During accepted / active (before scheduled end has passed):
--   Only the learner can call complete_session — releases escrow to the
--   teacher in full as an early gift. The teacher cannot complete in this
--   state because:
--   (a) auto-settle hasn't happened yet → no attendance evidence;
--   (b) letting teacher self-complete = the C1 farming hole.
--
-- All other statuses error.

CREATE OR REPLACE FUNCTION public.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session       public.sessions;
  v_caller        UUID := auth.uid();
  v_learner_secs  INT;
  v_teacher_secs  INT;
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

  -- Pending_review: route through the attendance rule. Either side clicking
  -- "All good" is just an explicit skip-the-wait — they accept whatever
  -- auto_settle decides.
  IF v_session.status = 'pending_review' THEN
    RETURN public.auto_settle_session(v_session.id);
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot complete a session in status %', v_session.status;
  END IF;

  -- accepted/active path: only the learner may early-release the escrow.
  IF v_caller = v_session.teacher_id THEN
    RAISE EXCEPTION 'Teachers can only complete after the session ends. The session will move to review automatically.';
  END IF;

  v_learner_secs := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;
  ELSE
    -- Legacy unescrowed sessions from before 20260508050000. Still need to
    -- move credits from learner to teacher in one shot. Should be vanishingly
    -- rare in practice but keeps old data working.
    UPDATE public.profiles SET credits = credits - v_session.credits
    WHERE id = v_session.learner_id;
    UPDATE public.profiles SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;
  END IF;

  INSERT INTO public.credit_transactions (
    from_user, to_user, amount, session_id, description
  ) VALUES (
    v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id,
    'Session completed (released early by learner)'
  );

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
REVOKE EXECUTE ON FUNCTION public.complete_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session(UUID) TO authenticated;
-- ─── 5. dispute_session: freeze settlement, route to admin ───────────────────
--
-- Called when a participant clicks "Something's wrong" during pending_review.
-- Freezes the session in 'disputed' so the sweeper won't auto-settle. The
-- participant should also file a regular report explaining the dispute —
-- that's a separate call to the existing reports flow and gets attached
-- to the admin queue.
--
-- Cannot be called outside pending_review: before scheduled end there's
-- nothing to dispute yet (use cancel_session), after settlement the
-- session is terminal (use the regular reporting flow against the
-- completed session).

CREATE OR REPLACE FUNCTION public.dispute_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_caller  UUID := auth.uid();
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

  IF v_session.status <> 'pending_review' THEN
    RAISE EXCEPTION 'Disputes are only allowed during the review window';
  END IF;

  UPDATE public.sessions
  SET status = 'disputed'
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.dispute_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispute_session(UUID) TO authenticated;
-- ─── 6. admin_resolve_dispute: clear the freeze, settle per admin decision ──
--
-- Admin-only path out of 'disputed'. Distinguishes three outcomes:
--   teacher → full transfer to teacher (admin sided with teacher)
--   learner → full refund to learner (admin sided with learner)
--   split   → 50/50 (admin couldn't determine fault)
-- Writes a settlement audit row marked admin_* so the next migration's
-- strike system knows not to award a no-show strike on top of an
-- admin-resolved case.

CREATE OR REPLACE FUNCTION public.admin_resolve_dispute(
  p_session_id   UUID,
  p_in_favor_of  TEXT,
  p_notes        TEXT DEFAULT NULL
)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session     public.sessions;
  v_caller      UUID := auth.uid();
  v_to_teacher  INT;
  v_to_learner  INT;
  v_outcome     TEXT;
  v_terminal    public.session_status;
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  IF p_in_favor_of NOT IN ('teacher', 'learner', 'split') THEN
    RAISE EXCEPTION 'p_in_favor_of must be one of: teacher, learner, split';
  END IF;

  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session.status <> 'disputed' THEN
    RAISE EXCEPTION 'Session is not in dispute';
  END IF;

  v_to_teacher := CASE p_in_favor_of
    WHEN 'teacher' THEN v_session.credits
    WHEN 'split'   THEN v_session.credits / 2
    WHEN 'learner' THEN 0
  END;
  v_to_learner := v_session.credits - v_to_teacher;
  v_outcome := CASE p_in_favor_of
    WHEN 'teacher' THEN 'admin_transfer'
    WHEN 'split'   THEN 'admin_split'
    WHEN 'learner' THEN 'admin_refund'
  END;

  IF v_to_teacher > 0 THEN
    UPDATE public.profiles SET credits = credits + v_to_teacher
    WHERE id = v_session.teacher_id;
    INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
    VALUES (v_session.learner_id, v_session.teacher_id, v_to_teacher, v_session.id,
            'Admin resolution: ' || COALESCE(p_notes, p_in_favor_of));
  END IF;

  IF v_to_learner > 0 THEN
    UPDATE public.profiles SET credits = credits + v_to_learner
    WHERE id = v_session.learner_id;
    INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
    VALUES (NULL, v_session.learner_id, v_to_learner, v_session.id,
            'Admin refund: ' || COALESCE(p_notes, p_in_favor_of));
  END IF;

  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, v_outcome, COALESCE(p_notes, 'admin_' || p_in_favor_of),
    public.session_attended_seconds(v_session.id, v_session.learner_id),
    public.session_attended_seconds(v_session.id, v_session.teacher_id),
    v_session.duration_minutes * 60,
    v_to_teacher, v_to_learner, v_caller
  );

  v_terminal := CASE WHEN v_to_teacher > 0
                     THEN 'completed'::session_status
                     ELSE 'cancelled'::session_status END;

  UPDATE public.sessions
  SET status = v_terminal, escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_resolve_dispute(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute(UUID, TEXT, TEXT) TO authenticated;
-- ─── 7. Sweeper: accepted → pending_review when scheduled end passes ─────────
--
-- Runs as a scheduled cron job (every 5–15 min is plenty). Walks accepted
-- sessions whose scheduled end has passed (with 5min grace for clock skew)
-- and moves them into pending_review so the user-facing review UI lights
-- up. Unscheduled accepted sessions get swept after 7 days from acceptance.

CREATE OR REPLACE FUNCTION public.move_due_sessions_to_review()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_id    UUID;
BEGIN
  FOR v_id IN
    SELECT id FROM public.sessions
    WHERE status IN ('accepted', 'active')
      AND escrow_held = true
      AND (
        (scheduled_at IS NOT NULL
          AND now() > scheduled_at + (duration_minutes * INTERVAL '1 minute') + INTERVAL '5 minutes')
        OR (scheduled_at IS NULL
          AND now() > updated_at + INTERVAL '7 days')
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.sessions
    SET status = 'pending_review'
    WHERE id = v_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.move_due_sessions_to_review() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_due_sessions_to_review() TO service_role;
-- ─── 8. Sweeper: pending_review (24h+) → auto_settle ────────────────────────
--
-- Runs on the same cron. Pending_review sessions that nobody disputed or
-- confirmed within 24h get settled by the attendance rule. Disputed
-- sessions are skipped — they need admin attention, not auto-resolution.

CREATE OR REPLACE FUNCTION public.settle_pending_review_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_id    UUID;
BEGIN
  FOR v_id IN
    SELECT id FROM public.sessions
    WHERE status = 'pending_review'
      AND escrow_held = true
      AND updated_at < now() - INTERVAL '24 hours'
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.auto_settle_session(v_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.settle_pending_review_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_pending_review_sessions() TO service_role;
-- ─── 9. Drop the old all-in-one sweeper ──────────────────────────────────────
--
-- auto_complete_due_sessions() did "accepted → completed in 7 days" without
-- reading attendance. The new two-step sweeper replaces it. Anything
-- scheduled to call the old one needs to switch to the two new functions.

DROP FUNCTION IF EXISTS public.auto_complete_due_sessions();
-- ─── 10. Helpful indexes for the new sweepers ───────────────────────────────

CREATE INDEX IF NOT EXISTS sessions_accepted_due_idx
  ON public.sessions (status, scheduled_at, updated_at)
  WHERE status IN ('accepted', 'active') AND escrow_held = true;
CREATE INDEX IF NOT EXISTS sessions_pending_review_due_idx
  ON public.sessions (status, updated_at)
  WHERE status = 'pending_review' AND escrow_held = true;
