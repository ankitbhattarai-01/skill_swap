-- =============================================================================
-- Group sessions booked together ("a plan") with a shared batch_id.
--
-- When a learner books several sessions at once (the "Multiple sessions" flow),
-- each is an independent session row — but the UI wants to show them together:
-- all the times in one card, plus a completed/total progress bar. A nullable
-- batch_id is the minimal link for that. Single bookings leave it NULL and are
-- rendered individually, exactly as before.
--
-- This is display-only metadata: no FK, no lifecycle, no triggers. Each session
-- still accepts / escrows / settles entirely on its own.
-- =============================================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS batch_id UUID;

-- Look up all sessions in a plan quickly (history grouping + detail siblings).
CREATE INDEX IF NOT EXISTS sessions_batch_id_idx
  ON public.sessions (batch_id)
  WHERE batch_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
