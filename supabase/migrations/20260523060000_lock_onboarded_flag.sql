-- =============================================================================
-- High #12 — Users can bypass onboarding.
--
-- profiles.onboarded was in the column-level UPDATE grant from
-- 20260509020000_lock_profile_credit_writes, so any authenticated user
-- could PATCH it to true from the browser console — instantly clearing
-- every "onboarded = true" gate in the codebase without ever picking a
-- skill, setting a name, or seeing the onboarding flow.
--
-- Affected gates today:
--   * report submission (20260507060000_moderation_phase1, 20260509040000)
--   * dashboard/explore visibility heuristics
--   * any future "onboarded users only" feature
--
-- Fix: remove `onboarded` from the authenticated INSERT/UPDATE column
-- grants and expose a SECURITY DEFINER RPC `complete_onboarding()` that
-- enforces the same preconditions the client UI already checks (full
-- name + at least one teaching or learning skill). The RPC is the only
-- path that can set onboarded = true; bypassing it is no longer just a
-- direct column write.
-- =============================================================================


-- ─── 1. Drop onboarded from the column-level grants ──────────────────────────
--
-- Postgres supports column-level REVOKE, so we can target onboarded
-- specifically without re-issuing the whole grant. The rest of the
-- columns from 20260509020000 stay writable.

REVOKE UPDATE (onboarded) ON public.profiles FROM anon, authenticated;
REVOKE INSERT (onboarded) ON public.profiles FROM anon, authenticated;
-- ─── 2. complete_onboarding RPC ──────────────────────────────────────────────
--
-- Verifies the preconditions the onboarding UI already enforces and
-- flips the flag atomically. The function is SECURITY DEFINER so it
-- runs as the owner (bypassing the revoked UPDATE grant) but uses
-- auth.uid() to decide whose row to touch — there is no parameter for
-- target user, so a caller cannot flip someone else's flag.
--
-- Returns the new onboarded state (always true on success) so the
-- client can update its local cache in one round-trip.

CREATE OR REPLACE FUNCTION public.complete_onboarding()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID := auth.uid();
  v_name     TEXT;
  v_has_skill BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT NULLIF(TRIM(full_name), '')
  INTO v_name
  FROM public.profiles
  WHERE id = v_caller;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Set a display name before completing onboarding.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Either path counts: teachers list at least one skill, learners list
  -- at least one. Mixed (collaboration) users typically have both.
  SELECT EXISTS (
    SELECT 1 FROM public.user_teaching_skills WHERE user_id = v_caller
    UNION ALL
    SELECT 1 FROM public.user_learning_skills WHERE user_id = v_caller
    LIMIT 1
  )
  INTO v_has_skill;

  IF NOT v_has_skill THEN
    RAISE EXCEPTION 'Pick at least one skill before completing onboarding.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.profiles
  SET onboarded = true
  WHERE id = v_caller;

  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.complete_onboarding() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding() TO authenticated;
