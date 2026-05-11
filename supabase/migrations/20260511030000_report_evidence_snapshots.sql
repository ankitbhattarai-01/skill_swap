-- Preserve evidence when reports are filed.
--
-- Before: reports just held foreign keys to messages/reviews. A reported user
-- could edit or delete the offending content before a moderator looked at it,
-- and ON DELETE SET NULL erased the link entirely. The admin queue then read
-- whatever live text remained, leaving moderators with nothing to act on
-- (SEC-006 in the audit).
--
-- After:
--   1. Reports gain three snapshot columns captured at insert time
--      (message_text_snapshot, review_comment_snapshot, review_rating_snapshot).
--   2. A BEFORE INSERT trigger populates the snapshots from whatever the
--      report points at.
--   3. A BEFORE DELETE trigger on messages and reviews blocks hard deletes
--      while any report against that row is still open or under review. The
--      author can still edit (and the snapshot keeps the original text), but
--      they can't make the row vanish out from under a moderator.
--   4. get_admin_report_queue prefers live text, falling back to the snapshot
--      so deleted/edited content still surfaces in the queue.

-- 1. Snapshot columns
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS message_text_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS review_comment_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS review_rating_snapshot INT;
-- 2. Capture-on-insert trigger. Uses SECURITY DEFINER so the reporter can
-- snapshot the content of a message/review they would not normally be able
-- to read in full (e.g. a review by someone else). The lookup is keyed to
-- the row the report already references, so no broader access is opened.
CREATE OR REPLACE FUNCTION public.snapshot_report_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.message_id IS NOT NULL AND NEW.message_text_snapshot IS NULL THEN
    SELECT text
    INTO NEW.message_text_snapshot
    FROM public.messages
    WHERE id = NEW.message_id;
  END IF;

  IF NEW.review_id IS NOT NULL
     AND (NEW.review_comment_snapshot IS NULL OR NEW.review_rating_snapshot IS NULL) THEN
    SELECT comment, rating
    INTO NEW.review_comment_snapshot, NEW.review_rating_snapshot
    FROM public.reviews
    WHERE id = NEW.review_id;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reports_snapshot_evidence ON public.reports;
CREATE TRIGGER reports_snapshot_evidence
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_report_evidence();
REVOKE EXECUTE ON FUNCTION public.snapshot_report_evidence() FROM PUBLIC, anon, authenticated;
-- 3. Block hard delete of reported messages while the report is unresolved.
CREATE OR REPLACE FUNCTION public.block_delete_if_reported()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    IF EXISTS (
      SELECT 1 FROM public.reports
      WHERE message_id = OLD.id
        AND status IN ('open', 'reviewing')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'This message has an open report and cannot be deleted until moderators review it.';
    END IF;
  ELSIF TG_TABLE_NAME = 'reviews' THEN
    IF EXISTS (
      SELECT 1 FROM public.reports
      WHERE review_id = OLD.id
        AND status IN ('open', 'reviewing')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'This review has an open report and cannot be deleted until moderators review it.';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS messages_block_delete_if_reported ON public.messages;
CREATE TRIGGER messages_block_delete_if_reported
  BEFORE DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_if_reported();
DROP TRIGGER IF EXISTS reviews_block_delete_if_reported ON public.reviews;
CREATE TRIGGER reviews_block_delete_if_reported
  BEFORE DELETE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_if_reported();
REVOKE EXECUTE ON FUNCTION public.block_delete_if_reported() FROM PUBLIC, anon, authenticated;
-- 4. Admin queue prefers live text, falls back to the snapshot so deleted
-- or edited content still has something to display.
CREATE OR REPLACE FUNCTION public.get_admin_report_queue(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  reporter_id UUID,
  reported_user_id UUID,
  session_id UUID,
  message_id UUID,
  review_id UUID,
  reporter_name TEXT,
  reported_user_name TEXT,
  message_preview TEXT,
  review_preview TEXT,
  session_skill TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin(v_actor) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Only admins can view the moderation queue.';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.reason,
    r.details,
    r.status,
    r.created_at,
    r.reporter_id,
    r.reported_user_id,
    r.session_id,
    r.message_id,
    r.review_id,
    reporter.full_name AS reporter_name,
    reported.full_name AS reported_user_name,
    COALESCE(m.text, r.message_text_snapshot) AS message_preview,
    CASE
      WHEN rv.id IS NOT NULL
        THEN concat(rv.rating::TEXT, '/5 ', COALESCE(rv.comment, ''))
      WHEN r.review_rating_snapshot IS NOT NULL
        THEN concat(r.review_rating_snapshot::TEXT, '/5 ',
                    COALESCE(r.review_comment_snapshot, ''))
      ELSE NULL
    END AS review_preview,
    sk.name AS session_skill
  FROM public.reports r
  LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
  LEFT JOIN public.profiles reported ON reported.id = r.reported_user_id
  LEFT JOIN public.messages m ON m.id = r.message_id
  LEFT JOIN public.reviews rv ON rv.id = r.review_id
  LEFT JOIN public.sessions s ON s.id = COALESCE(r.session_id, m.session_id, rv.session_id)
  LEFT JOIN public.skills sk ON sk.id = s.skill_id
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;
