-- =============================================================================
-- Add pending_review and disputed to the session_status enum.
--
-- These two new states are the backbone of the attendance-based settlement
-- introduced in the next migration:
--   pending_review — scheduled end has passed; system is waiting 24h for
--                    either party to confirm before auto-settling from
--                    attendance evidence.
--   disputed       — a participant clicked "Something's wrong" during the
--                    review window. Escrow is frozen until an admin resolves
--                    the dispute.
--
-- This migration only adds the enum values. The functions and triggers that
-- transition sessions into/out of these states live in the next migration
-- (20260512060000_session_review_and_settlement.sql). They must be in
-- separate migration files because Postgres prohibits using a new enum
-- value in the same transaction that added it, even when only referenced
-- inside function bodies that compile-check the type at definition time.
-- =============================================================================

ALTER TYPE public.session_status ADD VALUE IF NOT EXISTS 'pending_review';
ALTER TYPE public.session_status ADD VALUE IF NOT EXISTS 'disputed';
