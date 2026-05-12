-- =============================================================================
-- Session attendance + meet_link lock-in.
--
-- Foundation for attendance-based settlement. Replaces the honor-system
-- complete_session() with a server-attested presence log written by
-- mint-jitsi-token (the only authoritative path into a session's video room).
--
-- Closes:
--   C3 — no proof of attendance anywhere. Today the only signal that a
--        session happened is one party clicking "Complete". Two colluding
--        accounts can settle credits with zero teaching.
--   H1 — teacher-supplied meet_link is free-form text. Lets a teacher store
--        any URL (phishing, off-platform call) in a field that ends up in
--        notifications, .ics exports, and the session page UI before the
--        client-side overwrite has a chance to run.
--
-- This migration is invisible to users. The attendance data it captures is
-- read by later migrations (pending_review window, automatic settlement,
-- no-show strikes). Without this, none of those can be trusted.
-- =============================================================================


-- ─── 1. session_attendance table ─────────────────────────────────────────────
--
-- One row per join. A user who joins, drops out, and rejoins gets multiple
-- rows — each represents one "presence interval". Settlement code sums the
-- intervals to compute total attended seconds.

CREATE TABLE IF NOT EXISTS public.session_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE INDEX IF NOT EXISTS session_attendance_session_user_idx
  ON public.session_attendance (session_id, user_id);
-- Partial index for the "find my still-open interval to close" query in
-- record_session_leave(). Tiny — there's at most one open row per user.
CREATE INDEX IF NOT EXISTS session_attendance_open_idx
  ON public.session_attendance (session_id, user_id, joined_at DESC)
  WHERE left_at IS NULL;
ALTER TABLE public.session_attendance ENABLE ROW LEVEL SECURITY;
-- Participants can read attendance for their own sessions. Important for the
-- "did the counterparty actually show up?" question in the review UI.
DROP POLICY IF EXISTS "Participants view session attendance" ON public.session_attendance;
CREATE POLICY "Participants view session attendance" ON public.session_attendance
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_attendance.session_id
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
-- No direct writes from clients. All inserts/updates go through the two
-- SECURITY DEFINER RPCs below, which verify caller identity & session state.
REVOKE INSERT, UPDATE, DELETE ON public.session_attendance FROM anon, authenticated;
-- ─── 2. record_session_join() ────────────────────────────────────────────────
--
-- Called by the mint-jitsi-token Edge Function after it verifies the caller
-- is a participant and the join window is open. The Edge Function is the
-- ONLY path that mints a JaaS JWT, and the JWT is the ONLY way into the
-- Jitsi room — so writing the attendance row here makes presence
-- server-attested and unforgeable from the browser.
--
-- Idempotency: we always insert a new row. If the same user calls this twice
-- (reload, network retry), they get two intervals that overlap. That's fine
-- — the duration calculation in session_attended_seconds() uses LEAST/GREATEST
-- against the session window so overlap can't inflate the total.

CREATE OR REPLACE FUNCTION public.record_session_join(p_session_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_session public.sessions;
  v_row_id UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_caller <> v_session.learner_id AND v_caller <> v_session.teacher_id THEN
    RAISE EXCEPTION 'Not a participant of this session';
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Session is not joinable in status %', v_session.status;
  END IF;

  INSERT INTO public.session_attendance (session_id, user_id, joined_at)
  VALUES (p_session_id, v_caller, now())
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_session_join(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_session_join(UUID) TO authenticated;
-- ─── 3. record_session_leave() ───────────────────────────────────────────────
--
-- Called from the browser when the Jitsi External API emits a leave event.
-- Less authoritative than the join (a malicious client could skip calling
-- this), but the upper-bound clamp in session_attended_seconds() prevents
-- a missing left_at from inflating attendance past the session window.
--
-- Idempotent: closes the most recent open interval for the caller. If none
-- is open (already closed, or never joined), it's a no-op.

CREATE OR REPLACE FUNCTION public.record_session_leave(p_session_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.session_attendance
  SET left_at = now()
  WHERE id = (
    SELECT id FROM public.session_attendance
    WHERE session_id = p_session_id
      AND user_id = v_caller
      AND left_at IS NULL
    ORDER BY joined_at DESC
    LIMIT 1
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_session_leave(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_session_leave(UUID) TO authenticated;
-- ─── 4. session_attended_seconds() ───────────────────────────────────────────
--
-- Helper used by the upcoming settlement logic. Sums attendance intervals
-- for a user in a session, clamped so:
--   - intervals stretching past the session's join-window upper bound
--     (scheduled_at + duration + 30 min grace) are cut at that bound;
--   - intervals with NULL left_at (still-open or abandoned) are treated as
--     closing at min(now(), upper bound).
--
-- Unscheduled sessions (scheduled_at IS NULL) clamp at joined_at + 4 hours
-- as a safety ceiling — those should be rare once the next migration adds
-- pending_review, and the 4-hour cap is generous enough to never falsely
-- under-credit a real long session.

CREATE OR REPLACE FUNCTION public.session_attended_seconds(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    SUM(
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          LEAST(
            COALESCE(a.left_at, now()),
            COALESCE(
              s.scheduled_at + ((s.duration_minutes + 30) * INTERVAL '1 minute'),
              a.joined_at + INTERVAL '4 hours'
            )
          ) - a.joined_at
        ))::integer
      )
    ),
    0
  )::integer
  FROM public.session_attendance a
  JOIN public.sessions s ON s.id = a.session_id
  WHERE a.session_id = p_session_id
    AND a.user_id = p_user_id;
$$;
REVOKE EXECUTE ON FUNCTION public.session_attended_seconds(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_attended_seconds(UUID, UUID) TO authenticated;
-- ─── 5. Lock down meet_link writes ───────────────────────────────────────────
--
-- Stop letting authenticated users set meet_link via direct table UPDATE.
-- The 20260509030000 migration granted UPDATE (meet_link, scheduled_at); we
-- keep scheduled_at (still needed by the existing schedule-edit UI) and
-- revoke meet_link. After this, the only writer is accept_session() below,
-- and it derives the value server-side from session_id.

REVOKE UPDATE (meet_link) ON public.sessions FROM anon, authenticated;
GRANT UPDATE (scheduled_at) ON public.sessions TO authenticated;
-- ─── 6. accept_session: server-derives meet_link ─────────────────────────────
--
-- Signature unchanged (p_meet_link still accepted) so existing callers don't
-- break, but the parameter is now ignored. meet_link is set to the internal
-- /video/<id> deep link — never an external URL — so the off-platform-
-- redirect surface from H1 is gone. The actual Jitsi URL is derived from
-- session_id by getVideoRoomUrl() on the client, and the room name is
-- derived from session_id + skill name in mint-jitsi-token; meet_link's
-- contents no longer steer either of those.

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
