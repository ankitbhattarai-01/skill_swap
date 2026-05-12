-- Lock review identity and timestamps away from browser writes.
--
-- Users can create a review for a completed session and edit only the rating
-- or comment inside the existing 24-hour policy window. The database owns the
-- row id, timestamps, and reviewer/reviewee/session relationship after insert.

REVOKE INSERT, UPDATE ON public.reviews FROM anon, authenticated;
GRANT INSERT (
  session_id,
  reviewer_id,
  reviewee_id,
  rating,
  comment
) ON public.reviews TO authenticated;
GRANT UPDATE (rating, comment) ON public.reviews TO authenticated;
CREATE OR REPLACE FUNCTION public.protect_review_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR OLD.reviewer_id IS DISTINCT FROM NEW.reviewer_id
     OR OLD.reviewee_id IS DISTINCT FROM NEW.reviewee_id
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
DROP TRIGGER IF EXISTS reviews_protect_integrity ON public.reviews;
CREATE TRIGGER reviews_protect_integrity
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.protect_review_integrity();
REVOKE EXECUTE ON FUNCTION public.protect_review_integrity() FROM PUBLIC, anon, authenticated;
