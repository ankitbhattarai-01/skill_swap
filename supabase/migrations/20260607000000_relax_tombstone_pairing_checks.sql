-- Regression fix: account deletion was blocked by paired-null CHECK constraints.
--
-- Two tables carry an actor FK that is ON DELETE SET NULL alongside a CHECK that
-- forces the actor id and its timestamp to be both-null-or-both-set:
--   reschedule_proposals: responder_id  / responded_at  (20260512090000)
--   user_strikes:         revoked_by    / revoked_at    (20260512070000)
--
-- When a user is deleted, ON DELETE SET NULL nulls the actor id but leaves the
-- timestamp set, breaking the equality CHECK and aborting the whole delete with:
--   "new row for relation \"reschedule_proposals\" violates check constraint
--    \"reschedule_proposals_check\""
--
-- Relax each to the one-way invariant that still matters: a present actor id
-- requires its timestamp, but a NULL actor (a deleted-user tombstone) may keep
-- the timestamp. This still rejects the only nonsensical state — an actor with
-- no timestamp — while allowing the tombstone.

-- 1. reschedule_proposals: responder_id / responded_at -----------------------
DO $$
DECLARE
  v_conname text;
BEGIN
  -- Drop the old "both null or both set" pairing CHECK by its definition, so we
  -- don't depend on the auto-generated constraint name.
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.reschedule_proposals'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%responded_at%responder_id%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.reschedule_proposals DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.reschedule_proposals
  DROP CONSTRAINT IF EXISTS reschedule_proposals_responder_pairing_chk;
ALTER TABLE public.reschedule_proposals
  ADD CONSTRAINT reschedule_proposals_responder_pairing_chk
  CHECK (responder_id IS NULL OR responded_at IS NOT NULL);

-- 2. user_strikes: revoked_by / revoked_at ----------------------------------
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.user_strikes'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%revoked_at%revoked_by%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_strikes DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.user_strikes
  DROP CONSTRAINT IF EXISTS user_strikes_revoked_pairing_chk;
ALTER TABLE public.user_strikes
  ADD CONSTRAINT user_strikes_revoked_pairing_chk
  CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL);
