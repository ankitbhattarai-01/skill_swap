-- Add 20-minute sessions as a bookable length and retire 90 minutes from the
-- product. Three server-side gates previously hard-coded the allowed set to
-- (30, 60, 90) and would reject a 20-minute booking:
--   1. the sessions_duration_minutes_allowed CHECK constraint (20260508030000)
--   2. the "Participants create pending sessions" RLS INSERT policy
--      (20260509030000, tuned by 20260514000000)
--   3. private.propose_swap's length validation (20260612210000)
--
-- The UI (src/lib/sessions.ts SESSION_DURATIONS) now offers only 20/30/60, so 90
-- can no longer be booked anywhere. We keep 90 in the *accepted* set on the
-- server, though, so any session already booked at 90 minutes stays valid and
-- can still transition through its lifecycle (accept → complete). The set the
-- product hands out and the set the database tolerates are intentionally
-- different: {20,30,60} out, {20,30,60,90} in.

-- 1. CHECK constraint — widen to include 20 (and keep 90 for existing rows).
ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_duration_minutes_allowed;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_duration_minutes_allowed
  CHECK (duration_minutes IN (20, 30, 60, 90)) NOT VALID;

-- 2. RLS INSERT policy — WITH CHECK replaces the whole expression, so this
--    reproduces the clause verbatim (from 20260514000000) with the duration set
--    widened to include 20.
ALTER POLICY "Participants create pending sessions" ON public.sessions
  WITH CHECK (
    (select auth.uid()) IS NOT NULL
    AND (select auth.uid()) = initiator_id
    AND ((select auth.uid()) = learner_id OR (select auth.uid()) = teacher_id)
    AND learner_id IS NOT NULL
    AND teacher_id IS NOT NULL
    AND learner_id <> teacher_id
    AND status = 'pending'
    AND escrow_held = false
    AND credits > 0
    AND duration_minutes IN (20, 30, 60, 90)
  );

-- 3. Swap RPC — body copied verbatim from 20260612210000; the only change is the
--    duration validation (line raised from "30, 60, 90" to "20, 30, 60, 90" and
--    the error message updated).
CREATE OR REPLACE FUNCTION private.propose_swap(
  p_recipient_id      UUID,
  p_my_skill_id       UUID,          -- skill the proposer will TEACH
  p_my_duration       INT,
  p_my_scheduled_at   TIMESTAMPTZ,
  p_their_skill_id    UUID,          -- skill the recipient will TEACH
  p_their_duration    INT,
  p_their_scheduled_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposer     UUID := auth.uid();
  v_swap_id      UUID := gen_random_uuid();
  v_proposer_nm  TEXT;
  v_my_skill     TEXT;
  v_their_skill  TEXT;
BEGIN
  IF v_proposer IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_proposer = p_recipient_id THEN
    RAISE EXCEPTION 'You cannot swap with yourself';
  END IF;
  IF p_my_skill_id = p_their_skill_id THEN
    RAISE EXCEPTION 'Pick two different skills to swap';
  END IF;
  IF p_my_duration NOT IN (20, 30, 60, 90) OR p_their_duration NOT IN (20, 30, 60, 90) THEN
    RAISE EXCEPTION 'Session length must be 20, 30, or 60 minutes';
  END IF;
  -- Both legs must be scheduled in the future. The client constrains slots to
  -- the teacher's free windows, but a stale tab or direct API call could still
  -- send a past timestamp — which would create a session born outside its own
  -- join window and immediately swept to completed by the cron.
  IF p_my_scheduled_at IS NULL OR p_their_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'Pick a time for both sessions';
  END IF;
  IF p_my_scheduled_at <= now() OR p_their_scheduled_at <= now() THEN
    RAISE EXCEPTION 'Both swap sessions must be scheduled in the future';
  END IF;
  -- The same two people attend both legs, so the legs can't overlap in time —
  -- nobody can teach one session while learning in the other. Standard
  -- interval intersection on [start, start + duration).
  IF p_my_scheduled_at < p_their_scheduled_at + (p_their_duration * INTERVAL '1 minute')
     AND p_their_scheduled_at < p_my_scheduled_at + (p_my_duration * INTERVAL '1 minute') THEN
    RAISE EXCEPTION 'The two swap sessions overlap in time. You can''t teach and learn at once — pick times that don''t clash.';
  END IF;
  -- public.is_admin_suspended was dropped by 20260513100000; the helper now
  -- lives in `private` (same schema as this function).
  IF private.is_admin_suspended(v_proposer) THEN
    RAISE EXCEPTION 'Suspended users cannot propose swaps';
  END IF;

  -- The proposer must actually teach what they're offering, and the recipient
  -- must teach what's being requested — otherwise the swap is meaningless.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_teaching_skills
    WHERE user_id = v_proposer AND skill_id = p_my_skill_id
  ) THEN
    RAISE EXCEPTION 'You do not teach the skill you offered';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_teaching_skills
    WHERE user_id = p_recipient_id AND skill_id = p_their_skill_id
  ) THEN
    RAISE EXCEPTION 'They do not teach the skill you requested';
  END IF;

  -- Don't stack a second open swap on top of one already in flight with this
  -- person for the same skill pairing.
  IF EXISTS (
    SELECT 1 FROM public.sessions
    WHERE is_swap = true
      AND status IN ('pending', 'accepted', 'active')
      AND teacher_id = v_proposer AND learner_id = p_recipient_id
      AND skill_id = p_my_skill_id
  ) THEN
    RAISE EXCEPTION 'You already have a swap in progress with this person for that skill';
  END IF;

  -- Both legs in one block so a collision rolls back the pair atomically.
  -- Swap rows participate in the sessions_one_open_request_per_skill_time
  -- unique index (20260610000000), so a leg that double-books an existing open
  -- session for the same pair + skill + time raises 23505 — translate the raw
  -- "duplicate key" into something a user can act on.
  BEGIN
    -- Session A: proposer teaches their offered skill to the recipient.
    INSERT INTO public.sessions (
      teacher_id, learner_id, initiator_id, skill_id, status,
      duration_minutes, scheduled_at, is_swap, swap_id, credits
    ) VALUES (
      v_proposer, p_recipient_id, v_proposer, p_my_skill_id, 'pending',
      p_my_duration, p_my_scheduled_at, true, v_swap_id, 0
    );

    -- Session B: recipient teaches their offered skill to the proposer.
    INSERT INTO public.sessions (
      teacher_id, learner_id, initiator_id, skill_id, status,
      duration_minutes, scheduled_at, is_swap, swap_id, credits
    ) VALUES (
      p_recipient_id, v_proposer, v_proposer, p_their_skill_id, 'pending',
      p_their_duration, p_their_scheduled_at, true, v_swap_id, 0
    );
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'One of these times clashes with a session you two already have for that skill. Pick a different time.';
  END;

  SELECT COALESCE(full_name, 'Someone') INTO v_proposer_nm
  FROM public.profiles WHERE id = v_proposer;
  SELECT name INTO v_my_skill FROM public.skills WHERE id = p_my_skill_id;
  SELECT name INTO v_their_skill FROM public.skills WHERE id = p_their_skill_id;

  INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
  VALUES (
    p_recipient_id,
    'swap_proposed',
    v_proposer_nm || ' proposed a skill swap',
    'They teach you ' || COALESCE(v_my_skill, 'a skill')
      || ', you teach them ' || COALESCE(v_their_skill, 'a skill') || '. No credits.',
    '/dashboard',
    jsonb_build_object('swapId', v_swap_id, 'proposerId', v_proposer)
  );

  RETURN v_swap_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.propose_swap(UUID, UUID, INT, TIMESTAMPTZ, UUID, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.propose_swap(UUID, UUID, INT, TIMESTAMPTZ, UUID, INT, TIMESTAMPTZ) TO authenticated;
