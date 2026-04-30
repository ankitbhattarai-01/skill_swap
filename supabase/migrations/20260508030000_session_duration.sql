-- Time-based credit pricing: each session carries a chosen duration so that
-- credits = teacher's credits_per_hour * duration_minutes / 60. Existing rows
-- default to 60 minutes, which matches their current implicit pricing.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 60;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_duration_minutes_allowed
  CHECK (duration_minutes IN (30, 60, 90)) NOT VALID;
-- Lock duration once the session exists, mirroring the existing immutability
-- of participants, skill, and credits.
CREATE OR REPLACE FUNCTION public.protect_session_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.learner_id IS DISTINCT FROM NEW.learner_id
    OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id
    OR OLD.skill_id IS DISTINCT FROM NEW.skill_id
    OR OLD.credits IS DISTINCT FROM NEW.credits
    OR OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes THEN
    RAISE EXCEPTION 'Session participants, skill, credits, and duration cannot be changed';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected', 'cancelled'))
      OR (OLD.status = 'accepted' AND NEW.status IN ('completed', 'cancelled'))
      OR (OLD.status = 'active' AND NEW.status IN ('completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Invalid session status transition from % to %', OLD.status, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
