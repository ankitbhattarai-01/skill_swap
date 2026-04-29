-- Phase 2: blind review window.
-- A review on a session is hidden from everyone (public + the reviewee) until:
--   * the counterpart review (reviewee->reviewer) has been submitted, OR
--   * 14 days have passed since the review was created.
-- The author can always see their own review immediately so they know it was saved.

DROP POLICY IF EXISTS "Reviews are publicly viewable" ON public.reviews;
-- Authors can always see their own reviews (regardless of maturity).
DROP POLICY IF EXISTS "Authors view own reviews" ON public.reviews;
CREATE POLICY "Authors view own reviews" ON public.reviews
  FOR SELECT TO authenticated
  USING (auth.uid() = reviewer_id);
-- Anyone (including anonymous visitors) can see matured reviews only.
-- "Matured" = older than 14 days OR a counter-review exists in the same session.
DROP POLICY IF EXISTS "Public views matured reviews" ON public.reviews;
CREATE POLICY "Public views matured reviews" ON public.reviews
  FOR SELECT
  USING (
    created_at < now() - interval '14 days'
    OR EXISTS (
      SELECT 1 FROM public.reviews r2
      WHERE r2.session_id = reviews.session_id
        AND r2.reviewer_id = reviews.reviewee_id
        AND r2.reviewee_id = reviews.reviewer_id
    )
  );
-- Index helps the EXISTS subquery in the visibility check.
CREATE INDEX IF NOT EXISTS reviews_session_pair_idx
  ON public.reviews (session_id, reviewer_id, reviewee_id);
