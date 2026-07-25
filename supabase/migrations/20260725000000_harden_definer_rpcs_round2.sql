-- =============================================================================
-- Supabase security advisors 0028 / 0029 — SECURITY DEFINER functions that the
-- `anon` / `authenticated` roles can execute through /rest/v1/rpc.
--
-- Eight functions are flagged. They fall into three groups, each with its own
-- fix — the same three the earlier rounds (20260513040000, 20260513190000,
-- 20260519030000, 20260531000000) used:
--
--   1. TRIGGER functions — sync_skill_verification_level() and
--      clear_skill_verification_on_unteach(). These only ever run from a
--      trigger on user_teaching_skills; nobody should be able to call them as
--      an RPC. Both were created by 20260719000000 without an explicit REVOKE,
--      so Supabase's default privileges on schema public handed EXECUTE to
--      anon AND authenticated. Straight revoke. Postgres checks EXECUTE on a
--      trigger function at CREATE TRIGGER time, not on each fire, so the two
--      live triggers keep working.
--
--   2. An INTERNAL HELPER — session_attended_seconds(uuid, uuid).
--      20260513040000 already revoked it, but 20260523000000 rewrote it (merge
--      + heartbeat-clamp) and re-granted `authenticated` on line 207, which
--      undid that. Every caller — auto_settle_session, complete_session,
--      admin_resolve_dispute — is itself SECURITY DEFINER and runs as the
--      function owner, so no caller needs the client-facing grant. Revoke it
--      again, permanently this time.
--
--   3. CLIENT / ADMIN RPCs that genuinely need definer rights —
--      cancel_session, admin_set_user_admin, get_teacher_windows,
--      record_practice_answer, record_session_heartbeat. Same treatment as
--      accept_session and get_or_create_conversation: the privileged body
--      moves to the `private` schema (PostgREST does not expose it, so the
--      advisor stops flagging it) and a thin SECURITY INVOKER wrapper keeps
--      the public name. RPC names, argument lists, defaults and return shapes
--      are all unchanged, so no client code and no regenerated types are
--      needed.
--
-- Why some of these regressed after an earlier round: 20260523010000 and
-- 20260612210000 re-created public.cancel_session as a full definer body in
-- public (undoing the 20260513190000 wrapper), and 20260615030000 did the same
-- to public.get_teacher_windows. Every re-CREATE in `public` also picks up
-- Supabase's default privileges, which is why record_practice_answer shows up
-- for `anon` despite its own REVOKE ALL ... FROM PUBLIC — that revoke never
-- touched anon's *explicit* grant.
--
-- Not addressed here: the "Leaked Password Protection Disabled" advisor. That
-- is an Auth dashboard toggle, not a migration.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;


-- ─── 1. Trigger functions: not RPCs ──────────────────────────────────────────
-- They stay SECURITY DEFINER (clearing a badge writes to skill_verifications,
-- which the owner of the teaching skill has no direct DELETE grant on); they
-- just stop being callable from the API.

REVOKE EXECUTE ON FUNCTION public.sync_skill_verification_level()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.clear_skill_verification_on_unteach()
  FROM PUBLIC, anon, authenticated;


-- ─── 2. session_attended_seconds: internal settlement helper ─────────────────

REVOKE EXECUTE ON FUNCTION public.session_attended_seconds(UUID, UUID)
  FROM PUBLIC, anon, authenticated;


-- ─── 3a. Clear the stale private.cancel_session before reclaiming the name ───
-- 20260513190000 moved the then-current cancel_session into `private`, and
-- 20260523010000 then re-created a fresh definer body in `public` without
-- dropping it. The leftover private copy is dead code carrying the pre-fix
-- refund path (full refund regardless of elapsed time), so dropping it is both
-- a prerequisite for the move below and a cleanup worth doing on its own.
--
-- Guarded on prosecdef so a re-run of this migration — when private.cancel_
-- session IS the live implementation — cannot drop the real one.
DO $$
DECLARE
  v_public_oid oid := to_regprocedure('public.cancel_session(uuid)');
BEGIN
  IF v_public_oid IS NOT NULL
     AND (SELECT prosecdef FROM pg_proc WHERE oid = v_public_oid)
  THEN
    DROP FUNCTION IF EXISTS private.cancel_session(uuid);
  END IF;
END;
$$;


-- ─── 3b. Move the five privileged bodies out of the exposed schema ───────────
-- Same guard: only move a function whose public entry is still the SECURITY
-- DEFINER body. On a re-run the public name holds the invoker wrapper created
-- in 3c, which must stay in public, and the loop skips it.
DO $$
DECLARE
  v_signature TEXT;
  v_oid oid;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.cancel_session(uuid)',
    'public.admin_set_user_admin(uuid, boolean, text, text, text)',
    'public.get_teacher_windows(uuid, integer)',
    'public.record_practice_answer(uuid, text, boolean)',
    'public.record_session_heartbeat(uuid)'
  ]
  LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NOT NULL AND (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      EXECUTE format('ALTER FUNCTION %s SET SCHEMA private', v_signature);
    END IF;
  END LOOP;
END;
$$;

-- The moved functions carry their old ACLs with them, including the anon grant
-- Supabase's default privileges handed to record_practice_answer. Reset them:
-- only signed-in callers, reaching them through the wrappers below.
REVOKE EXECUTE ON FUNCTION private.cancel_session(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.get_teacher_windows(UUID, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.record_practice_answer(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.record_session_heartbeat(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.cancel_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.get_teacher_windows(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.record_practice_answer(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION private.record_session_heartbeat(UUID) TO authenticated;


-- ─── 3c. Public SECURITY INVOKER wrappers — unchanged names and signatures ───
-- Each wrapper is a pass-through. The identity checks the bodies rely on are
-- untouched: auth.uid() reads the request's JWT claims, not the effective
-- role, so it returns the same user inside an invoker wrapper as it did in the
-- definer function.

CREATE OR REPLACE FUNCTION public.cancel_session(p_session_id UUID)
RETURNS public.sessions
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.cancel_session(p_session_id);
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_session(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION public.admin_set_user_admin(
  p_user_id UUID,
  p_make_admin BOOLEAN,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.admin_set_user_admin(
    p_user_id, p_make_admin, p_reason_code, p_justification, p_ticket_ref
  );
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT)
  TO authenticated;


-- The DEFAULT is repeated here so callers that omit p_horizon_days (the RPC is
-- called with both, but the SQL caller in 20260519020000 relies on the arity)
-- keep the same 14-day horizon.
CREATE OR REPLACE FUNCTION public.get_teacher_windows(
  p_teacher_id UUID,
  p_horizon_days INT DEFAULT 14
)
RETURNS TABLE (window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT w.window_start, w.window_end
  FROM private.get_teacher_windows(p_teacher_id, p_horizon_days) w;
$$;
REVOKE EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_windows(UUID, INT) TO authenticated;


CREATE OR REPLACE FUNCTION public.record_practice_answer(
  p_skill_id UUID,
  p_level    TEXT,
  p_correct  BOOLEAN
)
RETURNS TABLE (solved INT, attempted INT)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT r.solved, r.attempted
  FROM private.record_practice_answer(p_skill_id, p_level, p_correct) r;
$$;
REVOKE EXECUTE ON FUNCTION public.record_practice_answer(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_practice_answer(UUID, TEXT, BOOLEAN) TO authenticated;


CREATE OR REPLACE FUNCTION public.record_session_heartbeat(p_session_id UUID)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.record_session_heartbeat(p_session_id);
$$;
REVOKE EXECUTE ON FUNCTION public.record_session_heartbeat(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_session_heartbeat(UUID) TO authenticated;


NOTIFY pgrst, 'reload schema';
