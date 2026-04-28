-- =============================================================================
-- Moderation Phase 1: review safety + report rate-limits + fixed report reasons
-- =============================================================================

-- ─── Review comment safety ───────────────────────────────────────────────────
-- 1) Length cap (DB-level so future UI is safe by default)
ALTER TABLE public.reviews
  DROP CONSTRAINT IF EXISTS reviews_comment_length;
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_comment_length
  CHECK (comment IS NULL OR char_length(comment) <= 500);
-- 2) Anti-circumvention filter on review comments (same rules as chat messages).
CREATE OR REPLACE FUNCTION public.check_review_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_phone_match TEXT;
  v_digits      TEXT;
BEGIN
  IF NEW.comment IS NULL OR length(trim(NEW.comment)) = 0 THEN
    RETURN NEW;
  END IF;

  v_phone_match := substring(NEW.comment FROM '\+?[0-9][0-9\s\.\-\(\)]{6,}[0-9]');
  IF v_phone_match IS NOT NULL THEN
    v_digits := regexp_replace(v_phone_match, '[^0-9]', '', 'g');
    IF length(v_digits) BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reviews cannot include phone numbers. Keep contact on SkillSwap.';
    END IF;
  END IF;

  IF NEW.comment ~* '(zoom\.us|zoom\.com|zoomgov\.com|meet\.google\.com|g\.co/meet|teams\.microsoft\.com|teams\.live\.com|webex\.com|skype\.com|whereby\.com|jitsi\.org|meet\.jit\.si|hangouts\.google\.com|discord\.gg|discord\.com|tencentmeeting\.com|voov\.com|wherever\.video)' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Reviews cannot include external meeting links.';
  END IF;

  IF NEW.comment ~* '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Reviews cannot include email addresses.';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reviews_check_safe_insert ON public.reviews;
CREATE TRIGGER reviews_check_safe_insert
  BEFORE INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.check_review_safe();
DROP TRIGGER IF EXISTS reviews_check_safe_update ON public.reviews;
CREATE TRIGGER reviews_check_safe_update
  BEFORE UPDATE OF comment ON public.reviews
  FOR EACH ROW
  WHEN (NEW.comment IS DISTINCT FROM OLD.comment)
  EXECUTE FUNCTION public.check_review_safe();
REVOKE EXECUTE ON FUNCTION public.check_review_safe() FROM PUBLIC, anon, authenticated;
-- ─── Reports: fixed reason values ────────────────────────────────────────────
-- Backfill any legacy free-text reasons before locking the column.
UPDATE public.reports
SET reason = 'other'
WHERE reason NOT IN (
  'harassment_or_abuse',
  'spam',
  'inappropriate_content',
  'contact_off_platform',
  'no_show_or_unresponsive',
  'scam_or_fraud',
  'impersonation',
  'other'
);
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_reason_allowed;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_reason_allowed
  CHECK (reason IN (
    'harassment_or_abuse',
    'spam',
    'inappropriate_content',
    'contact_off_platform',
    'no_show_or_unresponsive',
    'scam_or_fraud',
    'impersonation',
    'other'
  ));
-- ─── Reports: details length cap ─────────────────────────────────────────────
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_details_length;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_details_length
  CHECK (details IS NULL OR char_length(details) <= 1000);
-- ─── Reports: rate-limit + abuse guards ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_report_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count_24h    INT;
  v_count_target INT;
BEGIN
  -- Block self-reports
  IF NEW.reported_user_id IS NOT NULL AND NEW.reported_user_id = NEW.reporter_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You cannot report yourself.';
  END IF;

  -- Require finished onboarding (cuts down throwaway-account abuse)
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = NEW.reporter_id AND onboarded = true
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Finish onboarding before submitting reports.';
  END IF;

  -- Per-reporter cap: 5 reports / 24 hours
  SELECT COUNT(*) INTO v_count_24h
  FROM public.reports
  WHERE reporter_id = NEW.reporter_id
    AND created_at > now() - interval '24 hours';
  IF v_count_24h >= 5 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You have reached the daily report limit. Try again later.';
  END IF;

  -- Per-target cap: 3 reports against the same user / 7 days
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
