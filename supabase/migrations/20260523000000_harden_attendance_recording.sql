-- =============================================================================
-- Critical #1 — Attendance forgery & escrow manipulation.
--
-- The 20260512040000 attendance schema assumed only mint-jitsi-token would
-- call record_session_join(). The grant is `authenticated`, though, so any
-- logged-in participant could forge attendance with a single RPC call from
-- the browser console — no Jitsi room entry required. Combined with
-- session_attended_seconds summing each interval independently (which lets
-- the same user double-count two overlapping rows), this gives a
-- straightforward path to manipulating auto_settle outcomes and dodging
-- no-show strikes.
--
-- This migration closes the three holes the master bug register calls out:
--
--   1. "Users can directly call the attendance recording function."
--      → Replace record_session_join(p_session_id) with a new service-role-
--        only signature record_session_join_for(p_session_id, p_user_id)
--        that takes the user explicitly. Only mint-jitsi-token (running
--        with the service role) can call it. The old auth.uid()-based
--        version is dropped — its grant was the bug.
--
--   2. "Attendance is recorded before actually joining the Jitsi meeting."
--      → Add session_attendance.last_heartbeat_at and a
--        record_session_heartbeat() RPC the client calls every ~30s while
--        in the Jitsi room. session_attended_seconds() now clamps any
--        interval with NULL left_at to last_heartbeat_at + 90s. A row that
--        was created by mint-jitsi-token but never followed by a heartbeat
--        decays to a tiny credited window instead of expanding to fill the
--        full session duration. (The mint-token + open-attendance forge
--        path still requires being a real participant inside the join
--        window — a webhook-based confirmation would close it further, but
--        that needs a JaaS feature we don't have yet.)
--
--   3. "Multiple overlapping join records are counted separately /
--       Attendance duration is summed incorrectly."
--      → session_attended_seconds() now folds the per-row intervals through
--        range_agg() (Postgres 14+) before summing, so two overlapping
--        intervals contribute their UNION's length, not the sum of their
--        lengths. A user reloading their tab three times in 5 minutes
--        gets credited for 5 minutes, not 15.
-- =============================================================================


-- ─── 1. Heartbeat column ─────────────────────────────────────────────────────

ALTER TABLE public.session_attendance
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
-- ─── 2. New service-role-only join recorder ──────────────────────────────────
--
-- The Edge Function already runs with the service role for this call (see
-- the companion patch to supabase/functions/mint-jitsi-token), so auth.uid()
-- is NULL inside this function. The caller is trusted to pass the right
-- user_id because the only writer is the edge function, which derives it
-- from a verified JWT before calling. Authenticated/anon are revoked from
-- both signatures: the old one was the forge surface; the new one is
-- privileged.

CREATE OR REPLACE FUNCTION public.record_session_join_for(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_row_id  UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;

  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF p_user_id <> v_session.learner_id AND p_user_id <> v_session.teacher_id THEN
    RAISE EXCEPTION 'Not a participant of this session';
  END IF;

  IF v_session.status NOT IN ('accepted', 'active') THEN
    RAISE EXCEPTION 'Session is not joinable in status %', v_session.status;
  END IF;

  INSERT INTO public.session_attendance (session_id, user_id, joined_at, last_heartbeat_at)
  VALUES (p_session_id, p_user_id, now(), now())
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_session_join_for(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_session_join_for(UUID, UUID) TO service_role;
-- Drop the old auth.uid()-based signature. Authenticated callers used to be
-- able to forge attendance with a direct RPC call; revoking is not enough
-- because the function would still work for service-role-callers without
-- carrying the new attestation, so we remove it entirely.

DROP FUNCTION IF EXISTS public.record_session_join(UUID);
-- ─── 3. Heartbeat RPC ────────────────────────────────────────────────────────
--
-- Closes the most recent open attendance row's last_heartbeat_at. Called
-- from the browser every ~30 seconds while the Jitsi External API reports
-- the user is in the conference. No-op when no open interval exists, so a
-- caller without an attendance row (i.e. never minted a JWT) can't manifest
-- one this way.

CREATE OR REPLACE FUNCTION public.record_session_heartbeat(p_session_id UUID)
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
  SET last_heartbeat_at = now()
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
REVOKE EXECUTE ON FUNCTION public.record_session_heartbeat(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_session_heartbeat(UUID) TO authenticated;
-- ─── 4. Rewritten session_attended_seconds: merge + heartbeat-clamp ──────────
--
-- Two changes from 20260512040000's version:
--
--   (a) Open intervals (left_at IS NULL) now stop accruing 90s after the
--       last heartbeat. Rows created before this migration have
--       last_heartbeat_at = NULL — those decay to joined_at + 2 minutes,
--       which is enough to absorb a legitimate hangup-without-leave but
--       too short to inflate a forge.
--
--   (b) Per-row intervals are unioned via range_agg before being summed,
--       so overlapping rows for the same (session, user) contribute their
--       union's length once instead of being added separately.
--
-- The session-window clamp (scheduled_at + duration + 30min grace, or 4h
-- for unscheduled sessions) is preserved as the outer bound.

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
  WITH
    sess AS (
      SELECT scheduled_at, duration_minutes
      FROM public.sessions
      WHERE id = p_session_id
    ),
    bounded AS (
      SELECT
        a.joined_at AS lo,
        LEAST(
          CASE
            WHEN a.left_at IS NOT NULL THEN a.left_at
            WHEN a.last_heartbeat_at IS NOT NULL
              THEN LEAST(now(), a.last_heartbeat_at + INTERVAL '90 seconds')
            ELSE LEAST(now(), a.joined_at + INTERVAL '2 minutes')
          END,
          COALESCE(
            s.scheduled_at + ((s.duration_minutes + 30) * INTERVAL '1 minute'),
            a.joined_at + INTERVAL '4 hours'
          )
        ) AS hi
      FROM public.session_attendance a
      CROSS JOIN sess s
      WHERE a.session_id = p_session_id
        AND a.user_id    = p_user_id
    ),
    valid AS (
      SELECT tstzrange(lo, hi) AS r FROM bounded WHERE hi > lo
    ),
    merged AS (
      SELECT unnest(range_agg(r)) AS r FROM valid
    )
  SELECT COALESCE(
    SUM(EXTRACT(EPOCH FROM (upper(r) - lower(r))))::int,
    0
  )
  FROM merged;
$$;
REVOKE EXECUTE ON FUNCTION public.session_attended_seconds(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_attended_seconds(UUID, UUID) TO authenticated;
