-- =============================================================================
-- Supabase performance advisor 0001 — "Unindexed foreign keys" for
-- public.conversations.conversations_user_high_fkey.
--
-- conversations already has a composite UNIQUE index on (user_low, user_high)
-- from conversations_pair_unique. That index covers the user_low FK (it is the
-- leading column) but NOT the user_high FK: Postgres can only use a composite
-- index for a single-column lookup when that column is a leading prefix, so a
-- delete/update on auth.users that cascades through user_high has no covering
-- index and falls back to a sequential scan.
--
-- Add a dedicated index on user_high. This is the same shape the advisor wants
-- and keeps ON DELETE CASCADE from auth.users cheap as the user base grows.
--
-- The remaining INFO-level "unused index" notices that are intentionally left in
-- place are: this user_high index and pending_message_send_log_conv_sender_idx,
-- which backs the chat send-cap queries and is simply not exercised yet on this
-- young database. The review-scheduling and learning-track partial indexes from
-- 20260524010000 were NOT kept -- they are dropped in 20260526040000 because the
-- planner cannot use them (OR-split sweeper query / redundant with the PK).
-- =============================================================================

CREATE INDEX IF NOT EXISTS conversations_user_high_idx
  ON public.conversations (user_high);

NOTIFY pgrst, 'reload schema';
