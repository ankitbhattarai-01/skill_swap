-- Keep the legacy profiles.is_admin flag in sync when granting admin access.
--
-- admin_set_user_admin used to ONLY insert an admin_role_assignments row on
-- grant. That is enough for the newer is_admin() (which also checks active
-- assignments), but the live database still runs the older is_admin() that
-- reads only profiles.is_admin. The result: a promoted user showed as
-- "privileged" on the admin Users page (has_admin_role reads assignments) yet
-- never saw the Admin nav link (gated on is_admin -> profiles.is_admin).
--
-- Fix: on grant, also set profiles.is_admin = true, mirroring the revoke path
-- that already clears it. The protect_admin_flag trigger allows this because
-- the actor is a verified admin (or auth.uid() is NULL for service-role runs).
-- This keeps the flag and the assignment in lockstep, so any is_admin()
-- version returns the right answer.

CREATE OR REPLACE FUNCTION public.admin_set_user_admin(
  p_user_id UUID,
  p_make_admin BOOLEAN,
  p_reason_code TEXT,
  p_justification TEXT,
  p_ticket_ref TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_role_id UUID;
  v_correlation UUID := gen_random_uuid();
  v_was_admin BOOLEAN;
BEGIN
  -- Promoting or demoting an admin is an access-governance approval action.
  IF v_actor IS NULL
     OR NOT public.admin_has_permission(v_actor, 'access-governance', 'approve') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'Access approval permission is required to change admin status.';
  END IF;

  -- Separation of duties: you cannot promote or demote yourself.
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You cannot change your own admin status.';
  END IF;

  IF coalesce(length(btrim(p_justification)), 0) < 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Justification must be at least 8 characters.';
  END IF;

  IF coalesce(length(btrim(p_ticket_ref)), 0) < 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Ticket reference is required to change admin status.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'User was not found.';
  END IF;

  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = 'super_admin';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'no_data_found',
      MESSAGE = 'The super_admin role is missing.';
  END IF;

  -- Current state: any active assignment OR the legacy boolean flag.
  v_was_admin :=
    EXISTS (
      SELECT 1
      FROM public.admin_role_assignments a
      WHERE a.user_id = p_user_id
        AND a.revoked_at IS NULL
        AND a.starts_at <= now()
        AND (a.expires_at IS NULL OR a.expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles WHERE id = p_user_id AND is_admin = true
    );

  IF p_make_admin THEN
    -- Idempotent: only insert when there isn't already an active super_admin
    -- assignment (the partial unique index makes a duplicate insert an error).
    IF NOT EXISTS (
      SELECT 1
      FROM public.admin_role_assignments a
      WHERE a.user_id = p_user_id
        AND a.role_id = v_role_id
        AND a.revoked_at IS NULL
    ) THEN
      INSERT INTO public.admin_role_assignments (
        user_id, role_id, scope_type, granted_by, grant_reason
      )
      VALUES (p_user_id, v_role_id, 'global', v_actor, btrim(p_justification));
    END IF;

    -- Keep the legacy flag in lockstep so the older is_admin() (which only
    -- reads profiles.is_admin) still gates the Admin nav link correctly.
    UPDATE public.profiles
    SET is_admin = true
    WHERE id = p_user_id
      AND is_admin IS DISTINCT FROM true;
  ELSE
    -- Revoke every active assignment and clear the legacy boolean so the user
    -- loses all admin surfaces.
    UPDATE public.admin_role_assignments
    SET revoked_at = now(),
        revoked_by = v_actor,
        revoked_reason = btrim(p_justification)
    WHERE user_id = p_user_id
      AND revoked_at IS NULL;

    UPDATE public.profiles
    SET is_admin = false
    WHERE id = p_user_id
      AND is_admin = true;
  END IF;

  PERFORM public.admin_log_audit_event(
    v_actor,
    'access-governance',
    CASE WHEN p_make_admin THEN 'create' ELSE 'override' END,
    'admin_role_assignment',
    p_user_id::TEXT,
    p_reason_code,
    p_justification,
    jsonb_build_object('was_admin', v_was_admin),
    jsonb_build_object('is_admin', p_make_admin),
    p_ticket_ref,
    v_correlation,
    NULL,
    '{}'::jsonb
  );

  RETURN p_make_admin;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_admin(UUID, BOOLEAN, TEXT, TEXT, TEXT)
  TO authenticated;

-- Backfill: anyone who already holds an active admin assignment but whose
-- legacy flag was never set (e.g. rammm1477, promoted before this fix) gets
-- the flag now so they immediately gain the Admin nav link.
UPDATE public.profiles p
SET is_admin = true
WHERE p.is_admin IS DISTINCT FROM true
  AND EXISTS (
    SELECT 1
    FROM public.admin_role_assignments a
    WHERE a.user_id = p.id
      AND a.revoked_at IS NULL
      AND a.starts_at <= now()
      AND (a.expires_at IS NULL OR a.expires_at > now())
  );

NOTIFY pgrst, 'reload schema';
