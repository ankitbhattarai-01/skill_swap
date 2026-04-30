-- When a message is unsent or its text is edited, keep its message-notification in sync.
CREATE OR REPLACE FUNCTION public.handle_message_deleted_notifications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.notifications
  WHERE type = 'message'
    AND metadata ->> 'messageId' = OLD.id::text;
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
    UPDATE public.notifications
    SET body = LEFT(NEW.text, 160)
    WHERE type = 'message'
      AND metadata ->> 'messageId' = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_cleanup_notifications ON public.messages;
CREATE TRIGGER messages_cleanup_notifications
  AFTER DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_message_deleted_notifications();
DROP TRIGGER IF EXISTS messages_sync_edited_notifications ON public.messages;
CREATE TRIGGER messages_sync_edited_notifications
  AFTER UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_message_edited_notifications();
REVOKE EXECUTE ON FUNCTION public.handle_message_deleted_notifications() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_message_edited_notifications() FROM PUBLIC, anon, authenticated;
-- One-time cleanup: drop notifications that point to messages already unsent.
DELETE FROM public.notifications n
WHERE n.type = 'message'
  AND n.metadata ? 'messageId'
  AND NOT EXISTS (
    SELECT 1 FROM public.messages m WHERE m.id::text = n.metadata ->> 'messageId'
  );
