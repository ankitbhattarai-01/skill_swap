-- =============================================================================
-- User availability + intersection-based slot suggestions.
--
-- The booking-time agreement problem today: when scheduling a session, both
-- parties guess at times that might work for the other. Result is either
-- a long chat thread of "how about 7pm? no, 8pm? 6pm Tue?" or a default
-- to "first proposal wins" which doesn't actually respect both schedules.
--
-- This migration introduces a weekly availability grid per user (separate
-- `learn` and `teach` modes), plus a SECURITY DEFINER function that computes
-- the intersection of two users' availability against the teacher's existing
-- bookings and returns the next N candidate start times.
--
-- Storage decision: availability is stored in UTC. The frontend converts
-- between the user's local TZ and UTC at save/display time, and the user's
-- `availability_tz` profile column tells the UI what TZ to use. Pros: SQL
-- is trivial (no per-row tz lookups, no DST funky business in queries).
-- Cons: a user who relocates needs to re-enter their windows. That's
-- acceptable for a peer-to-peer student app — DST/relocation correctness
-- can be revisited in a future migration.
--
-- Privacy: a user's raw availability is NEVER exposed to other users. Only
-- intersection *results* (concrete proposed timestamps) are returned via
-- the SECURITY DEFINER RPC. The user's own availability is readable only
-- by themselves via RLS.
--
-- This is part 1 of the user's design: the data and computation layer.
-- The UI for filtering Explore by availability and the slot-picker in
-- the booking dialog land alongside this migration but are independent
-- of the DB schema below.
-- =============================================================================


-- ─── 1. Availability TZ on profile ──────────────────────────────────────────
--
-- IANA TZ name (e.g. 'Asia/Kolkata'). Defaults to UTC; on first save the
-- frontend writes the browser's resolved TZ. The column is in the
-- public-readable GRANT (added below) so the explore-page UI can render
-- "Mon 8pm in your TZ" labels even before the viewer has set their own.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS availability_tz TEXT NOT NULL DEFAULT 'UTC';
-- Expose to clients (the column-level GRANT list was set in
-- 20260511050000_hide_public_credits.sql; we additively grant SELECT on
-- the new column here).
GRANT SELECT (availability_tz) ON public.profiles TO anon, authenticated;
-- ─── 2. user_availability table ─────────────────────────────────────────────
--
-- One row per weekly window. start_minute and end_minute are minutes past
-- UTC midnight for a given UTC day-of-week. day_of_week follows the
-- PostgreSQL convention 0=Sunday..6=Saturday. A user splitting "evenings"
-- across two UTC days will have two rows.

CREATE TABLE IF NOT EXISTS public.user_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('learn', 'teach')),
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute SMALLINT NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute SMALLINT NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX IF NOT EXISTS user_availability_user_mode_idx
  ON public.user_availability (user_id, mode);
CREATE INDEX IF NOT EXISTS user_availability_mode_dow_idx
  ON public.user_availability (mode, day_of_week);
ALTER TABLE public.user_availability ENABLE ROW LEVEL SECURITY;
-- Users can read their own raw schedule. Nobody else can — peer schedules
-- are only ever visible as intersection results via the RPC below.
DROP POLICY IF EXISTS "Users view own availability" ON public.user_availability;
CREATE POLICY "Users view own availability" ON public.user_availability
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- Writes are RPC-only.
REVOKE INSERT, UPDATE, DELETE ON public.user_availability FROM anon, authenticated;
-- ─── 3. set_my_availability — replace caller's windows for a mode ───────────
--
-- Atomic "replace all" semantics: delete the user's existing windows of
-- the given mode, insert the new ones from the JSONB array. Frontend
-- always sends the full desired schedule for one mode at a time.
--
-- p_windows shape: [{"day": 0, "start": 480, "end": 600}, ...]
-- p_tz, when supplied, also updates the profile so future intersection
-- displays use the right TZ name.

CREATE OR REPLACE FUNCTION public.set_my_availability(
  p_mode TEXT,
  p_windows JSONB,
  p_tz TEXT DEFAULT NULL
)
RETURNS SETOF public.user_availability
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_row JSONB;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_mode NOT IN ('learn', 'teach') THEN
    RAISE EXCEPTION 'p_mode must be learn or teach';
  END IF;
  IF jsonb_typeof(p_windows) <> 'array' THEN
    RAISE EXCEPTION 'p_windows must be a JSON array';
  END IF;

  -- Optional TZ update.
  IF p_tz IS NOT NULL AND length(p_tz) BETWEEN 3 AND 64 THEN
    UPDATE public.profiles SET availability_tz = p_tz WHERE id = v_user;
  END IF;

  -- Replace mode windows.
  DELETE FROM public.user_availability
  WHERE user_id = v_user AND mode = p_mode;

  -- Cap the count at 21 windows per mode (3 per day max) to keep the
  -- intersection function bounded and prevent abuse.
  IF jsonb_array_length(p_windows) > 21 THEN
    RAISE EXCEPTION 'Too many windows (max 21 per mode)';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_windows) LOOP
    INSERT INTO public.user_availability (
      user_id, mode, day_of_week, start_minute, end_minute
    ) VALUES (
      v_user, p_mode,
      (v_row->>'day')::smallint,
      (v_row->>'start')::smallint,
      (v_row->>'end')::smallint
    );
  END LOOP;

  RETURN QUERY
  SELECT * FROM public.user_availability
  WHERE user_id = v_user AND mode = p_mode
  ORDER BY day_of_week, start_minute;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_my_availability(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_availability(TEXT, JSONB, TEXT) TO authenticated;
-- ─── 4. get_my_availability — caller reads their own schedule ──────────────

CREATE OR REPLACE FUNCTION public.get_my_availability(p_mode TEXT DEFAULT NULL)
RETURNS SETOF public.user_availability
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.user_availability
  WHERE user_id = auth.uid()
    AND (p_mode IS NULL OR mode = p_mode)
  ORDER BY mode, day_of_week, start_minute;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_availability(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_availability(TEXT) TO authenticated;
-- ─── 5. compute_intersection_slots — the intersection engine ────────────────
--
-- Given a learner and teacher, walks the next `p_horizon_days` UTC days
-- and finds candidate start times where:
--   - learner has a 'learn' window covering [t, t + duration]
--   - teacher has a 'teach' window covering [t, t + duration]
--   - teacher has no overlapping booked session in (accepted, active,
--     pending_review)
--   - t is in the future
--
-- Returns up to p_max_slots slots, ordered earliest-first.
--
-- This function is SECURITY DEFINER so it can read both users' raw
-- availability without exposing the rows to the caller.

CREATE OR REPLACE FUNCTION public.compute_intersection_slots(
  p_learner_id UUID,
  p_teacher_id UUID,
  p_duration_minutes INT,
  p_horizon_days INT DEFAULT 7,
  p_max_slots INT DEFAULT 3
)
RETURNS TABLE (proposed_start TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_horizon INT := LEAST(GREATEST(COALESCE(p_horizon_days, 7), 1), 30);
  v_max    INT := LEAST(GREATEST(COALESCE(p_max_slots, 3), 1), 10);
  v_duration_min INT := LEAST(GREATEST(p_duration_minutes, 5), 240);
BEGIN
  -- Privacy: the caller must be one of the two parties involved, OR an
  -- admin. Otherwise anyone could probe arbitrary pairs for their
  -- schedules via proxy.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_caller <> p_learner_id
     AND v_caller <> p_teacher_id
     AND NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not allowed to compute slots for this pair';
  END IF;

  RETURN QUERY
  WITH RECURSIVE day_offsets AS (
    SELECT 0 AS d
    UNION ALL
    SELECT d + 1 FROM day_offsets WHERE d + 1 < v_horizon
  ),
  candidate_days AS (
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'UTC') + (d || ' day')::interval) AS day_start
    FROM day_offsets
  ),
  -- Each candidate day produces 0..N learner windows landing on that UTC DOW.
  learner_windows AS (
    SELECT
      cd.day_start + ((la.start_minute) || ' minutes')::interval AS w_start,
      cd.day_start + ((la.end_minute)   || ' minutes')::interval AS w_end
    FROM candidate_days cd
    JOIN public.user_availability la
      ON la.user_id = p_learner_id
     AND la.mode = 'learn'
     AND la.day_of_week = EXTRACT(DOW FROM cd.day_start)::smallint
  ),
  teacher_windows AS (
    SELECT
      cd.day_start + ((ta.start_minute) || ' minutes')::interval AS w_start,
      cd.day_start + ((ta.end_minute)   || ' minutes')::interval AS w_end
    FROM candidate_days cd
    JOIN public.user_availability ta
      ON ta.user_id = p_teacher_id
     AND ta.mode = 'teach'
     AND ta.day_of_week = EXTRACT(DOW FROM cd.day_start)::smallint
  ),
  intersections AS (
    SELECT
      GREATEST(lw.w_start, tw.w_start) AS int_start,
      LEAST(lw.w_end, tw.w_end)        AS int_end
    FROM learner_windows lw, teacher_windows tw
    WHERE GREATEST(lw.w_start, tw.w_start) < LEAST(lw.w_end, tw.w_end)
  ),
  -- Within each intersection block, only the start is a viable session
  -- start. We could also offer mid-block starts, but for an MVP "earliest
  -- aligned start that fits" is simpler and good UX.
  candidate_slots AS (
    SELECT int_start AS slot_start
    FROM intersections
    WHERE int_start > now()
      AND (int_end - int_start) >= make_interval(mins => v_duration_min)
  ),
  -- Subtract teacher's existing commitments. Use tstzrange overlap.
  slots_minus_conflicts AS (
    SELECT cs.slot_start
    FROM candidate_slots cs
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.teacher_id = p_teacher_id
        AND s.status IN ('accepted', 'active', 'pending_review')
        AND s.scheduled_at IS NOT NULL
        AND tstzrange(
              s.scheduled_at,
              s.scheduled_at + make_interval(mins => s.duration_minutes)
            )
            && tstzrange(
              cs.slot_start,
              cs.slot_start + make_interval(mins => v_duration_min)
            )
    )
  )
  SELECT slot_start
  FROM slots_minus_conflicts
  ORDER BY slot_start
  LIMIT v_max;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_intersection_slots(UUID, UUID, INT, INT, INT) TO authenticated;
-- ─── 6. has_any_intersection — fast "do we ever overlap?" check ──────────────
--
-- For the Explore page: rather than computing all slots for every teacher
-- (expensive), this just answers "is there any intersection in the next
-- N days?" as a boolean. The Explore UI can call this per teacher and
-- gray out / hide those who don't intersect.

CREATE OR REPLACE FUNCTION public.has_any_intersection(
  p_learner_id UUID,
  p_teacher_id UUID,
  p_duration_minutes INT DEFAULT 30,
  p_horizon_days INT DEFAULT 7
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.compute_intersection_slots(
      p_learner_id, p_teacher_id, p_duration_minutes, p_horizon_days, 1
    )
  );
$$;
REVOKE EXECUTE ON FUNCTION public.has_any_intersection(UUID, UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_any_intersection(UUID, UUID, INT, INT) TO authenticated;
