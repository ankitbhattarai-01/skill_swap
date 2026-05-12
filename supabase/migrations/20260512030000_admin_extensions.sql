-- Admin panel extensions to close the five "notably absent" gaps:
--   1. User suspension / reinstatement
--   2. Skills catalog management
--   3. System-wide broadcast notifications
--   4. (Direct reports queue reuses existing get_admin_report_queue)
--   5. Basic system health snapshot
--
-- All write paths require a reason code, ticket reference (where appropriate),
-- and justification, and write to the tamper-evident audit chain via
-- admin_log_audit_event.

-- ---------------------------------------------------------------------------
-- 1. Profile suspension columns + RLS check
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_suspended_idx
  ON public.profiles (suspended_at)
  WHERE suspended_at IS NOT NULL;
-- Block suspended users from creating new sessions. We intentionally only
-- harden the value-creating path here; reads remain unrestricted so support
-- still works while a user is suspended.
DROP POLICY IF EXISTS "Suspended users cannot create sessions" ON public.sessions;
CREATE POLICY "Suspended users cannot create sessions" ON public.sessions
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.suspended_at IS NOT NULL
    )
  );
-- ---------------------------------------------------------------------------
-- 2. New reason codes
-- ---------------------------------------------------------------------------

INSERT INTO public.admin_reason_codes (code, domain, action, label, requires_ticket)
VALUES
  ('users:suspend',    'users',      'update', 'User suspension',           true),
  ('users:reinstate',  'users',      'update', 'User reinstatement',        true),
  ('skills:catalog',   'moderation', 'update', 'Skills catalog change',     false),
  ('comms:broadcast',  'moderation', 'create', 'System-wide notification',  true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  requires_ticket = EXCLUDED.requires_ticket,
  active = true;
-- ---------------------------------------------------------------------------
-- 3. RPCs: user suspension
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_suspend_user(
  p_user_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_after public.profiles%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'users', 'update') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'User update permission is required to suspend an account.';
  END IF;

  IF p_user_id = v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'You cannot suspend your own account.';
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'User not found.';
  END IF;

  UPDATE public.profiles
  SET suspended_at = now(),
      suspended_reason = btrim(p_justification),
      suspended_by = v_actor,
      updated_at = now()
  WHERE id = p_user_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor, 'users', 'update', 'profile', p_user_id::TEXT,
    p_reason_code, p_justification,
    v_before, to_jsonb(v_after),
    p_ticket_ref
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_reinstate_user(
  p_user_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_after public.profiles%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'users', 'update') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'User update permission is required to reinstate an account.';
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'User not found.';
  END IF;

  UPDATE public.profiles
  SET suspended_at = NULL,
      suspended_reason = NULL,
      suspended_by = NULL,
      updated_at = now()
  WHERE id = p_user_id
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor, 'users', 'update', 'profile', p_user_id::TEXT,
    p_reason_code, p_justification,
    v_before, to_jsonb(v_after),
    p_ticket_ref
  );

  RETURN v_after;
END;
$$;
-- ---------------------------------------------------------------------------
-- 4. RPCs: skills catalog management
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_skills_catalog()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'read') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation read permission is required.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(x))
    FROM (
      SELECT
        s.id,
        s.name,
        s.category,
        s.created_at,
        (SELECT COUNT(*)::INT FROM public.user_teaching_skills t WHERE t.skill_id = s.id) AS teaching_count,
        (SELECT COUNT(*)::INT FROM public.user_learning_skills l WHERE l.skill_id = s.id) AS learning_count,
        (SELECT COUNT(*)::INT FROM public.sessions ses WHERE ses.skill_id = s.id) AS session_count
      FROM public.skills s
      ORDER BY s.category NULLS LAST, s.name
    ) x
  ), '[]'::jsonb);
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_create_skill(
  p_name TEXT,
  p_category TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS public.skills
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_after public.skills%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'update') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation update permission is required.';
  END IF;

  IF char_length(btrim(COALESCE(p_name, ''))) < 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Skill name is required.';
  END IF;

  INSERT INTO public.skills (name, category)
  VALUES (btrim(p_name), NULLIF(btrim(COALESCE(p_category, '')), ''))
  RETURNING * INTO v_after;

  PERFORM public.admin_log_audit_event(
    v_actor, 'moderation', 'create', 'skill', v_after.id::TEXT,
    p_reason_code, p_justification,
    NULL, to_jsonb(v_after),
    p_ticket_ref
  );

  RETURN v_after;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_delete_skill(
  p_skill_id UUID,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_in_use INT;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'delete') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation delete permission is required.';
  END IF;

  SELECT to_jsonb(s) INTO v_before FROM public.skills s WHERE s.id = p_skill_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'no_data_found', MESSAGE = 'Skill not found.';
  END IF;

  SELECT
    (SELECT COUNT(*) FROM public.user_teaching_skills WHERE skill_id = p_skill_id)
    + (SELECT COUNT(*) FROM public.user_learning_skills WHERE skill_id = p_skill_id)
    + (SELECT COUNT(*) FROM public.sessions WHERE skill_id = p_skill_id)
  INTO v_in_use;

  IF v_in_use > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('Skill has %s active references. Migrate or clear them before deleting.', v_in_use);
  END IF;

  DELETE FROM public.skills WHERE id = p_skill_id;

  PERFORM public.admin_log_audit_event(
    v_actor, 'moderation', 'delete', 'skill', p_skill_id::TEXT,
    p_reason_code, p_justification,
    v_before, NULL,
    p_ticket_ref
  );

  RETURN v_before;
END;
$$;
-- ---------------------------------------------------------------------------
-- 5. RPC: broadcast notification
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_broadcast_notification(
  p_title TEXT,
  p_body TEXT,
  p_link TEXT,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_count INT;
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'moderation', 'create') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Moderation create permission is required to broadcast.';
  END IF;

  IF char_length(btrim(COALESCE(p_title, ''))) < 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Broadcast title is required (3+ characters).';
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
  SELECT
    p.id,
    'broadcast',
    btrim(p_title),
    NULLIF(btrim(COALESCE(p_body, '')), ''),
    NULLIF(btrim(COALESCE(p_link, '')), ''),
    jsonb_build_object('broadcast_by', v_actor, 'broadcast_at', now())
  FROM public.profiles p
  WHERE p.suspended_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.admin_log_audit_event(
    v_actor, 'moderation', 'create', 'broadcast_notification', NULL,
    p_reason_code, p_justification,
    NULL,
    jsonb_build_object('title', p_title, 'recipients', v_count, 'link', p_link),
    p_ticket_ref
  );

  RETURN v_count;
END;
$$;
-- ---------------------------------------------------------------------------
-- 6. RPC: system health
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_system_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'security', 'read') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Security read permission is required.';
  END IF;

  RETURN jsonb_build_object(
    'auditEvents1h', (
      SELECT COUNT(*)::INT FROM public.admin_audit_events WHERE created_at > now() - interval '1 hour'
    ),
    'auditEvents24h', (
      SELECT COUNT(*)::INT FROM public.admin_audit_events WHERE created_at > now() - interval '24 hours'
    ),
    'denials24h', (
      SELECT COUNT(*)::INT FROM public.admin_audit_events
      WHERE action = 'policy_denied' AND created_at > now() - interval '24 hours'
    ),
    'sessionsCreated24h', (
      SELECT COUNT(*)::INT FROM public.sessions WHERE created_at > now() - interval '24 hours'
    ),
    'messagesPosted1h', (
      SELECT COUNT(*)::INT FROM public.messages WHERE created_at > now() - interval '1 hour'
    ),
    'suspendedUsers', (
      SELECT COUNT(*)::INT FROM public.profiles WHERE suspended_at IS NOT NULL
    ),
    'pendingReports', (
      SELECT COUNT(*)::INT FROM public.reports WHERE status IN ('open', 'reviewing')
    ),
    'pendingActionRequests', (
      SELECT COUNT(*)::INT FROM public.admin_action_requests WHERE status = 'pending'
    ),
    'auditByDomain24h', COALESCE((
      SELECT jsonb_object_agg(domain, count)
      FROM (
        SELECT domain, COUNT(*)::INT AS count
        FROM public.admin_audit_events
        WHERE created_at > now() - interval '24 hours'
        GROUP BY domain
      ) x
    ), '{}'::jsonb),
    'generatedAt', now()
  );
END;
$$;
-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_skills_catalog() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_delete_skill(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_system_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_user(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_skills_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_skill(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_skill(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_system_health() TO authenticated;
-- ---------------------------------------------------------------------------
-- 8. Extend get_admin_users to include suspension state
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_users(
  p_limit INT DEFAULT 50,
  p_search TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT public.admin_has_permission(v_actor, 'users', 'read') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Users read permission is required.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(x))
    FROM (
      SELECT
        u.id,
        public.admin_mask_email(u.email::TEXT) AS masked_email,
        CASE
          WHEN p.full_name IS NULL OR p.full_name = '' THEN NULL
          ELSE left(p.full_name, 1) || repeat('*', greatest(char_length(p.full_name) - 1, 0))
        END AS masked_name,
        p.onboarded,
        p.learning_mode,
        p.created_at,
        u.last_sign_in_at,
        p.suspended_at,
        p.suspended_reason,
        EXISTS (
          SELECT 1
          FROM public.admin_role_assignments ara
          WHERE ara.user_id = u.id
            AND ara.revoked_at IS NULL
            AND ara.starts_at <= now()
            AND (ara.expires_at IS NULL OR ara.expires_at > now())
        ) AS has_admin_role,
        (
          SELECT COUNT(*)::INT
          FROM public.sessions s
          WHERE s.learner_id = u.id OR s.teacher_id = u.id
        ) AS session_count,
        (
          SELECT COUNT(*)::INT
          FROM public.reports r
          WHERE r.reporter_id = u.id OR r.reported_user_id = u.id
        ) AS report_count
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE v_search IS NULL
        OR u.id::TEXT = v_search
        OR lower(COALESCE(u.email::TEXT, '')) LIKE '%' || lower(v_search) || '%'
        OR lower(COALESCE(p.full_name, '')) LIKE '%' || lower(v_search) || '%'
      ORDER BY COALESCE(u.last_sign_in_at, p.created_at, u.created_at) DESC NULLS LAST
      LIMIT least(greatest(COALESCE(p_limit, 50), 1), 100)
    ) x
  ), '[]'::jsonb);
END;
$$;
