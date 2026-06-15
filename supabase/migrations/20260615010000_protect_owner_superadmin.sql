-- Protect the platform owner account from other admins.
--
-- The admin "Users" page lets any operator with the right permission suspend an
-- account or revoke its admin access. The only carve-out so far is "you cannot
-- act on yourself" (p_user_id = auth.uid()). That means a second admin — even
-- one the owner just promoted — can suspend the owner or strip their admin
-- role, locking the owner out of their own platform.
--
-- This migration designates utsabkarki1377@gmail.com as a protected superadmin:
-- their account can never be suspended or have admin access revoked through the
-- admin RPCs, no matter who the actor is. The owner can still manage everyone
-- else normally. Enforcement lives in the database so it holds regardless of
-- what the UI shows or what a crafted RPC call sends.

-- ─── Helper: is this user the protected owner? ───────────────────────────────
-- SECURITY DEFINER so it can read auth.users (the email lives there, not in
-- public.profiles). Match is case-insensitive on the canonical owner address.
CREATE OR REPLACE FUNCTION private.is_protected_superadmin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = p_user_id
      AND lower(u.email) = 'utsabkarki1377@gmail.com'
  );
$$;
REVOKE EXECUTE ON FUNCTION private.is_protected_superadmin(UUID) FROM PUBLIC, anon;

-- ─── 1. admin_set_user_admin: block revoking the owner's admin ────────────────
-- Re-creates the function from 20260615000000 with one added guard right after
-- the self-check. Grants are unchanged; the only behavioural change is that
-- "Remove admin" on the protected owner now fails.
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

  -- The platform owner's admin access cannot be revoked by anyone else.
  IF NOT p_make_admin AND private.is_protected_superadmin(p_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'This is the platform owner account; its admin access cannot be revoked.';
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

-- ─── 2. admin_suspend_user: block suspending the owner ────────────────────────
-- The privileged implementation lives in the private schema (moved by
-- 20260513170000). Re-create it there with the owner guard added after the
-- self-check. The public SQL wrapper is unchanged and keeps delegating here.
CREATE OR REPLACE FUNCTION private.admin_suspend_user(
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

  -- The platform owner cannot be suspended by anyone else.
  IF private.is_protected_superadmin(p_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = 'This is the platform owner account; it cannot be suspended.';
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
REVOKE EXECUTE ON FUNCTION private.admin_suspend_user(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.admin_suspend_user(UUID, TEXT, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
