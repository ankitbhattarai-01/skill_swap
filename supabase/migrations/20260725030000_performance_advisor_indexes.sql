-- =============================================================================
-- Supabase performance advisor cleanup: 0001 (unindexed foreign keys) and
-- 0005 (unused index).
--
-- Both lints are INFO, and both are easy to "fix" in a way that makes the
-- database worse — 0001 by adding indexes nothing will ever read, 0005 by
-- dropping the ones that keep cascading deletes off a sequential scan. The
-- rule applied here:
--
--   * Add a covering index only where the FK is genuinely uncovered AND the
--     parent row can actually be deleted (every one below cascades).
--   * Drop an index only where the planner provably cannot use it. An index
--     that is merely young and unexercised stays.
--
-- Net: 5 indexes added, 2 dropped, 4 kept with the reason recorded in §3.
-- =============================================================================


-- ─── 1. Lint 0001 — covering indexes for foreign keys ────────────────────────
--
-- Postgres can only satisfy a single-column lookup from a composite index when
-- that column is the leading prefix. Each table below already has a composite
-- index or unique constraint that *mentions* the FK column but does not lead
-- with it, so the referential-integrity check on a parent delete falls back to
-- a sequential scan of the child table.
--
-- These are all small, append-mostly tables, so the write-time cost of an extra
-- index is negligible next to a full scan per deleted parent row.

-- practice_progress.skill_id → skills(id) ON DELETE CASCADE.
-- Covered only by UNIQUE (user_id, skill_id, level) — user_id leads.
-- Retiring a skill from the curated catalog cascades through every user's
-- practice counters for it.
CREATE INDEX IF NOT EXISTS practice_progress_skill_idx
  ON public.practice_progress (skill_id);

-- recording_consent_signals.from_user_id → auth.users(id) ON DELETE CASCADE.
-- Covered only by (session_id, created_at DESC) — session_id leads.
-- Account deletion has to find every consent event the user emitted.
CREATE INDEX IF NOT EXISTS recording_consent_signals_from_user_idx
  ON public.recording_consent_signals (from_user_id);

-- session_notes.requested_by → auth.users(id) ON DELETE CASCADE.
-- The table's only index is on session_id.
CREATE INDEX IF NOT EXISTS session_notes_requested_by_idx
  ON public.session_notes (requested_by);

-- skill_verification_attempts.skill_id → skills(id) ON DELETE CASCADE.
-- Covered only by (user_id, skill_id, created_at DESC) — user_id leads.
CREATE INDEX IF NOT EXISTS skill_verification_attempts_skill_idx
  ON public.skill_verification_attempts (skill_id);

-- skill_verifications.attempt_id → skill_verification_attempts(id)
-- ON DELETE SET NULL. This is the one that bites soonest: SET NULL means every
-- attempt row deleted (cleanup of expired sittings) scans skill_verifications
-- looking for badges pointing at it.
CREATE INDEX IF NOT EXISTS skill_verifications_attempt_idx
  ON public.skill_verifications (attempt_id);


-- ─── 2. Lint 0005 — drop the two indexes the planner cannot use ──────────────
--
-- These were created by 20260524010000 and already dropped once, by
-- 20260526040000, for the reason restated below. They are back because
-- 20260524010000 was applied to production *after* the migration that dropped
-- them, re-creating both. §4 removes them from that file so a future re-apply
-- cannot resurrect them a third time.
--
-- Why they are unusable rather than just unused: move_due_sessions_to_review()
-- selects due rows with a single OR spanning both partial predicates —
--
--     (scheduled_at IS NOT NULL AND now() > scheduled_at + ...)
--     OR (scheduled_at IS NULL AND now() > updated_at + INTERVAL '7 days')
--
-- — so neither partial index matches the whole qual, and the planner takes a
-- sequential scan over sessions regardless. Keeping them costs an index write
-- on every session insert and status change and buys nothing.
--
-- The alternative would be rewriting the sweeper as a UNION ALL of two
-- index-matched branches. That is a real option once sessions is large enough
-- for the seq scan to hurt, but it changes a cron-driven function that moves
-- money-adjacent escrow state, so it is deliberately not bundled into a lint
-- cleanup.

DROP INDEX IF EXISTS public.sessions_review_scheduled_due_idx;
DROP INDEX IF EXISTS public.sessions_review_unscheduled_due_idx;


-- ─── 3. Lint 0005 — the four indexes deliberately kept ───────────────────────
--
-- Recorded here so the next person reading the advisor does not "finish the
-- job" by dropping them.
--
--   * conversations_user_high_idx — exists precisely to cover the user_high FK
--     (migration 20260531010000, in response to lint 0001). Dropping it trades
--     an INFO 0005 for an INFO 0001 plus a seq scan on every account deletion.
--
--   * skill_verifications_skill_idx — covers skill_verifications.skill_id →
--     skills(id). Note skill_id is absent from the current 0001 report *because*
--     this index exists; only attempt_id is flagged. Same trade as above.
--
--   * recording_consent_signals_session_idx — covers the session_id FK, and
--     backs the participant read path that gates the realtime changefeed. Reads
--     land here as soon as anyone uses two-sided recording consent.
--
--   * session_email_deliveries_status_idx — backs the support triage query
--     ("which session emails failed today?"), run by hand from the SQL editor.
--     Unused so far only because nothing has needed triaging; the table takes
--     one row per notification email, so the index is nearly free.


-- ─── 4. Stop the dead indexes coming back ────────────────────────────────────
--
-- Handled as a source edit to 20260524010000 rather than SQL — see that file's
-- section 2. Nothing to execute here.

NOTIFY pgrst, 'reload schema';
