-- Regression fix: account deletion was blocked by the message integrity guard.
--
-- messages.sender_id is ON DELETE SET NULL (20260508080000), so deleting a user
-- tombstones their messages by nulling sender_id. 20260512140000 taught
-- protect_message_integrity() to allow that one-way sender_id -> NULL transition.
-- The chat-decouple migration (20260530000000) redefined the function and dropped
-- that exception, so deleting a user now raises:
--   "Message ownership, timestamps, and attachments cannot be changed."
--
-- This restores the tombstone exception while keeping the conversation_id and
-- attachment immutability checks introduced in 20260530000000.

CREATE OR REPLACE FUNCTION public.protect_message_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sender_tombstone BOOLEAN :=
    OLD.sender_id IS NOT NULL
    AND NEW.sender_id IS NULL;
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR (OLD.sender_id IS DISTINCT FROM NEW.sender_id AND NOT v_sender_tombstone)
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.attachment_path IS DISTINCT FROM NEW.attachment_path
     OR OLD.attachment_kind IS DISTINCT FROM NEW.attachment_kind
     OR OLD.attachment_name IS DISTINCT FROM NEW.attachment_name
     OR OLD.attachment_size IS DISTINCT FROM NEW.attachment_size
     OR OLD.attachment_mime IS DISTINCT FROM NEW.attachment_mime THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Message ownership, timestamps, and attachments cannot be changed.';
  END IF;

  IF NEW.text IS DISTINCT FROM OLD.text THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.protect_message_integrity() FROM PUBLIC, anon, authenticated;
