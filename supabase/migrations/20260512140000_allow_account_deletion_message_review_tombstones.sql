-- Account deletion preserves shared history by setting user FKs to NULL.
-- Integrity triggers should still block ownership/identity edits from the
-- application, but allow those one-way tombstones from ON DELETE SET NULL.

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
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR (OLD.sender_id IS DISTINCT FROM NEW.sender_id AND NOT v_sender_tombstone)
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
CREATE OR REPLACE FUNCTION public.protect_review_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_reviewer_tombstone BOOLEAN :=
    OLD.reviewer_id IS NOT NULL
    AND NEW.reviewer_id IS NULL;
  v_reviewee_tombstone BOOLEAN :=
    OLD.reviewee_id IS NOT NULL
    AND NEW.reviewee_id IS NULL;
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR (OLD.reviewer_id IS DISTINCT FROM NEW.reviewer_id AND NOT v_reviewer_tombstone)
     OR (OLD.reviewee_id IS DISTINCT FROM NEW.reviewee_id AND NOT v_reviewee_tombstone)
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Review identity and timestamps cannot be changed.';
  END IF;

  IF NEW.comment IS DISTINCT FROM OLD.comment OR NEW.rating IS DISTINCT FROM OLD.rating THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.protect_message_integrity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_review_integrity() FROM PUBLIC, anon, authenticated;
