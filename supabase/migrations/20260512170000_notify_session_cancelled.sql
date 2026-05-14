-- =============================================================================
-- Notify both parties when a session is cancelled.
--
-- The 20260427098000 trigger covered accepted / rejected / completed but
-- left `cancelled` silent — so when either party cancels an accepted
-- session, the other side gets no row in `notifications` and no realtime
-- event. Fix by adding the cancelled branch.
--
-- We insert one row per remaining participant (i.e. NOT the canceller, if
-- we can infer it from the cancelled_by column, otherwise both). Today
-- there's no `cancelled_by` column, so we notify both parties — each one
-- learns of the cancellation. Caller-detection can be a follow-up if the
-- UX needs it.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.notify_session_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_skill_name TEXT;
  v_teacher_name TEXT;
  v_learner_name TEXT;
BEGIN
  SELECT COALESCE(name, 'Skill session') INTO v_skill_name
  FROM public.skills WHERE id = NEW.skill_id;

  SELECT COALESCE(full_name, 'Teacher') INTO v_teacher_name
  FROM public.profiles WHERE id = NEW.teacher_id;

  SELECT COALESCE(full_name, 'Learner') INTO v_learner_name
  FROM public.profiles WHERE id = NEW.learner_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      NEW.teacher_id,
      'session_requested',
      COALESCE(v_learner_name, 'Someone') || ' requested a session',
      COALESCE(v_skill_name, 'Skill session') || ' • ' || NEW.credits::TEXT || ' credits',
      '/sessions/' || NEW.id::TEXT,
      jsonb_build_object(
        'sessionId', NEW.id, 'skillId', NEW.skill_id,
        'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
        'status', NEW.status
      )
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'accepted' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.learner_id,
        'session_accepted',
        COALESCE(v_teacher_name, 'Your teacher') || ' accepted your session',
        COALESCE(v_skill_name, 'Skill session') || ' is ready',
        '/sessions/' || NEW.id::TEXT,
        jsonb_build_object(
          'sessionId', NEW.id, 'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'rejected' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.learner_id,
        'session_rejected',
        COALESCE(v_teacher_name, 'Your teacher') || ' rejected your session',
        COALESCE(v_skill_name, 'Skill session') || ' request was not accepted',
        '/dashboard',
        jsonb_build_object(
          'sessionId', NEW.id, 'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'cancelled' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_teacher_name, 'your teacher') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        ),
        (
          NEW.teacher_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_learner_name, 'your learner') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        );
    ELSIF NEW.status = 'completed' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were sent to ' || COALESCE(v_teacher_name, 'your teacher'),
          '/history',
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        ),
        (
          NEW.teacher_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were received from ' || COALESCE(v_learner_name, 'your learner'),
          '/history',
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
