-- Escrow model for session credits.
--
-- Before this migration, credits only moved when complete_session() ran, which
-- meant a teacher could be ghosted by a learner refusing to click "Complete".
-- Now credits are held the moment a session is accepted, and released only on
-- completion or refunded on cancellation.
--
-- A boolean flag tracks whether escrow was applied so legacy sessions accepted
-- before this migration keep working with the old "deduct on complete" path.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS escrow_held boolean NOT NULL DEFAULT false;
-- accept_session: teacher accepts a pending request, learner credits are
-- atomically deducted into escrow, video room link is stored, status moves to
-- 'accepted'. Validates teacher identity and that the learner can pay.
CREATE OR REPLACE FUNCTION public.accept_session(p_session_id UUID, p_meet_link TEXT)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_learner_credits INT;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> v_session.teacher_id THEN
    RAISE EXCEPTION 'Only the teacher can accept this session';
  END IF;

  IF v_session.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sessions can be accepted';
  END IF;

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

  INSERT INTO public.credit_transactions (
    from_user, to_user, amount, session_id, description
  ) VALUES (
    v_session.learner_id, NULL, v_session.credits, v_session.id,
    'Held for upcoming session'
  );

  UPDATE public.sessions
  SET status = 'accepted', meet_link = p_meet_link, escrow_held = true
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) TO authenticated;
-- cancel_session: either party can cancel from pending/accepted/active. If
-- escrow was held, the learner is refunded in full and a ledger entry records
-- the refund. From 'pending' (no escrow yet) it just flips status.
CREATE OR REPLACE FUNCTION public.cancel_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF auth.uid() IS NULL
     OR (auth.uid() <> v_session.learner_id AND auth.uid() <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status NOT IN ('pending', 'accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot cancel a session in status %', v_session.status;
  END IF;

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.learner_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.learner_id, v_session.credits, v_session.id,
      'Refund: session cancelled'
    );
  END IF;

  UPDATE public.sessions
  SET status = 'cancelled', escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_session(UUID) TO authenticated;
-- complete_session is updated to release escrowed credits to the teacher when
-- escrow_held=true (the new path). Sessions accepted before this migration
-- still use the old "deduct learner now" path so legacy data does not get
-- under-deducted.
CREATE OR REPLACE FUNCTION public.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_learner_credits INT;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF auth.uid() IS NULL
     OR (auth.uid() <> v_session.learner_id AND auth.uid() <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status = 'completed' THEN
    RETURN v_session;
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Only accepted or active sessions can be completed';
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
