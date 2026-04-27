WITH ranked_open_sessions AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY learner_id, teacher_id, skill_id
      ORDER BY created_at DESC, id DESC
    ) AS row_number
  FROM public.sessions
  WHERE status IN ('pending', 'accepted', 'active')
)
UPDATE public.sessions
SET status = 'cancelled'
WHERE id IN (
  SELECT id
  FROM ranked_open_sessions
  WHERE row_number > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_request_per_skill
ON public.sessions (learner_id, teacher_id, skill_id)
WHERE status IN ('pending', 'accepted', 'active');
