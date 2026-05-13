-- =============================================================================
-- Make the credit_transactions ledger consistent on the escrow release leg.
--
-- accept_session writes  (from=learner, to=NULL, "Held for upcoming session")
--                        -- learner sends N → escrow.
-- cancel_session writes  (from=NULL,    to=learner, "Refund: ...")
--                        -- escrow sends N → learner. Pairs cleanly with Hold.
--
-- complete_session and auto_settle_session, however, write
--                        (from=learner, to=teacher, "Session completed")
-- which is wrong: the learner's balance was already decremented at accept
-- time. The credit moving on completion is FROM ESCROW (= NULL) TO TEACHER.
-- Treating it as learner→teacher makes every audit query that sums
-- `from_user = X` overstate X's outflow by 1× the session credits, since
-- the "Held" row already booked the outflow.
--
-- Fix: rewrite both RPCs so the completion entry is (from=NULL, to=teacher).
-- The partial_split refund leg in auto_settle_session is already correctly
-- written as (from=NULL, to=learner), so it stays as is.
-- =============================================================================


-- ─── 1. auto_settle_session ──────────────────────────────────────────────────
--
-- Only the teacher-leg ledger insert changes. Everything else stays identical
-- to 20260512060000.

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
    v_outcome := 'partial_split';
    v_reason  := CASE
      WHEN v_learner_class = 'left_early' AND v_teacher_class = 'attended' THEN 'learner_left_early'
      WHEN v_teacher_class = 'left_early' AND v_learner_class = 'attended' THEN 'teacher_left_early'
      ELSE 'both_left_early'
    END;
    v_to_teacher := v_session.credits / 2;
    v_to_learner := v_session.credits - v_to_teacher;
  END IF;

  IF v_to_teacher > 0 THEN
    UPDATE public.profiles
    SET credits = credits + v_to_teacher
    WHERE id = v_session.teacher_id;

    -- LEDGER FIX: the credit moving on settlement flows FROM ESCROW to the
    -- teacher. The learner's outflow was already booked by accept_session's
    -- "Held for upcoming session" row.
    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.teacher_id, v_to_teacher, v_session.id,
      CASE WHEN v_outcome = 'partial_split'
           THEN 'Released from escrow (partial)'
           ELSE 'Released from escrow' END
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

  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, v_outcome, v_reason,
    v_learner_secs, v_teacher_secs, v_duration_secs,
    v_to_teacher, v_to_learner, v_caller
  );

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


-- ─── 2. complete_session ─────────────────────────────────────────────────────
--
-- Only the early-release ledger insert changes. Legacy unescrowed path
-- (rare; pre-20260508050000 rows) still writes learner→teacher because in
-- that path there is no prior "Held" entry to pair with.

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

  IF v_session.status = 'pending_review' THEN
    RETURN public.auto_settle_session(v_session.id);
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot complete a session in status %', v_session.status;
  END IF;

  IF v_caller = v_session.teacher_id THEN
    RAISE EXCEPTION 'Teachers can only complete after the session ends. The session will move to review automatically.';
  END IF;

  v_learner_secs := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    -- LEDGER FIX: release from escrow → teacher. Matches the cancel-side
    -- "Refund: ..." entry which is also NULL → learner.
    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.teacher_id, v_session.credits, v_session.id,
      'Released from escrow (early)'
    );
  ELSE
    -- Legacy unescrowed path: no prior "Held" entry exists, so the
    -- transfer is genuinely learner → teacher in the ledger.
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

REVOKE EXECUTE ON FUNCTION public.complete_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session(UUID) TO authenticated;
