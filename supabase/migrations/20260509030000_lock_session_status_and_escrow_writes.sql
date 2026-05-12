-- Lock session status/escrow transitions behind trusted RPCs.
--
-- The original INSERT/UPDATE policies let either participant create or update
-- sensitive session fields directly. That made it possible to forge
-- `escrow_held = true` or create already-accepted sessions and then call
-- complete_session(). Track who initiated a pending session, require the
-- counterparty to accept/reject it, and leave browser-role updates limited to
-- scheduling/room-link details.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS initiator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sessions
  ALTER COLUMN initiator_id SET DEFAULT auth.uid();
UPDATE public.sessions
SET initiator_id = learner_id
WHERE initiator_id IS NULL
  AND learner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_initiator_id_idx
  ON public.sessions (initiator_id);
REVOKE UPDATE ON public.sessions FROM anon, authenticated;
GRANT UPDATE (meet_link, scheduled_at) ON public.sessions TO authenticated;
DROP POLICY IF EXISTS "Authenticated create sessions" ON public.sessions;
CREATE POLICY "Participants create pending sessions" ON public.sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid() = initiator_id
    AND (auth.uid() = learner_id OR auth.uid() = teacher_id)
    AND learner_id IS NOT NULL
    AND teacher_id IS NOT NULL
    AND learner_id <> teacher_id
    AND status = 'pending'
    AND escrow_held = false
    AND credits > 0
    AND duration_minutes IN (30, 60, 90)
  );
DROP POLICY IF EXISTS "Teachers respond to pending sessions" ON public.sessions;
DROP POLICY IF EXISTS "Learners cancel pending sessions" ON public.sessions;
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
      OR (OLD.status = 'accepted' AND NEW.status IN ('completed', 'cancelled'))
      OR (OLD.status = 'active' AND NEW.status IN ('completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Invalid session status transition from % to %', OLD.status, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.accept_session(p_session_id UUID, p_meet_link TEXT)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_actor UUID := auth.uid();
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

  IF v_actor IS NULL
     OR (v_actor <> v_session.learner_id AND v_actor <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF COALESCE(v_session.initiator_id, v_session.learner_id) = v_actor THEN
    RAISE EXCEPTION 'Only the counterparty can accept this session';
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
CREATE OR REPLACE FUNCTION public.reject_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_actor UUID := auth.uid();
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_actor IS NULL
     OR (v_actor <> v_session.learner_id AND v_actor <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF COALESCE(v_session.initiator_id, v_session.learner_id) = v_actor THEN
    RAISE EXCEPTION 'Only the counterparty can reject this session';
  END IF;

  IF v_session.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sessions can be rejected';
  END IF;

  UPDATE public.sessions
  SET status = 'rejected'
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_session(UUID) TO authenticated;
