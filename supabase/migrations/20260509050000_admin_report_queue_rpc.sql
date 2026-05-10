-- Admin-only moderation queue context.
--
-- Report rows are visible to admins through RLS, but the private message,
-- session, and blind-review tables keep their normal participant policies.
-- This narrow SECURITY DEFINER RPC gives moderators the context needed to
-- review reports without adding broad admin SELECT policies to private tables.

CREATE OR REPLACE FUNCTION public.get_admin_report_queue(p_limit INT DEFAULT 200)
RETURNS TABLE (
  id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
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
    r.id,
    r.reason,
    r.details,
    r.status,
    r.created_at,
    r.reporter_id,
    r.reported_user_id,
    r.session_id,
    r.message_id,
    r.review_id,
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
