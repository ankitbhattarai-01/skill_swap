-- Fix five app-owned query performance hotspots from the Supabase
-- Query Performance report:
--   1. move_due_sessions_to_review()
--   2. teachers_free_time_status(...)
--   3. get_admin_feature_flags()
--   4. materialize_due_planned_sessions()  [since deleted — see section 3]
--   5. settle_pending_review_sessions()
--
-- The top report rows for realtime.list_changes and dashboard metadata are
-- Supabase-managed/internal workload, so this migration targets the expensive
-- statements owned by this application schema.

-- 1) Make availability and booking-conflict lookups cheaper for the bulk
-- teacher availability RPC.
CREATE INDEX IF NOT EXISTS user_availability_teach_lookup_idx
  ON public.user_availability (user_id, day_of_week, start_minute, end_minute)
  WHERE mode = 'teach';

CREATE INDEX IF NOT EXISTS sessions_teacher_active_schedule_idx
  ON public.sessions (teacher_id, scheduled_at, duration_minutes)
  WHERE status IN ('accepted', 'active', 'pending_review')
    AND scheduled_at IS NOT NULL;

-- 2) Make the scheduled session sweepers use narrow partial indexes.
--
-- (removed) sessions_review_scheduled_due_idx and
-- sessions_review_unscheduled_due_idx used to live here. They do not work:
-- move_due_sessions_to_review() below matches due rows with a single OR
-- spanning both partial predicates, so neither index matches the whole qual and
-- the planner seq-scans anyway. 20260526040000 dropped them for that reason,
-- but this migration was applied to production *after* that one and re-created
-- both, so 20260725030000 had to drop them a second time. Removed from the
-- source here so a future re-apply cannot bring them back again.
--
-- sessions_pending_review_unsettled_idx is kept: settle_pending_review_sessions()
-- filters on status = 'pending_review' AND escrow_held with no OR, so this one
-- the planner can actually use.
CREATE INDEX IF NOT EXISTS sessions_pending_review_unsettled_idx
  ON public.sessions (updated_at)
  WHERE status = 'pending_review'
    AND escrow_held = true;

-- 3) (removed) Two indexes on track_planned_sessions / learning_tracks used to
-- live here, supporting materialize_due_planned_sessions(). Learning tracks
-- were removed in 20260610000000, which drops both tables (CASCADE) and the
-- function itself — so applying this migration after that one failed with
-- 42P01 "relation public.track_planned_sessions does not exist", and applying
-- it in order would have created two indexes only to drop them again four
-- migrations later. Nothing else referenced them.

-- 4) Avoid RLS/admin-permission overhead for the public feature flag RPC.
-- The privileged body lives in private; the public function remains a thin
-- SECURITY INVOKER RPC wrapper, matching the project's security-lint pattern.
CREATE OR REPLACE FUNCTION private.get_admin_feature_flags_impl()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_object_agg(setting_key, current_value),
    '{}'::jsonb
  )
  FROM public.admin_active_settings
  WHERE setting_key IN (
    'features.ai_suggestions.enabled',
    'features.video_calls.enabled',
    'features.public_explore.enabled',
    'signup.starting_credits',
    'sessions.default_credits_per_hour'
  );
$$;

REVOKE EXECUTE ON FUNCTION private.get_admin_feature_flags_impl() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_admin_feature_flags_impl() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_feature_flags()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN (
      SELECT COALESCE(
        jsonb_object_agg(setting_key, current_value),
        '{}'::jsonb
      )
      FROM public.admin_active_settings
      WHERE setting_key IN (
        'features.ai_suggestions.enabled',
        'features.video_calls.enabled',
        'features.public_explore.enabled',
        'signup.starting_credits',
        'sessions.default_credits_per_hour'
      )
    );
  END IF;

  RETURN private.get_admin_feature_flags_impl();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_feature_flags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO anon, authenticated;

-- 5) Replace row-by-row status updates with one locked batch update. This
-- keeps the same behavior and return value, while cutting per-row PL/pgSQL
-- overhead on every cron run.
CREATE OR REPLACE FUNCTION public.move_due_sessions_to_review()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH due AS (
    SELECT id
    FROM public.sessions
    WHERE status IN ('accepted', 'active')
      AND escrow_held = true
      AND (
        (scheduled_at IS NOT NULL
          AND now() > scheduled_at + (duration_minutes * INTERVAL '1 minute') + INTERVAL '5 minutes')
        OR (scheduled_at IS NULL
          AND now() > updated_at + INTERVAL '7 days')
      )
    ORDER BY COALESCE(scheduled_at, updated_at)
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.sessions s
    SET status = 'pending_review'
    FROM due
    WHERE s.id = due.id
    RETURNING s.id
  )
  SELECT count(*)::integer INTO v_count
  FROM updated;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.move_due_sessions_to_review() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_due_sessions_to_review() TO service_role;

-- Keep settlement side effects inside auto_settle_session(), but feed it
-- from a locked, indexed batch.
CREATE OR REPLACE FUNCTION public.settle_pending_review_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_id    UUID;
BEGIN
  FOR v_id IN
    SELECT id
    FROM public.sessions
    WHERE status = 'pending_review'
      AND escrow_held = true
      AND updated_at < now() - INTERVAL '24 hours'
    ORDER BY updated_at
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.auto_settle_session(v_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_pending_review_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_pending_review_sessions() TO service_role;

NOTIFY pgrst, 'reload schema';
