-- Fix infinite recursion (Postgres 42P17) on public.reviews.
--
-- Migration 20260508000000 created a "Public views matured reviews" policy
-- whose USING clause executes `SELECT 1 FROM public.reviews r2 WHERE ...`.
-- Postgres re-applies RLS to that inner select, so the same policy fires
-- recursively until the planner gives up. Every read of `reviews` (Explore
-- page teacher ratings, public profiles, etc.) hits 500.
--
-- Fix: extract the counter-review existence check into a SECURITY DEFINER
-- helper. Running as definer bypasses RLS for the inner query, breaking the
-- recursion. The helper lives in the `private` schema so PostgREST does not
-- expose it as an RPC (same pattern as 20260513170000).

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO anon, authenticated;

CREATE OR REPLACE FUNCTION private.review_counterpart_exists(
  p_session_id UUID,
  p_reviewer_id UUID,
  p_reviewee_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reviews
    WHERE session_id = p_session_id
      AND reviewer_id = p_reviewee_id
      AND reviewee_id = p_reviewer_id
  );
$$;

REVOKE EXECUTE ON FUNCTION
  private.review_counterpart_exists(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  private.review_counterpart_exists(UUID, UUID, UUID) TO anon, authenticated;

DROP POLICY IF EXISTS "Public views matured reviews" ON public.reviews;
CREATE POLICY "Public views matured reviews" ON public.reviews
  FOR SELECT
  USING (
    created_at < now() - interval '14 days'
    OR private.review_counterpart_exists(session_id, reviewer_id, reviewee_id)
  );

NOTIFY pgrst, 'reload schema';
