-- Keep message notifications in sync even for legacy rows created before
-- `messageId` was added to notification metadata.

CREATE OR REPLACE FUNCTION public.message_notification_matches_legacy(
  p_notification public.notifications,
  p_message public.messages
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    p_notification.type = 'message'
    AND NOT (p_notification.metadata ? 'messageId')
    AND p_notification.link = '/messages/' || p_message.session_id::text
    AND p_notification.metadata ->> 'sessionId' = p_message.session_id::text
    AND (
      p_message.sender_id IS NULL
      OR p_notification.metadata ->> 'senderId' = p_message.sender_id::text
    )
    AND p_notification.created_at >= p_message.created_at
    AND p_notification.created_at < p_message.created_at + interval '5 minutes';
$$;
CREATE OR REPLACE FUNCTION public.handle_message_deleted_notifications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.notifications n
  WHERE n.type = 'message'
    AND (
      n.metadata ->> 'messageId' = OLD.id::text
      OR (
        n.body = LEFT(OLD.text, 160)
        AND public.message_notification_matches_legacy(n, OLD)
      )
    );
  RETURN OLD;
END;
$$;
CREATE OR REPLACE FUNCTION public.handle_message_edited_notifications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.text IS DISTINCT FROM OLD.text THEN
    UPDATE public.notifications n
    SET body = LEFT(NEW.text, 160)
    WHERE n.type = 'message'
      AND (
        n.metadata ->> 'messageId' = NEW.id::text
        OR (
          n.body = LEFT(OLD.text, 160)
          AND public.message_notification_matches_legacy(n, NEW)
        )
      );
  END IF;
  RETURN NEW;
END;
$$;
-- One-time cleanup for legacy notifications whose source message disappeared
-- before `messageId` existed.
DELETE FROM public.notifications n
WHERE n.type = 'message'
  AND NOT (n.metadata ? 'messageId')
  AND n.metadata ? 'sessionId'
  AND n.metadata ? 'senderId'
  AND n.link = '/messages/' || (n.metadata ->> 'sessionId')
  AND NOT EXISTS (
    SELECT 1
    FROM public.messages m
    WHERE m.session_id::text = n.metadata ->> 'sessionId'
      AND (
        m.sender_id IS NULL
        OR m.sender_id::text = n.metadata ->> 'senderId'
      )
      AND n.body = LEFT(m.text, 160)
      AND n.created_at >= m.created_at
      AND n.created_at < m.created_at + interval '5 minutes'
  );
REVOKE EXECUTE ON FUNCTION public.message_notification_matches_legacy(
  public.notifications,
  public.messages
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_message_deleted_notifications() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_message_edited_notifications() FROM PUBLIC, anon, authenticated;
