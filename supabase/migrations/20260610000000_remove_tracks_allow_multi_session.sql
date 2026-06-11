-- =============================================================================
-- Remove learning tracks; book multiple sessions as plain sessions instead.
--
-- The "learning track" abstraction (a proposal wrapping N planned sessions,
-- materialized 48h ahead by a sweeper) added a parallel accept/notify surface
-- and its materializer was never even scheduled, so tracks never produced real
-- sessions. We're replacing it with the obvious thing: when a learner wants
-- several sessions, we just create one ordinary pending session per chosen
-- time. Each flows through the existing request → accept → escrow → settle
-- lifecycle, shows up on the dashboard, fires the normal `session_requested`
-- notification, and is accepted individually.
--
-- Two parts:
--   1. Relax the "one open session per pair+skill" unique index so a learner
--      can hold several open sessions for the same skill, as long as each is at
--      a different time (a same-time duplicate is still rejected).
--   2. Drop the learning-tracks tables, the sessions.track_id column, and all
--      track RPCs.
-- =============================================================================


-- ─── 1. Allow multiple open sessions at distinct times ───────────────────────
-- The old index (20260427094000) keyed on (learner, teacher, skill) and so
-- capped a pair+skill at a single open session. Add scheduled_at to the key so
-- distinct times are allowed; COALESCE keeps the "no duplicate" guarantee for
-- the (rare) null-time case.
DROP INDEX IF EXISTS public.sessions_one_open_request_per_skill;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_request_per_skill_time
  ON public.sessions
    (learner_id, teacher_id, skill_id, (COALESCE(scheduled_at, '-infinity'::timestamptz)))
  WHERE status IN ('pending', 'accepted', 'active');


-- ─── 2. Drop the learning-tracks feature ─────────────────────────────────────
-- Drop the RPCs we can name (some were relocated to the `private` schema by the
-- 20260513* security-hardening migrations, e.g. private.propose_track), then the
-- sessions back-link column, then the tables with CASCADE. CASCADE is the safety
-- net: it removes any remaining function that still depends on the
-- learning_tracks row type — public OR private — without us having to enumerate
-- every signature. All guarded with IF EXISTS so this is safe to re-run.
DROP FUNCTION IF EXISTS public.get_my_tracks();
DROP FUNCTION IF EXISTS public.materialize_due_planned_sessions();
DROP FUNCTION IF EXISTS public.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS private.propose_track(UUID, UUID, TEXT, TEXT, INT, INT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.propose_track_custom(UUID, UUID, INT, TIMESTAMPTZ[]);
DROP FUNCTION IF EXISTS private.propose_track_custom(UUID, UUID, INT, TIMESTAMPTZ[]);
DROP FUNCTION IF EXISTS public.accept_track(UUID);
DROP FUNCTION IF EXISTS public.reject_track(UUID, TEXT);
DROP FUNCTION IF EXISTS public.end_track(UUID, TEXT);

ALTER TABLE public.sessions DROP COLUMN IF EXISTS track_id;

DROP TABLE IF EXISTS public.track_planned_sessions CASCADE;
DROP TABLE IF EXISTS public.learning_tracks CASCADE;

NOTIFY pgrst, 'reload schema';
