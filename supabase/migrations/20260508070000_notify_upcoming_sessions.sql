-- Notify both parties ~10 minutes before a scheduled session starts.
--
-- The function finds accepted sessions whose scheduled_at is within the next
-- 10 minutes and inserts a 'session_starting' notification for the learner and
-- the teacher. It is idempotent: a NOT EXISTS check prevents the same session
-- from generating duplicate notifications across multiple callers.
--
-- Called fire-and-forget from the dashboard load, the same way
-- auto_complete_due_sessions runs. No background scheduler required.

CREATE OR REPLACE FUNCTION public.notify_upcoming_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_skill_name TEXT;
  v_minutes integer;
  v_count integer := 0;
BEGIN
  FOR v_session IN
    SELECT *
    FROM public.sessions
    WHERE status = 'accepted'
      AND escrow_held = true
      AND scheduled_at IS NOT NULL
      AND scheduled_at > now()
      AND scheduled_at <= now() + INTERVAL '10 minutes'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.notifications
      WHERE type = 'session_starting'
        AND metadata->>'session_id' = v_session.id::text
    ) THEN
      CONTINUE;
    END IF;

    SELECT name INTO v_skill_name FROM public.skills WHERE id = v_session.skill_id;
    v_minutes := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_session.scheduled_at - now())) / 60)
    )::int;

    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      v_session.learner_id,
      'session_starting',
      'Your ' || COALESCE(v_skill_name, 'session') || ' starts in ' || v_minutes || ' min',
      'Join the call when you''re ready.',
      '/video/' || v_session.id,
      jsonb_build_object('session_id', v_session.id, 'minutes_until', v_minutes)
    );

    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      v_session.teacher_id,
      'session_starting',
      'Your ' || COALESCE(v_skill_name, 'session') || ' starts in ' || v_minutes || ' min',
      'Join the call when you''re ready.',
      '/video/' || v_session.id,
      jsonb_build_object('session_id', v_session.id, 'minutes_until', v_minutes)
    );

    v_count := v_count + 2;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_upcoming_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_upcoming_sessions() TO authenticated;
