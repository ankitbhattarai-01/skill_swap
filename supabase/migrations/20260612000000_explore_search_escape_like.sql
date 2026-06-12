-- =============================================================================
-- Harden Explore search: escape LIKE metacharacters in the user-supplied query.
--
-- explore_teachers / explore_learners interpolate p_query into ILIKE patterns:
--     s.name ILIKE '%' || p_query || '%'
-- p_query is a bound parameter (no SQL injection), but the LIKE wildcards
-- `%` and `_` and the escape char `\` were passed through literally. A query
-- of '%' therefore matched every row, '_' matched any single char, and a
-- crafted query could force a needlessly broad scan on a public (anon-granted)
-- RPC. Escape the three metacharacters so the query is treated as a literal
-- substring. Behaviour is otherwise byte-for-byte identical to
-- 20260611100000_explore_discovery_rpcs.sql.
--
-- Default LIKE ESCAPE is backslash, so escaping `\` -> `\\`, `%` -> `\%`,
-- `_` -> `\_` is sufficient.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.escape_like(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT replace(replace(replace(p_input, '\', '\\'), '%', '\%'), '_', '\_');
$$;

GRANT EXECUTE ON FUNCTION public.escape_like(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.explore_teachers(
  p_query text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_level text DEFAULT NULL,
  p_match_only boolean DEFAULT false,
  p_sort text DEFAULT 'default',
  p_limit int DEFAULT 24,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  level text,
  credits_per_hour int,
  created_at timestamptz,
  skill_id uuid,
  skill_name text,
  skill_category text,
  full_name text,
  bio text,
  avatar_url text,
  rating_average numeric,
  rating_count bigint,
  matches_viewer boolean
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
  WITH q AS (
    SELECT CASE WHEN p_query IS NULL THEN NULL
                ELSE '%' || public.escape_like(p_query) || '%' END AS pat
  ),
  base AS (
    SELECT
      uts.id,
      uts.user_id,
      uts.level::text AS level,
      uts.credits_per_hour,
      uts.created_at,
      s.id AS skill_id,
      s.name AS skill_name,
      s.category AS skill_category,
      p.full_name,
      p.bio,
      p.avatar_url,
      r.avg_rating,
      r.rating_count,
      (auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_learning_skills uls
        WHERE uls.user_id = auth.uid() AND uls.skill_id = uts.skill_id
      )) AS matches_viewer
    FROM public.user_teaching_skills uts
    JOIN public.skills s ON s.id = uts.skill_id
    LEFT JOIN public.profiles p ON p.id = uts.user_id
    LEFT JOIN LATERAL (
      SELECT avg(rv.rating)::numeric AS avg_rating, count(*)::bigint AS rating_count
      FROM public.reviews rv
      WHERE rv.reviewee_id = uts.user_id
    ) r ON true
    CROSS JOIN q
    WHERE uts.user_id IS DISTINCT FROM auth.uid()
      AND (p_category IS NULL OR s.category = p_category)
      AND (p_level IS NULL OR uts.level::text = p_level)
      AND (
        q.pat IS NULL
        OR s.name ILIKE q.pat
        OR s.category ILIKE q.pat
        OR p.full_name ILIKE q.pat
      )
  )
  SELECT
    b.id, b.user_id, b.level, b.credits_per_hour, b.created_at,
    b.skill_id, b.skill_name, b.skill_category,
    b.full_name, b.bio, b.avatar_url,
    COALESCE(b.avg_rating, 0) AS rating_average,
    COALESCE(b.rating_count, 0) AS rating_count,
    b.matches_viewer
  FROM base b
  WHERE (NOT p_match_only OR b.matches_viewer)
  ORDER BY
    CASE WHEN p_sort = 'default' AND b.matches_viewer THEN 0 ELSE 1 END,
    CASE WHEN p_sort IN ('default', 'rated') THEN COALESCE(b.avg_rating, 0) END DESC NULLS LAST,
    b.created_at DESC,
    b.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 60)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.explore_learners(
  p_query text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_level text DEFAULT NULL,
  p_match_only boolean DEFAULT false,
  p_sort text DEFAULT 'default',
  p_limit int DEFAULT 24,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  current_level text,
  created_at timestamptz,
  skill_id uuid,
  skill_name text,
  skill_category text,
  full_name text,
  bio text,
  avatar_url text,
  matches_viewer boolean
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
  WITH q AS (
    SELECT CASE WHEN p_query IS NULL THEN NULL
                ELSE '%' || public.escape_like(p_query) || '%' END AS pat
  ),
  base AS (
    SELECT
      uls.id,
      uls.user_id,
      uls.current_level::text AS current_level,
      uls.created_at,
      s.id AS skill_id,
      s.name AS skill_name,
      s.category AS skill_category,
      p.full_name,
      p.bio,
      p.avatar_url,
      (auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_teaching_skills uts
        WHERE uts.user_id = auth.uid() AND uts.skill_id = uls.skill_id
      )) AS matches_viewer
    FROM public.user_learning_skills uls
    JOIN public.skills s ON s.id = uls.skill_id
    LEFT JOIN public.profiles p ON p.id = uls.user_id
    CROSS JOIN q
    WHERE uls.user_id IS DISTINCT FROM auth.uid()
      AND (p_category IS NULL OR s.category = p_category)
      AND (p_level IS NULL OR uls.current_level::text = p_level)
      AND (
        q.pat IS NULL
        OR s.name ILIKE q.pat
        OR s.category ILIKE q.pat
        OR p.full_name ILIKE q.pat
      )
  )
  SELECT
    b.id, b.user_id, b.current_level, b.created_at,
    b.skill_id, b.skill_name, b.skill_category,
    b.full_name, b.bio, b.avatar_url, b.matches_viewer
  FROM base b
  WHERE (NOT p_match_only OR b.matches_viewer)
  ORDER BY
    CASE WHEN p_sort = 'default' AND b.matches_viewer THEN 0 ELSE 1 END,
    b.created_at DESC,
    b.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 60)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION
  public.explore_teachers(text, text, text, boolean, text, int, int),
  public.explore_learners(text, text, text, boolean, text, int, int)
TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
