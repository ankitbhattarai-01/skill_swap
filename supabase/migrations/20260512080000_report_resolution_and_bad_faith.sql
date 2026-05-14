-- =============================================================================
-- Report resolution sub-classification + bad-faith dismissal strikes.
--
-- Today the admin queue has one "Dismiss" button. That conflates two very
-- different cases: "couldn't substantiate / not enough evidence" and
-- "this reporter is deliberately filing fake reports to harass someone".
-- The first should be free; the second should cost the *reporter* a strike.
--
-- This migration:
--   1. Adds a `resolution` column to `reports` to record the sub-outcome
--      alongside the existing status. Open/reviewing rows have NULL
--      resolution; resolved/dismissed rows record why.
--   2. Extends admin_update_report_status() to accept the resolution and
--      fire an automatic strike on the appropriate party:
--        dismissed + bad_faith → strike on REPORTER (1)
--        resolved  + upheld_minor → strike on REPORTED (1)
--        resolved  + upheld_major → strike on REPORTED (2)
--        resolved  + upheld_severe → strike on REPORTED (4) — single-incident
--                                    permanent-suspension territory.
--   3. Audits the resolution alongside the status change so the moderator
--      action trail remains complete.
--
-- Closes:
--   H5 — Fake reporting is free. Bad-faith dismissals now cost the reporter
--        a strike. Three bad-faith strikes within the rolling window
--        triggers teaching suspension via the existing strike system, and
--        five triggers full suspension.
-- =============================================================================


-- ─── 1. Resolution column ────────────────────────────────────────────────────
--
-- The 'no_action' / 'bad_faith' split is the load-bearing part. Upheld
-- variants are about strike severity for the reported user; admins still
-- have the manual admin_issue_strike() escape hatch for unusual cases.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_resolution_allowed;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_resolution_allowed
  CHECK (
    resolution IS NULL
    OR resolution IN ('no_action', 'bad_faith', 'upheld_minor', 'upheld_major', 'upheld_severe')
  );
-- Status + resolution must agree:
--   open/reviewing → resolution IS NULL (no decision yet)
--   resolved       → resolution starts with 'upheld_'
--   dismissed      → resolution IN ('no_action', 'bad_faith')
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_status_resolution_consistent;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_status_resolution_consistent
  CHECK (
    (status IN ('open', 'reviewing') AND resolution IS NULL)
    OR (status = 'resolved' AND resolution LIKE 'upheld_%')
    OR (status = 'dismissed' AND resolution IN ('no_action', 'bad_faith'))
  ) NOT VALID;
-- NOT VALID so existing rows (which lack a resolution) don't fail the check.
-- New writes and any UPDATE that touches resolution must satisfy it.


-- ─── 2. Reworked admin_update_report_status ─────────────────────────────────
--
-- Adds a required p_resolution argument when moving to a terminal status.
-- Issues automatic strikes per the rule table in the file header. Preserves
-- the existing permission gate, idempotency key handling, and audit
-- event so the enterprise audit trail is unaffected.

CREATE OR REPLACE FUNCTION public.admin_update_report_status(
  p_report_id UUID,
  p_status TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_resolution TEXT DEFAULT NULL
)
RETURNS public.reports
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor       UUID := auth.uid();
  v_before      public.reports%ROWTYPE;
  v_after       public.reports%ROWTYPE;
  v_correlation UUID := gen_random_uuid();
  v_strike_target UUID;
  v_strike_reason TEXT;
  v_strike_weight INT;
  v_strike_notes  TEXT;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    IF v_actor IS NOT NULL THEN
      PERFORM public.admin_log_audit_event(
        v_actor, 'moderation', 'policy_denied', 'report', p_report_id::text,
        COALESCE(NULLIF(p_reason_code, ''), 'audit:investigation'),
        'Denied report status update attempt.',
        NULL,
        jsonb_build_object('requested_status', p_status, 'requested_resolution', p_resolution),
        p_ticket_ref, v_correlation, p_idempotency_key
      );
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'You do not have permission to update report status.';
  END IF;

  IF p_status NOT IN ('open', 'reviewing', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Invalid report status.';
  END IF;

  -- Resolution must match status. The CHECK constraint also enforces this,
  -- but a clean error message at the RPC layer is friendlier than a raw
  -- constraint violation.
  IF p_status IN ('open', 'reviewing') AND p_resolution IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'Open / reviewing reports must not carry a resolution.';
  END IF;
  IF p_status = 'resolved' AND (p_resolution IS NULL OR p_resolution NOT LIKE 'upheld_%') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'Resolving requires an upheld_minor / upheld_major / upheld_severe resolution.';
  END IF;
  IF p_status = 'dismissed' AND p_resolution NOT IN ('no_action', 'bad_faith') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'Dismissing requires resolution no_action or bad_faith.';
  END IF;

  SELECT * INTO v_before
  FROM public.reports
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Report was not found.';
  END IF;

  -- Idempotency: a re-submit with the same key is a no-op.
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.admin_audit_events
    WHERE actor_id = v_actor
      AND action = 'update'
      AND idempotency_key = p_idempotency_key
  ) THEN
    RETURN v_before;
  END IF;

  UPDATE public.reports
  SET status     = p_status::text,
      resolution = p_resolution,
      updated_at = now()
  WHERE id = p_report_id
  RETURNING * INTO v_after;

  -- Strike issuance rules. Skip if the report has no clear target user
  -- (e.g. a report against a session with no reported_user_id resolved).
  IF p_status = 'dismissed' AND p_resolution = 'bad_faith' THEN
    v_strike_target := v_before.reporter_id;
    v_strike_reason := 'admin_bad_faith_report';
    v_strike_weight := 1;
    v_strike_notes  := 'Bad-faith report dismissed by moderator';
  ELSIF p_status = 'resolved' AND p_resolution = 'upheld_minor' AND v_before.reported_user_id IS NOT NULL THEN
    v_strike_target := v_before.reported_user_id;
    v_strike_reason := 'admin_upheld_report';
    v_strike_weight := 1;
    v_strike_notes  := 'Report upheld (minor)';
  ELSIF p_status = 'resolved' AND p_resolution = 'upheld_major' AND v_before.reported_user_id IS NOT NULL THEN
    v_strike_target := v_before.reported_user_id;
    v_strike_reason := 'admin_upheld_report';
    v_strike_weight := 2;
    v_strike_notes  := 'Report upheld (major)';
  ELSIF p_status = 'resolved' AND p_resolution = 'upheld_severe' AND v_before.reported_user_id IS NOT NULL THEN
    v_strike_target := v_before.reported_user_id;
    v_strike_reason := 'admin_upheld_report';
    v_strike_weight := 4;
    v_strike_notes  := 'Report upheld (severe)';
  END IF;

  IF v_strike_target IS NOT NULL THEN
    PERFORM public.issue_strike_internal(
      v_strike_target, v_strike_reason, v_strike_weight,
      v_before.session_id, v_before.id, v_strike_notes, v_actor
    );
  END IF;

  -- Audit trail entry. Carries both the status delta and the resolution
  -- so a post-hoc review can see exactly what the moderator decided.
  PERFORM public.admin_log_audit_event(
    v_actor,
    'moderation',
    'update',
    'report',
    p_report_id::text,
    COALESCE(NULLIF(p_reason_code, ''), 'moderation:status_review'),
    COALESCE(NULLIF(p_justification, ''), 'Status updated'),
    jsonb_build_object('status', v_before.status, 'resolution', v_before.resolution),
    jsonb_build_object(
      'status', v_after.status,
      'resolution', v_after.resolution,
      'strike_issued_to', v_strike_target,
      'strike_weight', v_strike_weight
    ),
    p_ticket_ref,
    v_correlation,
    p_idempotency_key
  );

  RETURN v_after;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
-- The old 6-arg overload is now redundant. Drop it so admins can't
-- accidentally call the legacy version that didn't require a resolution.
DROP FUNCTION IF EXISTS public.admin_update_report_status(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
-- ─── 3. Update the queue RPC so admins can read resolution ──────────────────
--
-- The return signature is changing (new `resolution` column), which CREATE
-- OR REPLACE cannot do. DROP first.

DROP FUNCTION IF EXISTS public.get_admin_report_queue(INT);
CREATE OR REPLACE FUNCTION public.get_admin_report_queue(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
  resolution TEXT,
  created_at TIMESTAMPTZ,
  reporter_id UUID,
  reported_user_id UUID,
  session_id UUID,
  message_id UUID,
  review_id UUID,
  reporter_name TEXT,
  reported_user_name TEXT,
  message_preview TEXT,
  review_preview TEXT,
  session_skill TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin(v_actor) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Only admins can view the moderation queue.';
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.reason, r.details, r.status, r.resolution, r.created_at,
    r.reporter_id, r.reported_user_id, r.session_id, r.message_id, r.review_id,
    reporter.full_name AS reporter_name,
    reported.full_name AS reported_user_name,
    m.text AS message_preview,
    CASE
      WHEN rv.id IS NULL THEN NULL
      ELSE concat(rv.rating::TEXT, '/5 ', COALESCE(rv.comment, ''))
    END AS review_preview,
    sk.name AS session_skill
  FROM public.reports r
  LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
  LEFT JOIN public.profiles reported ON reported.id = r.reported_user_id
  LEFT JOIN public.messages m ON m.id = r.message_id
  LEFT JOIN public.reviews rv ON rv.id = r.review_id
  LEFT JOIN public.sessions s ON s.id = COALESCE(r.session_id, m.session_id, rv.session_id)
  LEFT JOIN public.skills sk ON sk.id = s.skill_id
  ORDER BY r.created_at DESC
  LIMIT v_limit;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_report_queue(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_report_queue(INT) TO authenticated;
