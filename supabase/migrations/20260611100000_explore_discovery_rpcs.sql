-- =============================================================================
-- Server-side Explore discovery.
--
-- Explore used to pull the first 60 user_teaching_skills rows (insertion
-- order!) and do all search / category / level / match filtering plus ranking
-- in the browser. Anyone outside that arbitrary first page was undiscoverable,
-- and every filter change re-scanned the same stale slice. These RPCs move
-- filtering, ranking and pagination into Postgres so the client only ever
-- receives the page it renders.
--
-- SECURITY INVOKER on purpose: both functions run under the caller's RLS and
-- column grants, so anonymous visitors see exactly what their direct table
-- reads showed before — nothing new is exposed. `auth.uid()` is NULL for anon,
-- which simply turns the match flag off.
--
-- Sorts:
--   'default' — viewer-match first, then rating, then recency.
--   'rated'   — rating, then recency.
--   'newest'  — recency.
-- "Available soonest" stays a client-side reorder of the fetched page: next
-- free-slot computation (teachers_free_time_status) is too expensive to run
-- across every candidate row just to ORDER BY it.
-- =============================================================================

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
  WITH base AS (
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
    WHERE uts.user_id IS DISTINCT FROM auth.uid()
      AND (p_category IS NULL OR s.category = p_category)
      AND (p_level IS NULL OR uts.level::text = p_level)
      AND (
        p_query IS NULL
        OR s.name ILIKE '%' || p_query || '%'
        OR s.category ILIKE '%' || p_query || '%'
        OR p.full_name ILIKE '%' || p_query || '%'
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
  WITH base AS (
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
    WHERE uls.user_id IS DISTINCT FROM auth.uid()
      AND (p_category IS NULL OR s.category = p_category)
      AND (p_level IS NULL OR uls.current_level::text = p_level)
      AND (
        p_query IS NULL
        OR s.name ILIKE '%' || p_query || '%'
        OR s.category ILIKE '%' || p_query || '%'
        OR p.full_name ILIKE '%' || p_query || '%'
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

-- Public discovery surface: anon may browse exactly as before (RLS still
-- applies underneath).
GRANT EXECUTE ON FUNCTION
  public.explore_teachers(text, text, text, boolean, text, int, int),
  public.explore_learners(text, text, text, boolean, text, int, int)
TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
