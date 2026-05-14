-- Account deletion sets session participant FKs to NULL through ON DELETE SET
-- NULL. The session integrity trigger should still block participant swaps, but
-- it must allow that one-way tombstone after the deletion trigger has cancelled
-- any open/escrowed sessions.

CREATE OR REPLACE FUNCTION public.protect_session_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_participant_changed BOOLEAN :=
    OLD.learner_id IS DISTINCT FROM NEW.learner_id
    OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id;
  v_participant_tombstone BOOLEAN :=
    v_participant_changed
    AND NEW.status IN ('rejected', 'completed', 'cancelled')
    AND (
      NEW.learner_id IS NULL
      OR NEW.learner_id IS NOT DISTINCT FROM OLD.learner_id
    )
    AND (
      NEW.teacher_id IS NULL
      OR NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
    );
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

  IF (v_participant_changed AND NOT v_participant_tombstone)
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
CREATE OR REPLACE FUNCTION public.refund_open_sessions_before_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
BEGIN
  FOR v_session IN
    SELECT *
    FROM public.sessions
    WHERE (teacher_id = OLD.id OR learner_id = OLD.id)
      AND status IN ('pending', 'accepted', 'active', 'pending_review', 'disputed')
    FOR UPDATE
  LOOP
    IF v_session.escrow_held AND v_session.learner_id IS NOT NULL THEN
      UPDATE public.profiles
      SET credits = credits + v_session.credits
      WHERE id = v_session.learner_id;

      INSERT INTO public.credit_transactions (
        from_user, to_user, amount, session_id, description
      ) VALUES (
        NULL, v_session.learner_id, v_session.credits, v_session.id,
        'Refund: counterparty deleted account'
      );
    END IF;

    UPDATE public.sessions
    SET status = 'cancelled', escrow_held = false
    WHERE id = v_session.id;
  END LOOP;

  RETURN OLD;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.protect_session_integrity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_open_sessions_before_user_delete() FROM PUBLIC, anon, authenticated;
