-- Let users invalidate their own AI suggestions cache row.
--
-- Context: when a user changes the inputs that drive AI suggestions
-- (teaching skills, learning skills, bio, etc.) the cached row becomes
-- stale until its 6-hour TTL expires. Users would see suggestions like
-- "1 learner wants Python" long after removing Python from their teaching
-- skills. The fix is to delete the cache row on mutation so the next
-- dashboard load regenerates fresh.
--
-- The original migration (20260509000000_ai_suggestions.sql) only allowed
-- SELECT on own rows; writes were reserved for the Edge Function via the
-- service role. Adding a DELETE-own policy keeps that write boundary
-- (users still can't insert/update — only the function can produce
-- suggestions) while giving them the one self-service operation they
-- legitimately need: discarding stale data about themselves.

CREATE POLICY ai_suggestions_delete_own
  ON public.ai_suggestions
  FOR DELETE
  USING (auth.uid() = user_id);
