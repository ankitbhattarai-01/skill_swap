-- =============================================================================
-- Prevent double-booking: a person can't be committed to two overlapping
-- sessions at once.
--
-- The problem (reported from the dashboard): Sulav and Utsab agree a skill swap
-- for the 7–8 PM and 8–9 PM slots, so Utsab is busy teaching/learning the whole
-- evening. A THIRD learner then sends Utsab a normal session request at 8 PM the
-- same day and Utsab accepts it. Now two of Utsab's sessions start at 8 PM and
-- he can only attend one — the other party is stood up.
--
-- Why nothing caught it before:
--   • propose_swap (20260612210000) only checks that the two legs of the SAME
--     swap don't overlap each other.
--   • the sessions_one_open_request_per_skill_time unique index (20260610000000)
--     only blocks the SAME (learner, teacher, skill, time) tuple — a different
--     learner, or a different skill, or a swap leg vs. a normal session, all sit
--     in different index entries and never collide.
-- Neither looks across a single user's whole calendar.
--
-- Fix: one BEFORE INSERT/UPDATE trigger on sessions. Whenever a row enters (or
-- is rescheduled while in) a committed state — 'accepted' or 'active' — we
-- reject it if EITHER participant already has another committed session whose
-- [start, start + duration) window overlaps. Putting the rule in a trigger
-- rather than in each RPC means every commit path is covered at once:
-- accept_session, respond_to_swap (both legs), and the two-sided reschedule
-- accept — without re-deriving their large verbatim bodies.
--
-- 'pending' is deliberately NOT guarded: a teacher may receive many overlapping
-- pending requests for the same slot; they simply can't accept more than one.
-- The clash is only real once a second one is accepted.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.prevent_session_time_conflict()
RETURNS TRIGGER
-- SECURITY DEFINER: RLS hides a learner's sessions with third parties from the
-- teacher who's accepting, but we must check the OTHER party's whole calendar
-- too. Running as owner bypasses RLS so both sides are fully visible.
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only committed, time-anchored rows can clash. Pending requests and
  -- unscheduled rows are free to pile up.
  IF NEW.status NOT IN ('accepted', 'active') OR NEW.scheduled_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- An already-committed row that isn't changing its time, length, or
  -- participants (e.g. accepted → active, or a meet_link / escrow flag update)
  -- was validated when it first committed — don't re-check it.
  IF TG_OP = 'UPDATE'
     AND OLD.status IN ('accepted', 'active')
     AND OLD.scheduled_at IS NOT DISTINCT FROM NEW.scheduled_at
     AND OLD.duration_minutes IS NOT DISTINCT FROM NEW.duration_minutes
     AND OLD.teacher_id = NEW.teacher_id
     AND OLD.learner_id = NEW.learner_id THEN
    RETURN NEW;
  END IF;

  -- Overlap test for both parties: standard half-open interval intersection,
  --   existing.start < new.end  AND  new.start < existing.end
  -- excluding this row itself and, for swaps, its paired leg (the two legs are
  -- guaranteed non-overlapping by propose_swap, and during respond_to_swap both
  -- flip to 'accepted' in one statement — skipping the sibling avoids a row
  -- racing its own pair).

  -- Teacher can't teach two things at once (or teach one while learning).
  IF EXISTS (
    SELECT 1 FROM public.sessions o
    WHERE o.id <> NEW.id
      AND (NEW.swap_id IS NULL OR o.swap_id IS DISTINCT FROM NEW.swap_id)
      AND o.status IN ('accepted', 'active')
      AND o.scheduled_at IS NOT NULL
      AND (o.teacher_id = NEW.teacher_id OR o.learner_id = NEW.teacher_id)
      AND o.scheduled_at < NEW.scheduled_at + (NEW.duration_minutes * INTERVAL '1 minute')
      AND NEW.scheduled_at < o.scheduled_at + (o.duration_minutes * INTERVAL '1 minute')
  ) THEN
    RAISE EXCEPTION 'This time clashes with another session the teacher is already booked for. Pick a time that doesn''t overlap.'
      USING ERRCODE = 'exclusion_violation';
  END IF;

  -- Learner can't be in two sessions at once either.
  IF EXISTS (
    SELECT 1 FROM public.sessions o
    WHERE o.id <> NEW.id
      AND (NEW.swap_id IS NULL OR o.swap_id IS DISTINCT FROM NEW.swap_id)
      AND o.status IN ('accepted', 'active')
      AND o.scheduled_at IS NOT NULL
      AND (o.teacher_id = NEW.learner_id OR o.learner_id = NEW.learner_id)
      AND o.scheduled_at < NEW.scheduled_at + (NEW.duration_minutes * INTERVAL '1 minute')
      AND NEW.scheduled_at < o.scheduled_at + (o.duration_minutes * INTERVAL '1 minute')
  ) THEN
    RAISE EXCEPTION 'This time clashes with another session the learner is already booked for. Pick a time that doesn''t overlap.'
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Not meant to be called directly; it only runs as a trigger.
REVOKE EXECUTE ON FUNCTION public.prevent_session_time_conflict() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sessions_prevent_time_conflict ON public.sessions;
CREATE TRIGGER sessions_prevent_time_conflict
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_session_time_conflict();


-- Note: this guards future commits only. Any double-bookings created before
-- this migration (e.g. the 8 PM pair above) stay as-is — picking which one to
-- drop is the participants' call, so they should cancel the extra session from
-- the dashboard.
NOTIFY pgrst, 'reload schema';
