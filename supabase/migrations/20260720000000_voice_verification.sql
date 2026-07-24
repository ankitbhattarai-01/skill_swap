-- Voice skill verification — one question at a time, on a server-held clock.
--
-- The text quiz shipped all 8 questions to the client at `start` and graded a
-- client-supplied answer array at `submit`. That is fine for correctness (the
-- answer key never left the server) but it is trivially screenshot-able, and
-- there was no per-question time pressure at all: a user could sit on the
-- payload for the full 45-minute attempt TTL and look everything up.
--
-- The voice flow serves ONE question per round-trip and reads it aloud instead
-- of rendering it. That needs two facts stored per question:
--
--   served_at    — when the server handed this question out. The answer
--                  deadline is derived from it, SERVER-SIDE. A client-side
--                  countdown alone is worthless; anyone can pause a timer in
--                  devtools. Stamped once and never re-stamped, so reloading
--                  the page mid-question cannot buy more time.
--   chosen_index — the answer, recorded as it arrives rather than submitted in
--                  one array at the end. NULL means "not answered yet" and is
--                  how the server knows which question to serve next; -1 means
--                  "the clock ran out", which grades as wrong but is distinct
--                  from a wrong pick in the audit trail.
--
-- Both columns are nullable additions to an existing table, so the text quiz
-- keeps working against the same rows while this rolls out.

ALTER TABLE public.skill_verification_questions
  ADD COLUMN IF NOT EXISTS served_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chosen_index INT;

ALTER TABLE public.skill_verification_questions
  DROP CONSTRAINT IF EXISTS skill_verification_questions_chosen_chk;

-- -1 is the timeout sentinel; 0..3 are real picks. Anything else is a bug in
-- the Edge Function and should fail loudly rather than quietly grade as wrong.
ALTER TABLE public.skill_verification_questions
  ADD CONSTRAINT skill_verification_questions_chosen_chk
    CHECK (chosen_index IS NULL OR chosen_index BETWEEN -1 AND 3);

-- The hot query in the voice flow is "next unanswered question for this
-- attempt, lowest position first". Without this it is a seq scan of every
-- question row on every single question served.
CREATE INDEX IF NOT EXISTS skill_verification_questions_pending_idx
  ON public.skill_verification_questions (attempt_id, position)
  WHERE chosen_index IS NULL;

-- No RLS or grant changes: this table still has RLS enabled with no policy for
-- `authenticated`, so the new columns are as invisible to clients as
-- correct_index is. Only the service role reads them.
