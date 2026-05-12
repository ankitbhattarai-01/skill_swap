-- Lock message ownership and timestamps away from browser writes.
--
-- RLS already limits edits to the sender, but column privileges should also
-- enforce that clients can only create message content for a session and edit
-- the message text. The database owns id/created_at/edited_at and immutable
-- ownership fields after insert.

REVOKE INSERT, UPDATE ON public.messages FROM anon, authenticated;
GRANT INSERT (session_id, sender_id, text) ON public.messages TO authenticated;
GRANT UPDATE (text) ON public.messages TO authenticated;
CREATE OR REPLACE FUNCTION public.protect_message_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR OLD.sender_id IS DISTINCT FROM NEW.sender_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Message ownership and timestamps cannot be changed.';
  END IF;

  IF NEW.text IS DISTINCT FROM OLD.text THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_protect_integrity ON public.messages;
CREATE TRIGGER messages_protect_integrity
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.protect_message_integrity();
REVOKE EXECUTE ON FUNCTION public.protect_message_integrity() FROM PUBLIC, anon, authenticated;
