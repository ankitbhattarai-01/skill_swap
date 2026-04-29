-- Phase 3: 24h review edit window + report-a-review.

-- ─── Reviews: edit window ────────────────────────────────────────────────────
ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
-- Authors can edit their own review only within 24 hours of creation.
DROP POLICY IF EXISTS "Authors edit own review within 24h" ON public.reviews;
CREATE POLICY "Authors edit own review within 24h" ON public.reviews
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = reviewer_id
    AND created_at > now() - interval '24 hours'
  )
  WITH CHECK (
    auth.uid() = reviewer_id
    AND created_at > now() - interval '24 hours'
  );
-- Stamp edited_at automatically when comment or rating changes.
CREATE OR REPLACE FUNCTION public.touch_review_edited_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.comment IS DISTINCT FROM OLD.comment OR NEW.rating IS DISTINCT FROM OLD.rating THEN
    NEW.edited_at = now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reviews_touch_edited_at ON public.reviews;
CREATE TRIGGER reviews_touch_edited_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_review_edited_at();
REVOKE EXECUTE ON FUNCTION public.touch_review_edited_at() FROM PUBLIC, anon, authenticated;
-- ─── Reports: target a review ────────────────────────────────────────────────
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS review_id UUID REFERENCES public.reviews(id) ON DELETE SET NULL;
-- Replace the "must reference at least one target" check to include review_id.
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_check;
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_at_least_one_target;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_at_least_one_target
  CHECK (
    reported_user_id IS NOT NULL
    OR session_id IS NOT NULL
    OR message_id IS NOT NULL
    OR review_id IS NOT NULL
  );
CREATE INDEX IF NOT EXISTS reports_review_idx
  ON public.reports (review_id);
