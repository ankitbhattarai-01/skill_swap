-- =============================================================================
-- Direct skill swaps (no credits).
--
-- The dashboard's AI suggestions have always advertised "direct swap, no
-- credits" for reciprocal matches (you teach what they want, they teach what
-- you want) but there was no mechanism behind it — clicking the tile only
-- opened the other person's profile, where the only action charges credits.
--
-- A direct swap is modelled as TWO linked, free sessions sharing a swap_id:
--   • session A: the proposer teaches their offered skill to the recipient
--   • session B: the recipient teaches their offered skill to the proposer
-- Both rows carry is_swap = true and credits = 0. They never touch the escrow
-- / settlement machinery (which is all gated on escrow_held = true), so no
-- credits move at any point in their lifecycle.
--
-- Lifecycle:
--   propose_swap()      → inserts both rows as 'pending' (proposer is the
--                         initiator of both), notifies the recipient.
--   respond_to_swap()   → recipient accepts (both → 'accepted', meet links set)
--                         or declines (both → 'cancelled'). Notifies proposer.
--   complete_session()  → either party closes a swap session (no credits).
--   complete_due_swap_sessions() → cron auto-completes swap sessions whose
--                         scheduled end has passed (swaps skip pending_review).
-- =============================================================================


-- ─── 1. Columns ──────────────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS is_swap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS swap_id uuid;

-- Lets respond_to_swap() and the swap inbox fetch both sides of a swap by id.
CREATE INDEX IF NOT EXISTS sessions_swap_id_idx
  ON public.sessions (swap_id)
  WHERE swap_id IS NOT NULL;


-- ─── 2. Relax the credits CHECK so swap rows can be free ─────────────────────
-- The original constraint (20260427095000) was a blanket `credits > 0`. Swaps
-- are credit-free, so the rule becomes: swap rows must be exactly 0, ordinary
-- rows must stay > 0. NOT VALID skips re-scanning existing rows (all of which
-- are ordinary, credits > 0, and already satisfy the new predicate).
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_credits_positive;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_credits_positive
  CHECK ((is_swap AND credits = 0) OR (NOT is_swap AND credits > 0)) NOT VALID;


-- ─── 3. Credit-enforcement trigger: swaps are free ──────────────────────────
-- The BEFORE INSERT trigger normally overwrites credits with the server-priced
-- amount (>= 1). Swap rows short-circuit to 0 so they satisfy the CHECK above
-- and never escrow anything.
CREATE OR REPLACE FUNCTION public.enforce_session_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rate INT;
BEGIN
  IF NEW.is_swap THEN
    NEW.credits := 0;
    RETURN NEW;
  END IF;

  SELECT credits_per_hour
  INTO v_rate
  FROM public.user_teaching_skills
  WHERE user_id = NEW.teacher_id
    AND skill_id = NEW.skill_id
  LIMIT 1;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 4;
  END IF;

  NEW.credits := GREATEST(
    1,
    CEIL((v_rate::numeric * NEW.duration_minutes) / 60)::int
  );

  RETURN NEW;
END;
$$;


-- ─── 4. Lifecycle notification trigger: skip swaps ──────────────────────────
-- Swap rows get their own purpose-built notifications (swap_proposed /
-- swap_accepted / swap_declined / swap_completed) from the RPCs below. The
-- generic per-session "X requested a session • 0 credits" / "X accepted your
-- session" rows would be confusing (the proposer would be notified about their
-- own proposal, every body would read "0 credits"), so we suppress them.
CREATE OR REPLACE FUNCTION public.notify_session_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_skill_name TEXT;
  v_teacher_name TEXT;
  v_learner_name TEXT;
BEGIN
  -- Swaps are notified from propose_swap / respond_to_swap / completion.
  IF NEW.is_swap THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(name, 'Skill session') INTO v_skill_name
  FROM public.skills WHERE id = NEW.skill_id;

  SELECT COALESCE(full_name, 'Teacher') INTO v_teacher_name
  FROM public.profiles WHERE id = NEW.teacher_id;

  SELECT COALESCE(full_name, 'Learner') INTO v_learner_name
  FROM public.profiles WHERE id = NEW.learner_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      NEW.teacher_id,
      'session_requested',
      COALESCE(v_learner_name, 'Someone') || ' requested a session',
      COALESCE(v_skill_name, 'Skill session') || ' • ' || NEW.credits::TEXT || ' credits',
      '/sessions/' || NEW.id::TEXT,
      jsonb_build_object(
        'sessionId', NEW.id, 'skillId', NEW.skill_id,
        'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
        'status', NEW.status
      )
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'accepted' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.learner_id,
        'session_accepted',
        COALESCE(v_teacher_name, 'Your teacher') || ' accepted your session',
        COALESCE(v_skill_name, 'Skill session') || ' is ready',
        '/sessions/' || NEW.id::TEXT,
        jsonb_build_object(
          'sessionId', NEW.id, 'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'rejected' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.learner_id,
        'session_rejected',
        COALESCE(v_teacher_name, 'Your teacher') || ' rejected your session',
        COALESCE(v_skill_name, 'Skill session') || ' request was not accepted',
        '/dashboard',
        jsonb_build_object(
          'sessionId', NEW.id, 'skillId', NEW.skill_id,
          'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
          'status', NEW.status
        )
      );
    ELSIF NEW.status = 'cancelled' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_teacher_name, 'your teacher') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        ),
        (
          NEW.teacher_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_learner_name, 'your learner') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        );
    ELSIF NEW.status = 'completed' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were sent to ' || COALESCE(v_teacher_name, 'your teacher'),
          '/history',
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        ),
        (
          NEW.teacher_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were received from ' || COALESCE(v_learner_name, 'your learner'),
          '/history',
          jsonb_build_object(
            'sessionId', NEW.id, 'skillId', NEW.skill_id,
            'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
            'status', NEW.status
          )
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_session_lifecycle() FROM PUBLIC, anon, authenticated;


-- ─── 5. complete_session(): free path for swaps ─────────────────────────────
-- Swap sessions never escrow, so the attendance/settlement branches don't
-- apply. Either participant may close their swap session; we just flip it to
-- 'completed' and notify the other side.
--
-- The non-swap body below is copied VERBATIM from the current production
-- version (20260517000000_gate_early_release_on_attendance.sql, which itself
-- carries the 20260513010000 ledger fix) — only the swap branch is new.
-- Re-deriving from an older migration here would silently revert the
-- anti-Sybil-farming gates, so keep that file and this one in sync if either
-- changes. The body lives in `private` (moved by 20260513190000); the public
-- SECURITY INVOKER wrapper (with its suspension check from 20260523030000)
-- is untouched and applies to swaps too.
CREATE OR REPLACE FUNCTION private.complete_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session        public.sessions;
  v_caller         UUID := auth.uid();
  v_learner_secs   INT;
  v_teacher_secs   INT;
  v_required_secs  INT;
  v_skill_name     TEXT;
  v_other          UUID;
BEGIN
  SELECT * INTO v_session
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

  IF v_session.status = 'completed' THEN
    RETURN v_session;
  END IF;

  -- ── Swap path: no escrow, no settlement, no credit movement ───────────────
  -- Either party can mark it done once accepted. The anti-farming gates below
  -- exist to protect credit transfers; with zero credits at stake they don't
  -- apply. Time still matters for the auto-close: the cron sweeper
  -- (complete_due_swap_sessions) closes any swap leg whose scheduled end +
  -- 5-min grace has passed, so manual completion is optional.
  IF v_session.is_swap THEN
    IF v_session.status NOT IN ('accepted', 'active', 'pending_review') THEN
      RAISE EXCEPTION 'Cannot complete a swap session in status %', v_session.status;
    END IF;

    UPDATE public.sessions
    SET status = 'completed', escrow_held = false
    WHERE id = v_session.id
    RETURNING * INTO v_session;

    SELECT COALESCE(name, 'a skill') INTO v_skill_name
    FROM public.skills WHERE id = v_session.skill_id;

    -- Notify the OTHER participant that this swap session wrapped up.
    v_other := CASE WHEN v_caller = v_session.teacher_id
                    THEN v_session.learner_id ELSE v_session.teacher_id END;
    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      v_other,
      'swap_completed',
      'Swap session completed',
      'Your ' || v_skill_name || ' swap session is marked complete.',
      '/history',
      jsonb_build_object('sessionId', v_session.id, 'swapId', v_session.swap_id)
    );

    RETURN v_session;
  END IF;

  -- ── Non-swap (escrowed) path — verbatim from 20260517000000 ───────────────
  -- Pending_review: hand off to the attendance-aware auto-settle. That path
  -- already gates on attendance and falls back to refund, so no extra gates
  -- needed here.
  IF v_session.status = 'pending_review' THEN
    RETURN public.auto_settle_session(v_session.id);
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot complete a session in status %', v_session.status;
  END IF;

  IF v_caller = v_session.teacher_id THEN
    RAISE EXCEPTION 'Teachers can only complete after the session ends. The session will move to review automatically.';
  END IF;

  -- ─── Anti-farming gates on the early-release path ──────────────────────────
  -- Gate 1: at least 50% of the planned session time must have elapsed
  -- since the scheduled start.
  IF v_session.scheduled_at IS NULL
     OR now() < v_session.scheduled_at + ((v_session.duration_minutes::numeric / 2.0) * INTERVAL '1 minute') THEN
    RAISE EXCEPTION 'Credits can only be released after at least half the planned session time has passed.';
  END IF;

  v_learner_secs := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  -- Gate 2: BOTH parties must have attended ≥ 50% of the planned duration.
  v_required_secs := (v_session.duration_minutes * 60) / 2;
  IF v_teacher_secs < v_required_secs OR v_learner_secs < v_required_secs THEN
    RAISE EXCEPTION 'Both you and your teacher must attend at least 50%% of the session (% seconds each, out of % planned) before credits can be released early. Wait for the session to wrap up — credits release automatically once attendance is confirmed.',
      v_required_secs, v_session.duration_minutes * 60;
  END IF;

  IF v_session.escrow_held THEN
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      NULL, v_session.teacher_id, v_session.credits, v_session.id,
      'Released from escrow (early)'
    );
  ELSE
    -- Legacy unescrowed path: no prior "Held" entry exists, so the transfer
    -- is genuinely learner → teacher in the ledger. Vanishingly rare.
    UPDATE public.profiles SET credits = credits - v_session.credits
    WHERE id = v_session.learner_id;
    UPDATE public.profiles SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id,
      'Session completed (legacy non-escrow)'
    );
  END IF;

  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, 'early_release', 'released_by_learner',
    v_learner_secs, v_teacher_secs, v_session.duration_minutes * 60,
    v_session.credits, 0, v_caller
  );

  UPDATE public.sessions
  SET status = 'completed', escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.complete_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.complete_session(UUID) TO authenticated;


-- ─── 6. propose_swap(): create the two linked free sessions ─────────────────
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

CREATE OR REPLACE FUNCTION public.propose_swap(
  p_recipient_id      UUID,
  p_my_skill_id       UUID,
  p_my_duration       INT,
  p_my_scheduled_at   TIMESTAMPTZ,
  p_their_skill_id    UUID,
  p_their_duration    INT,
  p_their_scheduled_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.propose_swap(
    p_recipient_id, p_my_skill_id, p_my_duration, p_my_scheduled_at,
    p_their_skill_id, p_their_duration, p_their_scheduled_at
  );
$$;
REVOKE EXECUTE ON FUNCTION public.propose_swap(UUID, UUID, INT, TIMESTAMPTZ, UUID, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_swap(UUID, UUID, INT, TIMESTAMPTZ, UUID, INT, TIMESTAMPTZ) TO authenticated;


-- ─── 7. respond_to_swap(): recipient accepts or declines both sides ─────────
CREATE OR REPLACE FUNCTION private.respond_to_swap(
  p_swap_id UUID,
  p_accept  BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller    UUID := auth.uid();
  v_proposer  UUID;
  v_responder_nm TEXT;
  v_pending   INT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Both rows share initiator_id = the proposer. Lock them up front.
  SELECT initiator_id INTO v_proposer
  FROM public.sessions
  WHERE swap_id = p_swap_id
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE;

  IF v_proposer IS NULL THEN
    RAISE EXCEPTION 'Swap not found';
  END IF;

  -- Caller must be a participant in this swap …
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions
    WHERE swap_id = p_swap_id
      AND (teacher_id = v_caller OR learner_id = v_caller)
  ) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  -- … and only the recipient (not the proposer) can accept/decline it.
  IF v_caller = v_proposer THEN
    RAISE EXCEPTION 'The proposer cannot respond to their own swap. Cancel it instead.';
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.sessions
  WHERE swap_id = p_swap_id AND status = 'pending';

  IF v_pending = 0 THEN
    RAISE EXCEPTION 'This swap is no longer pending';
  END IF;

  SELECT COALESCE(full_name, 'Someone') INTO v_responder_nm
  FROM public.profiles WHERE id = v_caller;

  IF p_accept THEN
    -- Parity with accept_session's wrapper (20260523030000): a suspended user
    -- must not be able to activate sessions. Declining stays allowed — same
    -- rationale as cancel_session being unblocked for suspended users.
    IF private.is_admin_suspended(v_caller) THEN
      RAISE EXCEPTION 'Your account is suspended and cannot accept swaps.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A swap sat on too long can go stale: if either leg's scheduled END has
    -- already passed, accepting would create a session the cron sweeper
    -- immediately auto-completes — a "session" nobody could ever join. Make
    -- the recipient ask for a fresh proposal instead.
    IF EXISTS (
      SELECT 1 FROM public.sessions
      WHERE swap_id = p_swap_id
        AND status = 'pending'
        AND scheduled_at IS NOT NULL
        AND now() > scheduled_at + (duration_minutes * INTERVAL '1 minute')
    ) THEN
      RAISE EXCEPTION 'One of these session times has already passed. Ask for a new swap proposal.';
    END IF;

    UPDATE public.sessions
    SET status = 'accepted', meet_link = '/video/' || id::text
    WHERE swap_id = p_swap_id AND status = 'pending';

    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      v_proposer,
      'swap_accepted',
      v_responder_nm || ' accepted your skill swap',
      'Your swap is on. Check your upcoming sessions.',
      '/dashboard',
      jsonb_build_object('swapId', p_swap_id, 'responderId', v_caller)
    );
  ELSE
    UPDATE public.sessions
    SET status = 'cancelled'
    WHERE swap_id = p_swap_id AND status = 'pending';

    INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
    VALUES (
      v_proposer,
      'swap_declined',
      v_responder_nm || ' declined your skill swap',
      'No worries. Explore other matches to swap with.',
      '/explore',
      jsonb_build_object('swapId', p_swap_id, 'responderId', v_caller)
    );
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION private.respond_to_swap(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.respond_to_swap(UUID, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.respond_to_swap(p_swap_id UUID, p_accept BOOLEAN)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.respond_to_swap(p_swap_id, p_accept);
$$;
REVOKE EXECUTE ON FUNCTION public.respond_to_swap(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_swap(UUID, BOOLEAN) TO authenticated;


-- ─── 8. cancel_swap(): proposer (or either party) calls off a swap ──────────
-- Wraps cancel for both linked rows. Either participant may cancel a swap from
-- pending/accepted/active; since swaps hold no escrow there's nothing to
-- refund. Notifies the other side.
CREATE OR REPLACE FUNCTION private.cancel_swap(p_swap_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  UUID := auth.uid();
  v_other   UUID;
  v_caller_nm TEXT;
  v_open    INT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM 1 FROM public.sessions WHERE swap_id = p_swap_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.sessions
    WHERE swap_id = p_swap_id
      AND (teacher_id = v_caller OR learner_id = v_caller)
  ) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT count(*) INTO v_open
  FROM public.sessions
  WHERE swap_id = p_swap_id AND status IN ('pending', 'accepted', 'active');

  IF v_open = 0 THEN
    RAISE EXCEPTION 'This swap can no longer be cancelled';
  END IF;

  -- The other participant of this swap (teacher_id of the row the caller learns
  -- in, i.e. whoever isn't the caller).
  SELECT CASE WHEN teacher_id = v_caller THEN learner_id ELSE teacher_id END
  INTO v_other
  FROM public.sessions
  WHERE swap_id = p_swap_id
  LIMIT 1;

  UPDATE public.sessions
  SET status = 'cancelled', escrow_held = false
  WHERE swap_id = p_swap_id AND status IN ('pending', 'accepted', 'active');

  SELECT COALESCE(full_name, 'Someone') INTO v_caller_nm
  FROM public.profiles WHERE id = v_caller;

  INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
  VALUES (
    v_other,
    'swap_cancelled',
    v_caller_nm || ' cancelled the skill swap',
    'The swap is off.',
    '/dashboard',
    jsonb_build_object('swapId', p_swap_id, 'cancelledBy', v_caller)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION private.cancel_swap(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cancel_swap(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_swap(p_swap_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = public, private, pg_temp
AS $$
  SELECT private.cancel_swap(p_swap_id);
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_swap(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_swap(UUID) TO authenticated;


-- ─── 9. Sweeper: auto-complete swap sessions past their scheduled end ───────
-- Swaps never enter pending_review (that path is escrow-only), so without this
-- they'd sit in 'accepted' forever. Once a swap session's scheduled end has
-- passed (5-min grace), or an unscheduled one is 7 days old, close it. No
-- credits, no settlement. Notifications are skipped here to avoid spamming;
-- the status simply moves to completed.
CREATE OR REPLACE FUNCTION public.complete_due_swap_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH due AS (
    SELECT id
    FROM public.sessions
    WHERE is_swap = true
      AND status IN ('accepted', 'active')
      AND (
        (scheduled_at IS NOT NULL
          AND now() > scheduled_at + (duration_minutes * INTERVAL '1 minute') + INTERVAL '5 minutes')
        OR (scheduled_at IS NULL
          AND now() > updated_at + INTERVAL '7 days')
      )
    ORDER BY COALESCE(scheduled_at, updated_at)
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.sessions s
    SET status = 'completed', escrow_held = false
    FROM due
    WHERE s.id = due.id
    RETURNING s.id
  )
  SELECT count(*)::integer INTO v_count FROM updated;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.complete_due_swap_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_due_swap_sessions() TO service_role;

-- Schedule it next to the other session sweepers (no-op if pg_cron is absent;
-- cron.schedule replaces any existing job of the same name).
DO $$
BEGIN
  PERFORM cron.schedule(
    'skillswap-complete-due-swap-sessions',
    '*/5 * * * *',
    $cron$SELECT public.complete_due_swap_sessions();$cron$
  );
EXCEPTION
  WHEN undefined_function OR undefined_table OR invalid_schema_name OR insufficient_privilege THEN
    RAISE NOTICE 'pg_cron not available; schedule complete_due_swap_sessions() with an external scheduler.';
END;
$$;
