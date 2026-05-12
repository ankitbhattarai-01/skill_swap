-- =============================================================================
-- User strikes + automated penalties.
--
-- Until now, no-shows and last-minute cancellations cost the offender nothing.
-- This migration adds a strike ledger and three automatic write paths:
--
--   1. cancel_session() — late cancel of an accepted session (within 2h of
--      start) costs 1 strike, within 30min costs 2.
--   2. auto_settle_session() — when the attendance rule fires a no-show
--      outcome, the no-show party gets 1 strike.
--   3. admin_issue_strike() — manual path for confirmed report outcomes
--      and other moderator actions.
--
-- Strikes are weighted (usually 1, occasionally 2). They decay after 90 days.
-- The user_suspension_state() function rolls active strikes into one of
-- three states:
--
--   teaching_only_7d  — 3+ active strikes in the last 30 days. Can still
--                       learn, can't accept new teaching requests for 7d
--                       past the most recent strike.
--   full_30d          — 5+ active strikes in the last 30 days. Can't
--                       accept any new session for 30d past the most recent.
--   permanent         — 8+ active strikes lifetime (90-day window). Hard
--                       lockout, manual admin reversal required.
--
-- Existing accepted sessions are never interrupted by a new suspension —
-- this avoids stranding the counterparty mid-track.
--
-- Closes:
--   H3 — last-minute cancellation has zero cost (now 1-2 strikes).
--   H4 — reject at any time also had zero cost. Still free for *pending*
--        requests (no commitment exists yet), but actual no-show during an
--        accepted session is now a strike via the auto-settle path.
-- =============================================================================


-- ─── 1. user_strikes ledger ──────────────────────────────────────────────────
--
-- One row per strike. Weight allows for "small" (1) vs "large" (2) strikes.
-- expires_at is set at insertion time to created_at + 90 days, so the
-- 30-day and lifetime queries are simple time-window scans without
-- per-row decay logic.

CREATE TABLE IF NOT EXISTS public.user_strikes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN (
    'late_cancel_2h',         -- cancelled within 2h of scheduled start
    'late_cancel_30min',      -- cancelled within 30min of scheduled start
    'no_show_learner',        -- attended 0 seconds of a session
    'no_show_teacher',        -- attended 0 seconds of a session
    'admin_upheld_report',    -- moderator upheld a report against this user
    'admin_bad_faith_report', -- this user filed a bad-faith report
    'admin_other'             -- catch-all for manual moderator action
  )),
  weight INT NOT NULL CHECK (weight BETWEEN 1 AND 5),
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason TEXT,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS user_strikes_user_id_idx
  ON public.user_strikes (user_id, created_at DESC);
-- Partial index for the "active strikes for this user" lookup. We can't
-- include `expires_at > now()` here — Postgres requires index predicates to
-- be IMMUTABLE, and now() is STABLE. The expires_at column is included so
-- the planner can use index-only scans for the time filter at query time.
CREATE INDEX IF NOT EXISTS user_strikes_active_window_idx
  ON public.user_strikes (user_id, expires_at)
  WHERE revoked_at IS NULL;
ALTER TABLE public.user_strikes ENABLE ROW LEVEL SECURITY;
-- Users see only their own strikes. Admins see all (via the separate
-- service-role / admin RPCs below — no separate admin SELECT policy needed
-- because the admin dashboard goes through SECURITY DEFINER reads).
DROP POLICY IF EXISTS "Users view own strikes" ON public.user_strikes;
CREATE POLICY "Users view own strikes" ON public.user_strikes
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- All writes are SECURITY DEFINER-only.
REVOKE INSERT, UPDATE, DELETE ON public.user_strikes FROM anon, authenticated;
-- ─── 2. user_active_strike_weight() ─────────────────────────────────────────
--
-- Sums non-revoked, non-expired strike weights for a user within a window.
-- This is the building block for the suspension-state logic. Made
-- SECURITY DEFINER so it works inside policies and triggers regardless of
-- caller role.

CREATE OR REPLACE FUNCTION public.user_active_strike_weight(
  p_user UUID,
  p_within INTERVAL DEFAULT INTERVAL '30 days'
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(weight), 0)::int
  FROM public.user_strikes
  WHERE user_id = p_user
    AND revoked_at IS NULL
    AND expires_at > now()
    AND created_at > now() - p_within;
$$;
REVOKE EXECUTE ON FUNCTION public.user_active_strike_weight(UUID, INTERVAL) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_active_strike_weight(UUID, INTERVAL) TO authenticated;
-- ─── 3. user_suspension_state() — the rollup ─────────────────────────────────
--
-- Returns the user's current suspension state. The 'kind' value is the
-- canonical signal consumed by gates in accept_session / dispute_session /
-- session-INSERT trigger:
--
--   none            — user is in good standing.
--   teaching_only   — 3-4 strikes in 30 days; cannot teach for 7 days past
--                     the most recent strike. Can still learn.
--   full            — 5+ strikes in 30 days; cannot participate in any new
--                     session for 30 days past the most recent strike.
--   permanent       — 8+ strikes within their 90-day decay window. Manual
--                     admin reversal required.

CREATE OR REPLACE FUNCTION public.user_suspension_state(p_user UUID)
RETURNS TABLE (kind TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_30d_weight INT;
  v_lifetime_weight INT;
  v_last_strike_at TIMESTAMPTZ;
BEGIN
  SELECT
    COALESCE(SUM(weight) FILTER (
      WHERE created_at > now() - INTERVAL '30 days'
    ), 0)::int,
    COALESCE(SUM(weight), 0)::int,
    MAX(created_at)
  INTO v_30d_weight, v_lifetime_weight, v_last_strike_at
  FROM public.user_strikes
  WHERE user_id = p_user
    AND revoked_at IS NULL
    AND expires_at > now();

  IF v_lifetime_weight >= 8 THEN
    kind := 'permanent';
    expires_at := 'infinity'::TIMESTAMPTZ;
  ELSIF v_30d_weight >= 5 THEN
    kind := 'full';
    expires_at := v_last_strike_at + INTERVAL '30 days';
  ELSIF v_30d_weight >= 3 THEN
    kind := 'teaching_only';
    expires_at := v_last_strike_at + INTERVAL '7 days';
  ELSE
    kind := 'none';
    expires_at := NULL;
  END IF;

  RETURN NEXT;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.user_suspension_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_suspension_state(UUID) TO authenticated;
-- ─── 4. my_strike_summary() — what the dashboard banner reads ────────────────
--
-- The user-facing version: returns the caller's own current state plus
-- their active strike count, so the UI can show "You have 2 strikes
-- (1 expires in 67 days)" without exposing other users' data.

CREATE OR REPLACE FUNCTION public.my_strike_summary()
RETURNS TABLE (
  kind TEXT,
  suspension_expires_at TIMESTAMPTZ,
  active_strike_weight INT,
  next_strike_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_state RECORD;
BEGIN
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  SELECT s.kind, s.expires_at INTO v_state
  FROM public.user_suspension_state(v_user) s;

  kind := v_state.kind;
  suspension_expires_at := v_state.expires_at;
  active_strike_weight := public.user_active_strike_weight(v_user, INTERVAL '90 days');

  SELECT MIN(expires_at) INTO next_strike_expires_at
  FROM public.user_strikes
  WHERE user_id = v_user
    AND revoked_at IS NULL
    AND expires_at > now();

  RETURN NEXT;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.my_strike_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_strike_summary() TO authenticated;
-- ─── 5. issue_strike_internal() — the write path ─────────────────────────────
--
-- Internal helper. NOT granted to authenticated — only called from other
-- SECURITY DEFINER functions in this codebase (cancel_session,
-- auto_settle_session, admin_issue_strike). Encapsulates the row insert
-- so all strikes have consistent shape.

CREATE OR REPLACE FUNCTION public.issue_strike_internal(
  p_user UUID,
  p_reason TEXT,
  p_weight INT,
  p_session_id UUID DEFAULT NULL,
  p_report_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.user_strikes (
    user_id, reason, weight, session_id, report_id, notes, created_by
  ) VALUES (
    p_user, p_reason, p_weight, p_session_id, p_report_id, p_notes, p_created_by
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
-- No grants. Internal only.
REVOKE EXECUTE ON FUNCTION public.issue_strike_internal(UUID, TEXT, INT, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
-- ─── 6. admin_issue_strike() — manual moderator action ──────────────────────

CREATE OR REPLACE FUNCTION public.admin_issue_strike(
  p_user UUID,
  p_weight INT,
  p_reason TEXT,
  p_notes TEXT DEFAULT NULL,
  p_session_id UUID DEFAULT NULL,
  p_report_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  IF p_reason NOT IN (
    'admin_upheld_report', 'admin_bad_faith_report', 'admin_other'
  ) THEN
    RAISE EXCEPTION 'Admin strikes must use an admin reason code';
  END IF;

  RETURN public.issue_strike_internal(
    p_user, p_reason, p_weight, p_session_id, p_report_id, p_notes, v_caller
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_issue_strike(UUID, INT, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_issue_strike(UUID, INT, TEXT, TEXT, UUID, UUID) TO authenticated;
-- ─── 7. admin_revoke_strike() — overturn on appeal ──────────────────────────

CREATE OR REPLACE FUNCTION public.admin_revoke_strike(
  p_strike_id UUID,
  p_reason TEXT
)
RETURNS public.user_strikes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_strike public.user_strikes;
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Revocation reason is required';
  END IF;

  UPDATE public.user_strikes
  SET revoked_at = now(),
      revoked_by = v_caller,
      revoke_reason = p_reason
  WHERE id = p_strike_id
    AND revoked_at IS NULL
  RETURNING * INTO v_strike;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Strike not found or already revoked';
  END IF;

  RETURN v_strike;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_strike(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_strike(UUID, TEXT) TO authenticated;
-- ─── 8. cancel_session: strike on late cancellation ─────────────────────────
--
-- Free up to 2h before. 1 strike if cancelled 30min-2h before. 2 strikes
-- if cancelled within 30min or after start time. Strike applies to the
-- cancelling party (auth.uid()). Unscheduled accepted sessions don't have
-- a scheduled start to compare against → no strike.

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

  v_original_status := v_session.status;

  -- Refund escrow if it was held.
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
  -- that had a scheduled start time within 2h.
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
        NULL  -- automatic, no admin attribution
      );
    END IF;
  END IF;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_session(UUID) TO authenticated;
-- ─── 9. auto_settle_session: strike on no-show ──────────────────────────────
--
-- Re-defines the function from migration #2 with the extra strike-issuance
-- step. Everything else is identical — preserving the rule table, the
-- audit row write, and the terminal-status assignment.
--
-- We only strike for one-sided no-shows. Mutual no-show (both didn't
-- attend) skips the strike — there's no clear villain, and the rule
-- might catch both halves of a session that simply wasn't well-scheduled.

CREATE OR REPLACE FUNCTION public.auto_settle_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session       public.sessions;
  v_caller        UUID := auth.uid();
  v_learner_secs  INT;
  v_teacher_secs  INT;
  v_duration_secs INT;
  v_learner_pct   NUMERIC;
  v_teacher_pct   NUMERIC;
  v_learner_class TEXT;
  v_teacher_class TEXT;
  v_outcome       TEXT;
  v_reason        TEXT;
  v_to_teacher    INT;
  v_to_learner    INT;
  v_terminal      public.session_status;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_caller IS NOT NULL
     AND v_caller <> v_session.learner_id
     AND v_caller <> v_session.teacher_id THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF v_session.status NOT IN ('pending_review', 'accepted', 'active') THEN
    RAISE EXCEPTION 'Cannot settle session in status %', v_session.status;
  END IF;

  IF NOT v_session.escrow_held THEN
    RAISE EXCEPTION 'Session has no escrow to settle';
  END IF;

  v_duration_secs := v_session.duration_minutes * 60;
  v_learner_secs  := public.session_attended_seconds(v_session.id, v_session.learner_id);
  v_teacher_secs  := public.session_attended_seconds(v_session.id, v_session.teacher_id);

  v_learner_pct := CASE WHEN v_duration_secs > 0 THEN v_learner_secs::numeric / v_duration_secs ELSE 0 END;
  v_teacher_pct := CASE WHEN v_duration_secs > 0 THEN v_teacher_secs::numeric / v_duration_secs ELSE 0 END;

  v_learner_class := CASE
    WHEN v_learner_secs = 0 THEN 'no_show'
    WHEN v_learner_pct < 0.5 THEN 'left_early'
    ELSE 'attended'
  END;
  v_teacher_class := CASE
    WHEN v_teacher_secs = 0 THEN 'no_show'
    WHEN v_teacher_pct < 0.5 THEN 'left_early'
    ELSE 'attended'
  END;

  IF v_learner_class = 'attended' AND v_teacher_class = 'attended' THEN
    v_outcome := 'full_transfer';
    v_reason  := 'both_attended';
    v_to_teacher := v_session.credits;
    v_to_learner := 0;
  ELSIF v_learner_class = 'no_show' AND v_teacher_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'mutual_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;
  ELSIF v_teacher_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'teacher_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;
  ELSIF v_learner_class = 'no_show' THEN
    v_outcome := 'full_refund';
    v_reason  := 'learner_no_show';
    v_to_teacher := 0;
    v_to_learner := v_session.credits;
  ELSE
    v_outcome := 'partial_split';
    v_reason  := CASE
      WHEN v_learner_class = 'left_early' AND v_teacher_class = 'attended' THEN 'learner_left_early'
      WHEN v_teacher_class = 'left_early' AND v_learner_class = 'attended' THEN 'teacher_left_early'
      ELSE 'both_left_early'
    END;
    v_to_teacher := v_session.credits / 2;
    v_to_learner := v_session.credits - v_to_teacher;
  END IF;

  IF v_to_teacher > 0 THEN
    UPDATE public.profiles SET credits = credits + v_to_teacher
    WHERE id = v_session.teacher_id;
    INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
    VALUES (v_session.learner_id, v_session.teacher_id, v_to_teacher, v_session.id,
            CASE WHEN v_outcome = 'partial_split' THEN 'Session partial settlement' ELSE 'Session completed' END);
  END IF;

  IF v_to_learner > 0 THEN
    UPDATE public.profiles SET credits = credits + v_to_learner
    WHERE id = v_session.learner_id;
    INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
    VALUES (NULL, v_session.learner_id, v_to_learner, v_session.id,
            'Refund: ' || v_reason);
  END IF;

  INSERT INTO public.session_settlement (
    session_id, outcome, reason,
    learner_attended_seconds, teacher_attended_seconds, duration_seconds,
    amount_to_teacher, amount_refunded_to_learner, settled_by
  ) VALUES (
    v_session.id, v_outcome, v_reason,
    v_learner_secs, v_teacher_secs, v_duration_secs,
    v_to_teacher, v_to_learner, v_caller
  );

  -- NEW: strike on one-sided no-show.
  IF v_reason = 'teacher_no_show' THEN
    PERFORM public.issue_strike_internal(
      v_session.teacher_id, 'no_show_teacher', 1, v_session.id, NULL,
      'Did not join the video room for the scheduled session', NULL
    );
  ELSIF v_reason = 'learner_no_show' THEN
    PERFORM public.issue_strike_internal(
      v_session.learner_id, 'no_show_learner', 1, v_session.id, NULL,
      'Did not join the video room for the scheduled session', NULL
    );
  END IF;

  v_terminal := CASE WHEN v_to_teacher > 0 THEN 'completed'::session_status
                                            ELSE 'cancelled'::session_status END;

  UPDATE public.sessions
  SET status = v_terminal, escrow_held = false
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.auto_settle_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_settle_session(UUID) TO authenticated;
-- ─── 10. Suspension gate for accept_session() ───────────────────────────────
--
-- Block accepting new sessions while suspended. Permanent and full
-- suspensions block all acceptance. Teaching-only suspension blocks
-- accepting only when the actor is the teacher (i.e., they're accepting
-- a learner's request to teach). Accepting a teacher's offer as the
-- learner is still allowed under teaching-only.

CREATE OR REPLACE FUNCTION public.accept_session(p_session_id UUID, p_meet_link TEXT DEFAULT NULL)
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
REVOKE EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_session(UUID, TEXT) TO authenticated;
-- ─── 11. Suspension gate for session creation ───────────────────────────────
--
-- Trigger fires BEFORE INSERT and rejects when the initiator is suspended
-- in a way that prohibits their role on the session. This blocks suspended
-- users from spamming requests while serving their suspension.

CREATE OR REPLACE FUNCTION public.check_initiator_not_suspended()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_initiator UUID := COALESCE(NEW.initiator_id, NEW.learner_id);
  v_suspension RECORD;
BEGIN
  SELECT s.kind, s.expires_at INTO v_suspension
  FROM public.user_suspension_state(v_initiator) s;

  IF v_suspension.kind = 'permanent' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Your account is suspended.';
  ELSIF v_suspension.kind = 'full' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'You cannot start new sessions until %s.',
        to_char(v_suspension.expires_at, 'YYYY-MM-DD HH24:MI')
      );
  ELSIF v_suspension.kind = 'teaching_only' AND v_initiator = NEW.teacher_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'You cannot offer new sessions as a teacher until %s. You can still request to learn.',
        to_char(v_suspension.expires_at, 'YYYY-MM-DD HH24:MI')
      );
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sessions_check_initiator_not_suspended ON public.sessions;
CREATE TRIGGER sessions_check_initiator_not_suspended
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.check_initiator_not_suspended();
REVOKE EXECUTE ON FUNCTION public.check_initiator_not_suspended() FROM PUBLIC, anon, authenticated;
