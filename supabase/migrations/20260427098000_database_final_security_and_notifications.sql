-- Final MVP database hardening:
-- 1. restrict direct session updates to the teacher response flow
-- 2. create notification rows for session lifecycle events

DROP POLICY IF EXISTS "Participants update sessions" ON public.sessions;
DROP POLICY IF EXISTS "Teachers respond to pending sessions" ON public.sessions;
CREATE POLICY "Teachers respond to pending sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = teacher_id
    AND status = 'pending'
  )
  WITH CHECK (
    auth.uid() = teacher_id
    AND status IN ('accepted', 'rejected')
  );
CREATE OR REPLACE FUNCTION public.protect_session_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.learner_id IS DISTINCT FROM NEW.learner_id
    OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id
    OR OLD.skill_id IS DISTINCT FROM NEW.skill_id
    OR OLD.credits IS DISTINCT FROM NEW.credits THEN
    RAISE EXCEPTION 'Session participants, skill, and credits cannot be changed';
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
DROP TRIGGER IF EXISTS sessions_protect_integrity ON public.sessions;
CREATE TRIGGER sessions_protect_integrity
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.protect_session_integrity();
REVOKE EXECUTE ON FUNCTION public.protect_session_integrity() FROM PUBLIC, anon, authenticated;
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
  SELECT COALESCE(name, 'Skill session')
  INTO v_skill_name
  FROM public.skills
  WHERE id = NEW.skill_id;

  SELECT COALESCE(full_name, 'Teacher')
  INTO v_teacher_name
  FROM public.profiles
  WHERE id = NEW.teacher_id;

  SELECT COALESCE(full_name, 'Learner')
  INTO v_learner_name
  FROM public.profiles
  WHERE id = NEW.learner_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      body,
      link,
      metadata
    )
    VALUES (
      NEW.teacher_id,
      'session_requested',
      COALESCE(v_learner_name, 'Someone') || ' requested a session',
      COALESCE(v_skill_name, 'Skill session') || ' • ' || NEW.credits::TEXT || ' credits',
      '/sessions/' || NEW.id::TEXT,
      jsonb_build_object(
        'sessionId', NEW.id,
        'skillId', NEW.skill_id,
        'learnerId', NEW.learner_id,
        'teacherId', NEW.teacher_id,
        'status', NEW.status
      )
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'accepted' THEN
      INSERT INTO public.notifications (
        user_id,
        type,
        title,
        body,
        link,
        metadata
      )
      VALUES (
        NEW.learner_id,
        'session_accepted',
        COALESCE(v_teacher_name, 'Your teacher') || ' accepted your session',
        COALESCE(v_skill_name, 'Skill session') || ' is ready',
        '/sessions/' || NEW.id::TEXT,
        jsonb_build_object(
          'sessionId', NEW.id,
          'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id,
          'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'rejected' THEN
      INSERT INTO public.notifications (
        user_id,
        type,
        title,
        body,
        link,
        metadata
      )
      VALUES (
        NEW.learner_id,
        'session_rejected',
        COALESCE(v_teacher_name, 'Your teacher') || ' rejected your session',
        COALESCE(v_skill_name, 'Skill session') || ' request was not accepted',
        '/dashboard',
        jsonb_build_object(
          'sessionId', NEW.id,
          'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id,
          'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'completed' THEN
      INSERT INTO public.notifications (
        user_id,
        type,
        title,
        body,
        link,
        metadata
      )
      VALUES
        (
          NEW.learner_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were sent to ' || COALESCE(v_teacher_name, 'your teacher'),
          '/history',
          jsonb_build_object(
            'sessionId', NEW.id,
            'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id,
            'teacherId', NEW.teacher_id,
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
            'sessionId', NEW.id,
            'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id,
            'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sessions_notify_lifecycle ON public.sessions;
CREATE TRIGGER sessions_notify_lifecycle
  AFTER INSERT OR UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.notify_session_lifecycle();
REVOKE EXECUTE ON FUNCTION public.notify_session_lifecycle() FROM PUBLIC, anon, authenticated;
