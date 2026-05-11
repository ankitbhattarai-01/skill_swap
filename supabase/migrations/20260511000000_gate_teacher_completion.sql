-- Time-gate teacher-initiated session completion.
--
-- Before: either participant could call complete_session() the moment a
-- session moved to 'accepted', which let a teacher accept a paid request and
-- immediately release the learner's escrow without teaching anything
-- (LOGIC-001 in the audit).
--
-- After:
--   - The learner can still complete any time the session is accepted/active.
--     This is the normal "thanks, that was great" flow.
--   - The teacher can only complete once the scheduled session window has
--     elapsed (scheduled_at + duration_minutes). Sessions with no
--     scheduled_at can't be teacher-completed at all — the learner must
--     confirm, or the auto-complete sweeper will pick them up after the
--     7-day cutoff defined in 20260508060000.
--
-- The auto-complete sweeper (service-role / scheduled) is unaffected because
-- it runs as the function owner with auth.uid() = NULL — the teacher gate
-- only triggers when the caller IS the teacher.

CREATE OR REPLACE FUNCTION public.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_learner_credits INT;
  v_caller UUID := auth.uid();
  v_window_end TIMESTAMPTZ;
BEGIN
  SELECT *
  INTO v_session
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

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Only accepted or active sessions can be completed';
  END IF;

  -- Teacher-initiated completion: only allowed after the scheduled end time.
  -- Learners are trusted to mark complete whenever they want (it always
  -- benefits the teacher), so they bypass this gate.
  IF v_caller = v_session.teacher_id AND v_caller <> v_session.learner_id THEN
    IF v_session.scheduled_at IS NULL THEN
      RAISE EXCEPTION 'Teachers can only mark complete after the scheduled session ends';
    END IF;

    v_window_end := v_session.scheduled_at
      + (COALESCE(v_session.duration_minutes, 60) * INTERVAL '1 minute');

    IF now() < v_window_end THEN
      RAISE EXCEPTION 'Teachers can only mark complete after the scheduled session ends';
    END IF;
  END IF;

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;
  ELSE
    SELECT credits
    INTO v_learner_credits
    FROM public.profiles
    WHERE id = v_session.learner_id
    FOR UPDATE;

    IF COALESCE(v_learner_credits, 0) < v_session.credits THEN
      RAISE EXCEPTION 'Learner does not have enough credits';
    END IF;

    UPDATE public.profiles
    SET credits = credits - v_session.credits
    WHERE id = v_session.learner_id;

    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;
  END IF;

  INSERT INTO public.credit_transactions (
    from_user, to_user, amount, session_id, description
  ) VALUES (
    v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id,
    'Session completed'
  );

  UPDATE public.sessions
  SET status = 'completed', escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
