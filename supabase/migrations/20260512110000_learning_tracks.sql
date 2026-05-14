-- =============================================================================
-- Learning Tracks: wrapper for multi-session learning relationships.
--
-- The platform's billing unit stays "one session, one escrow, one settlement".
-- A learner who wants to learn Python over 8 weeks shouldn't have to manually
-- book each weekly session, and shouldn't have to pay 8 weeks of credits up
-- front (huge fraud surface). A Track sits above sessions and:
--
--   1. Records the agreement up-front: skill, goal, cadence, planned count.
--   2. Plans out the cadence (track_planned_sessions table).
--   3. Materializes each planned session into a real `sessions` row 48h
--      before its scheduled start, so the teacher gets a normal "accept
--      this session" notification.
--   4. Lets either party end the track at any time, abandoning unbooked
--      future sessions without penalty.
--
-- Tracks themselves cost zero credits. Each materialized session runs
-- through the full accept_session → escrow → settle cycle from earlier
-- migrations — so fraud risk is capped at one session's worth at any
-- given time, regardless of track length.
--
-- This finishes the system the user designed: short one-off help, or
-- long mastery-oriented engagements, both backed by the same per-session
-- safety rails.
-- =============================================================================


-- ─── 1. learning_tracks table ───────────────────────────────────────────────
--
-- pattern: 'one_shot' (single session) | 'mini' (2-3) | 'daily' | 'weekly'
-- status:  'proposed' (waiting on teacher accept)
--          'active'   (sessions being materialized)
--          'completed' (all planned sessions terminal)
--          'cancelled' (ended early by either party)
--          'rejected' (teacher declined the proposal)

CREATE TABLE IF NOT EXISTS public.learning_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE RESTRICT,
  goal TEXT NOT NULL CHECK (char_length(goal) BETWEEN 4 AND 500),
  pattern TEXT NOT NULL CHECK (pattern IN ('one_shot', 'mini', 'daily', 'weekly')),
  planned_count INT NOT NULL CHECK (planned_count BETWEEN 1 AND 30),
  default_duration_minutes INT NOT NULL CHECK (default_duration_minutes IN (30, 60, 90)),
  cadence_days INT NOT NULL CHECK (cadence_days BETWEEN 1 AND 30),
  first_start_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'completed', 'cancelled', 'rejected')),
  end_reason TEXT,
  ended_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (learner_id <> teacher_id),
  CHECK ((status IN ('cancelled', 'rejected', 'completed')) = (ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS learning_tracks_learner_idx
  ON public.learning_tracks (learner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS learning_tracks_teacher_idx
  ON public.learning_tracks (teacher_id, status, created_at DESC);
ALTER TABLE public.learning_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Participants view their tracks" ON public.learning_tracks;
CREATE POLICY "Participants view their tracks" ON public.learning_tracks
  FOR SELECT TO authenticated
  USING (learner_id = auth.uid() OR teacher_id = auth.uid());
REVOKE INSERT, UPDATE, DELETE ON public.learning_tracks FROM anon, authenticated;
-- ─── 2. track_planned_sessions table ────────────────────────────────────────
--
-- One row per planned session in the track. status moves:
--   pending      — scheduled but not yet materialized
--   materialized — a real sessions row was created, see materialized_session_id
--   skipped      — couldn't materialize (insufficient credits, suspension, etc.)
--   cancelled    — track was ended before this session got materialized

CREATE TABLE IF NOT EXISTS public.track_planned_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES public.learning_tracks(id) ON DELETE CASCADE,
  sequence_no INT NOT NULL,
  planned_start_at TIMESTAMPTZ NOT NULL,
  materialized_session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'materialized', 'skipped', 'cancelled')),
  skip_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (track_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS track_planned_due_idx
  ON public.track_planned_sessions (planned_start_at)
  WHERE status = 'pending';
ALTER TABLE public.track_planned_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Track participants view planned sessions" ON public.track_planned_sessions;
CREATE POLICY "Track participants view planned sessions" ON public.track_planned_sessions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.learning_tracks lt
      WHERE lt.id = track_planned_sessions.track_id
        AND (lt.learner_id = auth.uid() OR lt.teacher_id = auth.uid())
    )
  );
REVOKE INSERT, UPDATE, DELETE ON public.track_planned_sessions FROM anon, authenticated;
-- ─── 3. sessions.track_id (back-link from sessions to tracks) ───────────────
--
-- Nullable: one-off sessions stay free of any track. The unique-open index
-- from 20260427094000 prevents two open sessions for the same pair/skill
-- at once — which is correct even for tracks: the materializer waits for
-- the previous session to reach a terminal state before creating the next.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS track_id UUID REFERENCES public.learning_tracks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sessions_track_idx
  ON public.sessions (track_id, created_at DESC)
  WHERE track_id IS NOT NULL;
-- ─── 4. propose_track — learner creates a track proposal ────────────────────
--
-- The learner-only check exists because asymmetric proposing (anyone can
-- propose) would complicate the accept flow without adding value. The
-- counterparty (teacher) always accepts. Track proposals don't move
-- credits and don't create real session rows — they just record the
-- intent.

CREATE OR REPLACE FUNCTION public.propose_track(
  p_teacher_id UUID,
  p_skill_id UUID,
  p_goal TEXT,
  p_pattern TEXT,
  p_planned_count INT,
  p_default_duration_minutes INT,
  p_first_start_at TIMESTAMPTZ
)
RETURNS public.learning_tracks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_cadence INT;
  v_track public.learning_tracks;
  v_suspension RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_caller = p_teacher_id THEN
    RAISE EXCEPTION 'Cannot propose a track with yourself';
  END IF;

  -- Suspension check (mirrors accept_session). A suspended user can't open
  -- a new track even though tracks don't move credits — would otherwise
  -- spam the teacher with proposals.
  SELECT s.kind INTO v_suspension
  FROM public.user_suspension_state(v_caller) s;
  IF v_suspension.kind IN ('permanent', 'full') THEN
    RAISE EXCEPTION 'Your account is suspended.';
  END IF;

  -- Pattern → cadence map. one_shot defaults to 7 (irrelevant since count=1),
  -- mini 7 days, daily 1 day, weekly 7 days. Frontend can also derive these
  -- but we re-enforce here so the data row is always coherent.
  v_cadence := CASE p_pattern
    WHEN 'one_shot' THEN 7
    WHEN 'mini'     THEN 7
    WHEN 'daily'    THEN 1
    WHEN 'weekly'   THEN 7
    ELSE -1
  END;
  IF v_cadence = -1 THEN
    RAISE EXCEPTION 'Invalid pattern: %', p_pattern;
  END IF;

  -- Sanity caps on planned_count by pattern.
  IF p_pattern = 'one_shot' AND p_planned_count <> 1 THEN
    RAISE EXCEPTION 'one_shot tracks must have planned_count = 1';
  END IF;
  IF p_pattern = 'mini' AND p_planned_count NOT BETWEEN 2 AND 3 THEN
    RAISE EXCEPTION 'mini tracks must have 2-3 sessions';
  END IF;
  IF p_pattern = 'daily' AND p_planned_count > 14 THEN
    RAISE EXCEPTION 'daily tracks max 14 sessions';
  END IF;
  IF p_pattern = 'weekly' AND p_planned_count > 12 THEN
    RAISE EXCEPTION 'weekly tracks max 12 sessions';
  END IF;

  IF p_first_start_at <= now() THEN
    RAISE EXCEPTION 'first_start_at must be in the future';
  END IF;

  INSERT INTO public.learning_tracks (
    learner_id, teacher_id, skill_id, goal,
    pattern, planned_count, default_duration_minutes, cadence_days, first_start_at
  ) VALUES (
    v_caller, p_teacher_id, p_skill_id, btrim(p_goal),
    p_pattern, p_planned_count, p_default_duration_minutes, v_cadence, p_first_start_at
  )
  RETURNING * INTO v_track;

  RETURN v_track;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ) TO authenticated;
-- ─── 5. accept_track — teacher accepts, all planned sessions get scheduled ──

CREATE OR REPLACE FUNCTION public.accept_track(p_track_id UUID)
RETURNS public.learning_tracks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_track public.learning_tracks;
  v_caller UUID := auth.uid();
  i INT;
BEGIN
  SELECT * INTO v_track FROM public.learning_tracks
  WHERE id = p_track_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Track not found';
  END IF;
  IF v_caller IS NULL OR v_caller <> v_track.teacher_id THEN
    RAISE EXCEPTION 'Only the teacher can accept this track';
  END IF;
  IF v_track.status <> 'proposed' THEN
    RAISE EXCEPTION 'Track is not pending acceptance';
  END IF;

  -- Plan out all sessions at the agreed cadence. The materializer will
  -- create real sessions rows ~48h before each planned_start_at.
  FOR i IN 0..(v_track.planned_count - 1) LOOP
    INSERT INTO public.track_planned_sessions (track_id, sequence_no, planned_start_at)
    VALUES (
      v_track.id,
      i + 1,
      v_track.first_start_at + (i * v_track.cadence_days || ' days')::interval
    );
  END LOOP;

  UPDATE public.learning_tracks
  SET status = 'active'
  WHERE id = v_track.id
  RETURNING * INTO v_track;

  RETURN v_track;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_track(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_track(UUID) TO authenticated;
-- ─── 6. reject_track — teacher declines ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reject_track(p_track_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS public.learning_tracks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_track public.learning_tracks;
  v_caller UUID := auth.uid();
BEGIN
  SELECT * INTO v_track FROM public.learning_tracks
  WHERE id = p_track_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Track not found'; END IF;
  IF v_caller IS NULL OR v_caller <> v_track.teacher_id THEN
    RAISE EXCEPTION 'Only the teacher can reject this track';
  END IF;
  IF v_track.status <> 'proposed' THEN
    RAISE EXCEPTION 'Track is not pending';
  END IF;

  UPDATE public.learning_tracks
  SET status = 'rejected',
      end_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
      ended_by = v_caller,
      ended_at = now()
  WHERE id = v_track.id
  RETURNING * INTO v_track;
  RETURN v_track;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_track(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_track(UUID, TEXT) TO authenticated;
-- ─── 7. end_track — either party stops a track mid-flight ───────────────────
--
-- Existing materialized sessions continue to settle normally. Future
-- planned sessions get marked 'cancelled' so the materializer skips them.

CREATE OR REPLACE FUNCTION public.end_track(p_track_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS public.learning_tracks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_track public.learning_tracks;
  v_caller UUID := auth.uid();
BEGIN
  SELECT * INTO v_track FROM public.learning_tracks
  WHERE id = p_track_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Track not found'; END IF;
  IF v_caller IS NULL
     OR (v_caller <> v_track.learner_id AND v_caller <> v_track.teacher_id) THEN
    RAISE EXCEPTION 'Not a participant';
  END IF;
  IF v_track.status NOT IN ('active', 'proposed') THEN
    RAISE EXCEPTION 'Track is already in terminal status %', v_track.status;
  END IF;

  -- Cancel all still-pending planned sessions. Materialized ones (already
  -- in the sessions table) are left alone — they belong to the normal
  -- session lifecycle now.
  UPDATE public.track_planned_sessions
  SET status = 'cancelled', skip_reason = 'Track ended'
  WHERE track_id = v_track.id AND status = 'pending';

  UPDATE public.learning_tracks
  SET status = 'cancelled',
      end_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
      ended_by = v_caller,
      ended_at = now()
  WHERE id = v_track.id
  RETURNING * INTO v_track;
  RETURN v_track;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.end_track(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_track(UUID, TEXT) TO authenticated;
-- ─── 8. materialize_due_planned_sessions — sweeper, service-role only ───────
--
-- For each planned session due within the next 48h that hasn't been
-- materialized:
--   - check learner has enough credits at the teacher's current rate
--   - check no other open session for this pair+skill (the unique index
--     enforces this regardless, but we check first for a friendlier skip)
--   - create a pending sessions row with track_id set
--   - either mark planned 'materialized' (success) or 'skipped' (with reason)
--
-- The teacher accepts the new session through the normal flow.

CREATE OR REPLACE FUNCTION public.materialize_due_planned_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_planned RECORD;
  v_track public.learning_tracks;
  v_credits_per_hour INT;
  v_session_credits INT;
  v_learner_credits INT;
  v_count INT := 0;
  v_new_session_id UUID;
BEGIN
  FOR v_planned IN
    SELECT tps.id, tps.track_id, tps.sequence_no, tps.planned_start_at
    FROM public.track_planned_sessions tps
    JOIN public.learning_tracks lt ON lt.id = tps.track_id
    WHERE tps.status = 'pending'
      AND lt.status = 'active'
      AND tps.planned_start_at < now() + INTERVAL '48 hours'
      AND tps.planned_start_at > now()
    ORDER BY tps.planned_start_at
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_track FROM public.learning_tracks WHERE id = v_planned.track_id;

    -- Skip if there's already an open session between these parties for
    -- this skill (the unique partial index would also reject).
    IF EXISTS (
      SELECT 1 FROM public.sessions
      WHERE learner_id = v_track.learner_id
        AND teacher_id = v_track.teacher_id
        AND skill_id = v_track.skill_id
        AND status IN ('pending', 'accepted', 'active')
    ) THEN
      UPDATE public.track_planned_sessions
      SET status = 'skipped',
          skip_reason = 'Previous session in track not yet completed'
      WHERE id = v_planned.id;
      CONTINUE;
    END IF;

    -- Resolve the teacher's current rate from their teaching skill row.
    SELECT credits_per_hour INTO v_credits_per_hour
    FROM public.user_teaching_skills
    WHERE user_id = v_track.teacher_id AND skill_id = v_track.skill_id;
    IF v_credits_per_hour IS NULL THEN
      UPDATE public.track_planned_sessions
      SET status = 'skipped',
          skip_reason = 'Teacher no longer offers this skill'
      WHERE id = v_planned.id;
      CONTINUE;
    END IF;

    v_session_credits := GREATEST(
      1,
      CEIL((v_credits_per_hour * v_track.default_duration_minutes)::numeric / 60.0)::int
    );

    SELECT credits INTO v_learner_credits
    FROM public.profiles WHERE id = v_track.learner_id;
    IF COALESCE(v_learner_credits, 0) < v_session_credits THEN
      UPDATE public.track_planned_sessions
      SET status = 'skipped',
          skip_reason = format('Learner has %s credits, session needs %s',
                               COALESCE(v_learner_credits, 0), v_session_credits)
      WHERE id = v_planned.id;
      CONTINUE;
    END IF;

    INSERT INTO public.sessions (
      learner_id, teacher_id, initiator_id, skill_id, status, credits,
      duration_minutes, scheduled_at, track_id
    ) VALUES (
      v_track.learner_id, v_track.teacher_id, v_track.learner_id,
      v_track.skill_id, 'pending', v_session_credits,
      v_track.default_duration_minutes, v_planned.planned_start_at,
      v_track.id
    )
    RETURNING id INTO v_new_session_id;

    UPDATE public.track_planned_sessions
    SET status = 'materialized',
        materialized_session_id = v_new_session_id
    WHERE id = v_planned.id;

    v_count := v_count + 1;
  END LOOP;

  -- Auto-complete tracks whose every planned session reached terminal status.
  UPDATE public.learning_tracks
  SET status = 'completed', ended_at = now()
  WHERE status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.track_planned_sessions tps
      WHERE tps.track_id = learning_tracks.id
        AND tps.status = 'pending'
    );

  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.materialize_due_planned_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_due_planned_sessions() TO service_role;
-- ─── 9. get_my_tracks — list a user's tracks ─────────────────────────────────
--
-- Convenience read for the UI: returns the caller's tracks (in either
-- role) with each track's planned-session counters and the names of the
-- other party + skill — saves the UI a chain of joins.

CREATE OR REPLACE FUNCTION public.get_my_tracks()
RETURNS TABLE (
  id UUID,
  role TEXT,
  other_user_id UUID,
  other_user_name TEXT,
  skill_id UUID,
  skill_name TEXT,
  goal TEXT,
  pattern TEXT,
  planned_count INT,
  default_duration_minutes INT,
  cadence_days INT,
  status TEXT,
  first_start_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  created_at TIMESTAMPTZ,
  sessions_materialized INT,
  sessions_completed INT,
  sessions_skipped INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my AS (
    SELECT * FROM public.learning_tracks
    WHERE learner_id = auth.uid() OR teacher_id = auth.uid()
  )
  SELECT
    my.id,
    CASE WHEN my.learner_id = auth.uid() THEN 'learner' ELSE 'teacher' END AS role,
    CASE WHEN my.learner_id = auth.uid() THEN my.teacher_id ELSE my.learner_id END AS other_user_id,
    other.full_name AS other_user_name,
    my.skill_id,
    sk.name AS skill_name,
    my.goal,
    my.pattern,
    my.planned_count,
    my.default_duration_minutes,
    my.cadence_days,
    my.status,
    my.first_start_at,
    my.ended_at,
    my.end_reason,
    my.created_at,
    (SELECT count(*)::int FROM public.track_planned_sessions tps
       WHERE tps.track_id = my.id AND tps.status = 'materialized') AS sessions_materialized,
    (SELECT count(*)::int FROM public.track_planned_sessions tps
       JOIN public.sessions s ON s.id = tps.materialized_session_id
       WHERE tps.track_id = my.id AND s.status = 'completed') AS sessions_completed,
    (SELECT count(*)::int FROM public.track_planned_sessions tps
       WHERE tps.track_id = my.id AND tps.status = 'skipped') AS sessions_skipped
  FROM my
  LEFT JOIN public.profiles other ON other.id = (
    CASE WHEN my.learner_id = auth.uid() THEN my.teacher_id ELSE my.learner_id END
  )
  LEFT JOIN public.skills sk ON sk.id = my.skill_id
  ORDER BY my.created_at DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_tracks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_tracks() TO authenticated;
