-- Harden report creation.
--
-- Browser clients should only supply the report target and free-form details.
-- Reporter identity, status, and timestamps are trusted fields owned by the
-- database. The trigger also verifies that contextual targets are actually
-- related to the reporter so moderation cannot be polluted with forged IDs.

ALTER TABLE public.reports
  ALTER COLUMN reporter_id SET DEFAULT auth.uid();
REVOKE INSERT, UPDATE ON public.reports FROM anon, authenticated;
GRANT INSERT (
  reported_user_id,
  session_id,
  message_id,
  review_id,
  reason,
  details
) ON public.reports TO authenticated;
GRANT UPDATE (status) ON public.reports TO authenticated;
DROP POLICY IF EXISTS "Users create their own reports" ON public.reports;
CREATE POLICY "Users create their own reports" ON public.reports
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = reporter_id
    AND status = 'open'
  );
CREATE OR REPLACE FUNCTION public.check_report_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_count_24h INT;
  v_count_target INT;
  v_message RECORD;
  v_review RECORD;
  v_session RECORD;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Log in before submitting reports.';
  END IF;

  IF NEW.message_id IS NOT NULL AND NEW.review_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Report one item at a time.';
  END IF;

  NEW.reporter_id := v_actor;
  NEW.status := 'open';
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.details := NULLIF(btrim(NEW.details), '');

  IF NEW.reported_user_id IS NULL
     AND NEW.session_id IS NULL
     AND NEW.message_id IS NULL
     AND NEW.review_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Choose something to report.';
  END IF;

  IF NEW.message_id IS NOT NULL THEN
    SELECT
      m.session_id,
      m.sender_id,
      s.teacher_id,
      s.learner_id
    INTO v_message
    FROM public.messages m
    JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.message_id
      AND (s.teacher_id = v_actor OR s.learner_id = v_actor);

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported message was not found or is not visible to you.';
    END IF;

    IF NEW.session_id IS NOT NULL AND NEW.session_id <> v_message.session_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported message does not belong to that session.';
    END IF;

    NEW.session_id := COALESCE(NEW.session_id, v_message.session_id);

    IF v_message.sender_id IS NOT NULL THEN
      IF NEW.reported_user_id IS NULL THEN
        NEW.reported_user_id := v_message.sender_id;
      ELSIF NEW.reported_user_id <> v_message.sender_id THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Reported user must match the message sender.';
      END IF;
    END IF;
  END IF;

  IF NEW.review_id IS NOT NULL THEN
    SELECT
      r.session_id,
      r.reviewer_id,
      r.reviewee_id
    INTO v_review
    FROM public.reviews r
    WHERE r.id = NEW.review_id
      AND (
        r.reviewer_id = v_actor
        OR r.created_at < now() - interval '14 days'
        OR EXISTS (
          SELECT 1
          FROM public.reviews r2
          WHERE r2.session_id = r.session_id
            AND r2.reviewer_id = r.reviewee_id
            AND r2.reviewee_id = r.reviewer_id
        )
      );

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported review was not found or is not visible to you.';
    END IF;

    IF NEW.session_id IS NOT NULL AND NEW.session_id <> v_review.session_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported review does not belong to that session.';
    END IF;

    IF v_review.reviewer_id IS NOT NULL THEN
      IF NEW.reported_user_id IS NULL THEN
        NEW.reported_user_id := v_review.reviewer_id;
      ELSIF NEW.reported_user_id <> v_review.reviewer_id THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Reported user must match the review author.';
      END IF;
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    SELECT
      s.teacher_id,
      s.learner_id
    INTO v_session
    FROM public.sessions s
    WHERE s.id = NEW.session_id
      AND (s.teacher_id = v_actor OR s.learner_id = v_actor);

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported session was not found or is not visible to you.';
    END IF;

    IF NEW.reported_user_id IS NULL THEN
      NEW.reported_user_id := CASE
        WHEN v_session.teacher_id = v_actor THEN v_session.learner_id
        WHEN v_session.learner_id = v_actor THEN v_session.teacher_id
        ELSE NULL
      END;
    ELSIF NOT (
      NEW.reported_user_id IS NOT DISTINCT FROM v_session.teacher_id
      OR NEW.reported_user_id IS NOT DISTINCT FROM v_session.learner_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported user must be part of the reported session.';
    END IF;
  END IF;

  IF NEW.reported_user_id IS NOT NULL AND NEW.reported_user_id = NEW.reporter_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You cannot report yourself.';
  END IF;

  IF NEW.reported_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles
       WHERE id = NEW.reported_user_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Reported user was not found.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = NEW.reporter_id AND onboarded = true
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Finish onboarding before submitting reports.';
  END IF;

  SELECT COUNT(*) INTO v_count_24h
  FROM public.reports
  WHERE reporter_id = NEW.reporter_id
    AND created_at > now() - interval '24 hours';
  IF v_count_24h >= 5 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You have reached the daily report limit. Try again later.';
  END IF;

  IF NEW.reported_user_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count_target
    FROM public.reports
    WHERE reporter_id = NEW.reporter_id
      AND reported_user_id = NEW.reported_user_id
      AND created_at > now() - interval '7 days';
    IF v_count_target >= 3 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'You have already reported this user multiple times this week. A moderator will review the existing reports.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reports_check_safe_insert ON public.reports;
CREATE TRIGGER reports_check_safe_insert
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.check_report_safe();
REVOKE EXECUTE ON FUNCTION public.check_report_safe() FROM PUBLIC, anon, authenticated;
