CREATE OR REPLACE FUNCTION public.notify_session_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_receiver_id UUID;
  v_sender_name TEXT;
  v_skill_name TEXT;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = NEW.session_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_id = v_session.learner_id THEN
    v_receiver_id := v_session.teacher_id;
  ELSIF NEW.sender_id = v_session.teacher_id THEN
    v_receiver_id := v_session.learner_id;
  ELSE
    RETURN NEW;
  END IF;

  IF v_receiver_id IS NULL OR v_receiver_id = NEW.sender_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(full_name, 'Someone')
  INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;

  SELECT COALESCE(name, 'a session')
  INTO v_skill_name
  FROM public.skills
  WHERE id = v_session.skill_id;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    body,
    link,
    metadata
  )
  VALUES (
    v_receiver_id,
    'message',
    COALESCE(v_sender_name, 'Someone') || ' sent you a message',
    LEFT(NEW.text, 160),
    '/messages/' || NEW.session_id::TEXT,
    jsonb_build_object(
      'sessionId', NEW.session_id,
      'senderId', NEW.sender_id,
      'skillName', COALESCE(v_skill_name, 'a session')
    )
  );

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_notify_session_message ON public.messages;
CREATE TRIGGER messages_notify_session_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_session_message();
REVOKE EXECUTE ON FUNCTION public.notify_session_message() FROM PUBLIC, anon, authenticated;
