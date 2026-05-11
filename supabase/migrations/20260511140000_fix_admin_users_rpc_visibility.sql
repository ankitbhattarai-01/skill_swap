-- Fix admin user listing RPC visibility and make the helper callable through
-- PostgREST after manual SQL-editor rollout.

CREATE OR REPLACE FUNCTION public.admin_mask_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_at INT;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN
    RETURN NULL;
  END IF;

  v_at := position('@' IN p_email);
  IF v_at <= 1 THEN
    RETURN '***';
  END IF;

  RETURN left(p_email, 1) || '***' || substring(p_email FROM v_at);
END;
$$;
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
REVOKE EXECUTE ON FUNCTION public.admin_mask_email(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mask_email(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_users(INT, TEXT) TO authenticated;
NOTIFY pgrst, 'reload schema';
