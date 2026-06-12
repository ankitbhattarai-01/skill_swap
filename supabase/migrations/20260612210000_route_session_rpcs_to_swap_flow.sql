-- =============================================================================
-- Fix: single-session RPCs could split a swap pair.
--
-- A direct skill swap (20260612200000) is TWO linked sessions sharing a
-- swap_id, and its lifecycle RPCs (respond_to_swap / cancel_swap) always act
-- on BOTH legs. But the per-session RPCs — accept_session, reject_session,
-- cancel_session — knew nothing about swaps, and the incoming-request banner
-- surfaced swap legs like ordinary pending requests. Accepting one there
-- flipped only that leg to 'accepted' (and wrongly set escrow_held = true on
-- a 0-credit row), while the other leg stayed 'pending'. Result: the recipient
-- saw "ACCEPTED + Join" while the proposer saw "PENDING" forever, because each
-- side's swap card reads the status of their own teaching leg.
--
-- Fix, in four parts:
--   1. The per-session RPCs now detect is_swap rows and delegate to the
--      paired swap RPCs (accept → respond_to_swap(true), reject →
--      respond_to_swap(false), cancel → cancel_swap), so every entry point
--      keeps the two legs in lockstep. The swap RPCs re-run their own
--      participant / proposer / suspension checks.
--   2. (client) The incoming-request banner stops listing swap legs.
--   3. Data repair for pairs already split by the bug, and removal of the
--      bogus escrow flags / 0-credit ledger rows it created.
--   4. propose_swap rejects legs that overlap in time: the same two people
--      attend both sessions, so e.g. Guitar 7:00 PM + Figma 7:00 PM is
--      physically impossible. (The proposal dialog now blocks this too.)
--
-- The non-swap bodies below are copied VERBATIM from the current production
-- versions — private.accept_session from 20260512070000 (moved to `private`
-- by 20260513190000), private.reject_session from 20260509030000 (moved by
-- 20260513200000), public.cancel_session from 20260523010000. Only the swap
-- branches are new. Keep those files and this one in sync if any changes.
-- (private.cancel_session from 20260513190000 still exists but is dead code —
-- 20260523010000 replaced the public wrapper with a full SECURITY DEFINER
-- body, so nothing delegates to it.)
-- =============================================================================


-- ─── 1. accept_session: swap legs accept the whole swap ─────────────────────
CREATE OR REPLACE FUNCTION private.accept_session(p_session_id UUID, p_meet_link TEXT DEFAULT NULL)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_actor UUID := auth.uid();
  v_learner_credits INT;
  v_meet_link TEXT;
  v_suspension RECORD;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_actor IS NULL
     OR (v_actor <> v_session.learner_id AND v_actor <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF COALESCE(v_session.initiator_id, v_session.learner_id) = v_actor THEN
    RAISE EXCEPTION 'Only the counterparty can accept this session';
  END IF;

  IF v_session.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sessions can be accepted';
  END IF;

  -- Suspension gate.
  SELECT s.kind, s.expires_at INTO v_suspension
  FROM public.user_suspension_state(v_actor) s;

  IF v_suspension.kind = 'permanent' THEN
    RAISE EXCEPTION 'Your account is suspended. Contact support.';
  ELSIF v_suspension.kind = 'full' THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'You cannot accept new sessions until %s (5+ recent strikes).',
      to_char(v_suspension.expires_at, 'YYYY-MM-DD HH24:MI')
    );
  ELSIF v_suspension.kind = 'teaching_only' AND v_actor = v_session.teacher_id THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'You cannot accept new teaching requests until %s (3+ recent strikes). You can still learn.',
      to_char(v_suspension.expires_at, 'YYYY-MM-DD HH24:MI')
    );
  END IF;

  -- ── Swap leg: accept the PAIR, never just this row ─────────────────────────
  -- respond_to_swap flips both legs to 'accepted', sets their meet links, and
  -- notifies the proposer. It re-checks that the caller is the recipient (the
  -- counterparty check above already guarantees it). No escrow: swaps are
  -- credit-free, so the credits/escrow path below must never run for them.
  IF v_session.is_swap THEN
    IF v_session.swap_id IS NULL THEN
      RAISE EXCEPTION 'Swap session is missing its swap id';
    END IF;
    PERFORM private.respond_to_swap(v_session.swap_id, true);
    SELECT * INTO v_session FROM public.sessions WHERE id = p_session_id;
    RETURN v_session;
  END IF;

  SELECT credits
  INTO v_learner_credits
  FROM public.profiles
  WHERE id = v_session.learner_id
  FOR UPDATE;

  IF COALESCE(v_learner_credits, 0) < v_session.credits THEN
    RAISE EXCEPTION 'Learner does not have enough credits';
  END IF;

  v_meet_link := '/video/' || p_session_id::text;

  UPDATE public.profiles
  SET credits = credits - v_session.credits
  WHERE id = v_session.learner_id;

  INSERT INTO public.credit_transactions (
    from_user, to_user, amount, session_id, description
  ) VALUES (
    v_session.learner_id, NULL, v_session.credits, v_session.id,
    'Held for upcoming session'
  );

  UPDATE public.sessions
  SET status = 'accepted', meet_link = v_meet_link, escrow_held = true
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.accept_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.accept_session(UUID, TEXT) TO authenticated;


-- ─── 2. reject_session: swap legs decline the whole swap ────────────────────
CREATE OR REPLACE FUNCTION private.reject_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_actor UUID := auth.uid();
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_actor IS NULL
     OR (v_actor <> v_session.learner_id AND v_actor <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF COALESCE(v_session.initiator_id, v_session.learner_id) = v_actor THEN
    RAISE EXCEPTION 'Only the counterparty can reject this session';
  END IF;

  IF v_session.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending sessions can be rejected';
  END IF;

  -- ── Swap leg: decline the PAIR ──────────────────────────────────────────────
  -- respond_to_swap(false) flips both legs to 'cancelled' (swaps don't use the
  -- 'rejected' status) and notifies the proposer.
  IF v_session.is_swap THEN
    IF v_session.swap_id IS NULL THEN
      RAISE EXCEPTION 'Swap session is missing its swap id';
    END IF;
    PERFORM private.respond_to_swap(v_session.swap_id, false);
    SELECT * INTO v_session FROM public.sessions WHERE id = p_session_id;
    RETURN v_session;
  END IF;

  UPDATE public.sessions
  SET status = 'rejected'
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.reject_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.reject_session(UUID) TO authenticated;


-- ─── 3. cancel_session: swap legs cancel the whole swap ─────────────────────
CREATE OR REPLACE FUNCTION public.cancel_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_original_status public.session_status;
  v_caller UUID := auth.uid();
  v_minutes_to_start NUMERIC;
  v_strike_reason TEXT;
  v_strike_weight INT;
BEGIN
  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_caller IS NULL
     OR (v_caller <> v_session.learner_id AND v_caller <> v_session.teacher_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status NOT IN ('pending', 'accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot cancel a session in status %', v_session.status;
  END IF;

  -- ── Swap leg: cancel the PAIR ───────────────────────────────────────────────
  -- cancel_swap flips both legs to 'cancelled' and notifies the other side.
  -- Swaps hold no escrow, so neither the post-start auto-settle redirect nor
  -- the refund/strike machinery below applies to them.
  IF v_session.is_swap THEN
    IF v_session.swap_id IS NULL THEN
      RAISE EXCEPTION 'Swap session is missing its swap id';
    END IF;
    PERFORM private.cancel_swap(v_session.swap_id);
    SELECT * INTO v_session FROM public.sessions WHERE id = p_session_id;
    RETURN v_session;
  END IF;

  v_original_status := v_session.status;

  -- ─── Post-start: route to attendance-based settlement ──────────────────────
  -- Once scheduled_at has passed, "cancel" is no longer a refundable
  -- pre-commitment action — there's real attendance data on file. We hand
  -- off to auto_settle_session(), which decides between full transfer,
  -- partial split, or refund based on who actually showed up. The session
  -- ends in 'completed' or 'cancelled' depending on whether credits moved.
  IF v_original_status IN ('accepted', 'active')
     AND v_session.escrow_held
     AND v_session.scheduled_at IS NOT NULL
     AND now() >= v_session.scheduled_at
  THEN
    -- auto_settle_session requires status to be in (pending_review,
    -- accepted, active). Already true here, so we can call it directly.
    -- It writes the settlement audit row and flips status, and its own
    -- strike logic handles the no-show case.
    RETURN public.auto_settle_session(v_session.id);
  END IF;

  -- ─── Pre-start (or unscheduled / no-escrow) cancel: refund and strike ─────

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.learner_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.learner_id, v_session.credits, v_session.id,
      'Refund: session cancelled'
    );
  END IF;

  UPDATE public.sessions
  SET status = 'cancelled', escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  -- Strike: only on cancels of accepted/active sessions (real commitment)
  -- that had a scheduled start time within 2h. The 'now < scheduled_at'
  -- guard above means v_minutes_to_start is always > 0 on this branch.
  IF v_original_status IN ('accepted', 'active')
     AND v_session.scheduled_at IS NOT NULL
  THEN
    v_minutes_to_start := EXTRACT(EPOCH FROM (v_session.scheduled_at - now())) / 60;

    IF v_minutes_to_start < 30 THEN
      v_strike_reason := 'late_cancel_30min';
      v_strike_weight := 2;
    ELSIF v_minutes_to_start < 120 THEN
      v_strike_reason := 'late_cancel_2h';
      v_strike_weight := 1;
    ELSE
      v_strike_reason := NULL;
    END IF;

    IF v_strike_reason IS NOT NULL THEN
      PERFORM public.issue_strike_internal(
        v_caller, v_strike_reason, v_strike_weight, v_session.id, NULL,
        'Cancelled ' || ROUND(v_minutes_to_start)::text || ' min before scheduled start',
        NULL
      );
    END IF;
  END IF;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_session(UUID) TO authenticated;


-- ─── 4. Repair pairs already split by the bug ────────────────────────────────

-- 4a. One leg accepted, the other still pending: the recipient DID accept (via
--     the banner), so finish what respond_to_swap would have done — promote
--     the pending leg and give it its meet link.
WITH mixed AS (
  SELECT swap_id
  FROM public.sessions
  WHERE is_swap AND swap_id IS NOT NULL
  GROUP BY swap_id
  HAVING bool_or(status = 'accepted') AND bool_or(status = 'pending')
)
UPDATE public.sessions s
SET status = 'accepted', meet_link = '/video/' || s.id::text
FROM mixed
WHERE s.swap_id = mixed.swap_id AND s.status = 'pending';

-- 4b. One leg already closed (rejected/cancelled via the single-session RPCs),
--     the other still open: close the open leg so the pair can't linger as a
--     half-zombie that blocks re-proposing the same skill.
WITH mixed AS (
  SELECT swap_id
  FROM public.sessions
  WHERE is_swap AND swap_id IS NOT NULL
  GROUP BY swap_id
  HAVING bool_or(status IN ('rejected', 'cancelled'))
     AND bool_or(status IN ('pending', 'accepted', 'active'))
)
UPDATE public.sessions s
SET status = 'cancelled', escrow_held = false
FROM mixed
WHERE s.swap_id = mixed.swap_id AND s.status IN ('pending', 'accepted', 'active');

-- 4c. Swap legs must never carry escrow (accept_session wrongly set it, which
--     also exposed them to the move_due_sessions_to_review sweeper).
UPDATE public.sessions
SET escrow_held = false
WHERE is_swap AND escrow_held;

-- 4d. Drop the confusing 0-credit "Held for upcoming session" ledger rows that
--     the wrong accept path wrote for swap legs.
DELETE FROM public.credit_transactions ct
USING public.sessions s
WHERE ct.session_id = s.id
  AND s.is_swap
  AND ct.amount = 0
  AND ct.description = 'Held for upcoming session';

-- 4e. Cancel still-pending swap pairs proposed before the overlap check (5.)
--     existed whose legs clash in time — accepting them would create two
--     sessions the same two people can't possibly attend. They vanish from
--     both inboxes; the proposer can re-propose with non-clashing times.
WITH clashing AS (
  SELECT a.swap_id
  FROM public.sessions a
  JOIN public.sessions b
    ON b.swap_id = a.swap_id AND b.id <> a.id
  WHERE a.is_swap
    AND a.swap_id IS NOT NULL
    AND a.status = 'pending' AND b.status = 'pending'
    AND a.scheduled_at IS NOT NULL AND b.scheduled_at IS NOT NULL
    AND a.scheduled_at < b.scheduled_at + (b.duration_minutes * INTERVAL '1 minute')
    AND b.scheduled_at < a.scheduled_at + (a.duration_minutes * INTERVAL '1 minute')
  GROUP BY a.swap_id
)
UPDATE public.sessions s
SET status = 'cancelled'
FROM clashing
WHERE s.swap_id = clashing.swap_id AND s.status = 'pending';


-- ─── 5. propose_swap: the two legs must not overlap in time ──────────────────
-- Body copied VERBATIM from 20260612200000 — only the overlap check (after the
-- in-the-future check) is new. The public SECURITY INVOKER wrapper from that
-- migration is unchanged and still applies.
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
  IF p_my_duration NOT IN (30, 60, 90) OR p_their_duration NOT IN (30, 60, 90) THEN
    RAISE EXCEPTION 'Session length must be 30, 60, or 90 minutes';
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
