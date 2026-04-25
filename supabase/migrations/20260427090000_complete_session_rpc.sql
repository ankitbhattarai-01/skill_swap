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

  IF auth.uid() IS NULL OR (auth.uid() <> v_session.learner_id AND auth.uid() <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status = 'completed' THEN
    RETURN v_session;
  END IF;

  IF v_session.status <> 'accepted' THEN
    RAISE EXCEPTION 'Only accepted sessions can be completed';
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

  UPDATE public.profiles
  SET credits = credits + v_session.credits
  WHERE id = v_session.teacher_id;

  INSERT INTO public.credit_transactions (
    from_user,
    to_user,
    amount,
    session_id,
    description
  )
  VALUES (
    v_session.learner_id,
    v_session.teacher_id,
    v_session.credits,
    v_session.id,
    'Session completed'
  );

  UPDATE public.sessions
  SET status = 'completed'
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.complete_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session(UUID) TO authenticated;
