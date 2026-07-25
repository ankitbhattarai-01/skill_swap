-- =============================================================================
-- Drop two indexes that duplicate the leading prefix of an existing UNIQUE
-- constraint. Neither is flagged by the Supabase advisor — lint 0005 only
-- reports indexes with zero scans, and both of these are being scanned. They
-- are still pure overhead: every scan they serve, the unique index serves
-- equally well.
--
-- Postgres can use a composite index for a lookup on its leading column, so a
-- standalone index on that same leading column adds nothing a query can reach.
-- It only adds a second B-tree to maintain on every insert and update.
--
--   1. practice_progress_user_idx (user_id)
--      duplicated by practice_progress_user_id_skill_id_level_key
--                    UNIQUE (user_id, skill_id, level)
--      The only reader is the "read own practice progress" policy and the stat
--      cards, both of which filter on user_id alone — served by the unique
--      index's leading column.
--
--   2. skill_verifications_user_idx (user_id)
--      duplicated by skill_verifications_user_id_skill_id_key
--                    UNIQUE (user_id, skill_id)
--      The only reader is "which badges does this profile have", filtering on
--      user_id alone — same story.
--
-- Not touched, because they are NOT redundant: skill_verifications_skill_idx
-- and practice_progress_skill_idx both index the *second* column of their
-- table's unique constraint, which no index leads with. They are the FK
-- covering indexes added by 20260725030000.
--
-- Reversing this is two CREATE INDEX statements if a future query ever wants a
-- narrower index than the unique one.
-- =============================================================================

DROP INDEX IF EXISTS public.practice_progress_user_idx;
DROP INDEX IF EXISTS public.skill_verifications_user_idx;

NOTIFY pgrst, 'reload schema';
