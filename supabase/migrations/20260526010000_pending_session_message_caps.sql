-- Pre-acceptance messaging with daily caps.
--
-- Before: messages were locked to accepted/active sessions only
-- (migration 20260511020000, SEC-002). That avoided unsolicited contact
-- but also meant learner and teacher had no way to clarify scope,
-- timing, or level before the teacher committed — driving cancellations
-- and strikes that the team wants to reduce.
--
-- After: messages may also be sent on pending sessions, but subject to
-- two caps enforced server-side so a flat policy can't be bypassed:
--   1. Daily cap: 15 messages per sender per UTC day across all pending
--      sessions. Counter resets at 00:00 UTC.
--   2. Unanswered cap: at most 5 messages to a recipient who has not
--      sent any reply in the same pending session. Resets the moment
--      the recipient replies.
-- Once a session is accepted/active, neither cap applies — quotas only
-- gate the pre-acceptance window.

DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('pending', 'accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_pending_message_caps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_teacher uuid;
  v_learner uuid;
  v_recipient uuid;
  v_daily_count int;
  v_unanswered_count int;
BEGIN
  SELECT status, teacher_id, learner_id
  INTO v_status, v_teacher, v_learner
  FROM public.sessions
  WHERE id = NEW.session_id;

  IF v_status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  v_recipient := CASE
    WHEN NEW.sender_id = v_teacher THEN v_learner
    ELSE v_teacher
  END;

  SELECT COUNT(*) INTO v_daily_count
  FROM public.messages m
  JOIN public.sessions s ON s.id = m.session_id
  WHERE m.sender_id = NEW.sender_id
    AND s.status = 'pending'
    AND m.created_at >= date_trunc('day', timezone('UTC', now()));

  IF v_daily_count >= 15 THEN
    RAISE EXCEPTION 'Daily message limit reached (15). Resets at midnight UTC.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.messages m2
    WHERE m2.session_id = NEW.session_id
      AND m2.sender_id = v_recipient
  ) THEN
    SELECT COUNT(*) INTO v_unanswered_count
    FROM public.messages m3
    WHERE m3.session_id = NEW.session_id
      AND m3.sender_id = NEW.sender_id;

    IF v_unanswered_count >= 5 THEN
      RAISE EXCEPTION 'You can send up to 5 messages before they reply.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_pending_message_caps() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_pending_message_caps ON public.messages;
CREATE TRIGGER enforce_pending_message_caps
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_message_caps();

CREATE OR REPLACE FUNCTION public.my_pending_message_quota()
RETURNS TABLE(used int, daily_limit int, reset_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((
      SELECT COUNT(*)::int
      FROM public.messages m
      JOIN public.sessions s ON s.id = m.session_id
      WHERE m.sender_id = auth.uid()
        AND s.status = 'pending'
        AND m.created_at >= date_trunc('day', timezone('UTC', now()))
    ), 0) AS used,
    15 AS daily_limit,
    (date_trunc('day', timezone('UTC', now())) + INTERVAL '1 day') AS reset_at;
$$;

GRANT EXECUTE ON FUNCTION public.my_pending_message_quota() TO authenticated;
