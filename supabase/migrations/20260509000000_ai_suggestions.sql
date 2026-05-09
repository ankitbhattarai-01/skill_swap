-- AI suggestions cache.
--
-- The dashboard's AI Suggestions card calls a Supabase Edge Function that
-- prompts Google Gemini with the user's profile + trending skills + skill
-- progression hints. Gemini calls cost latency and quota, so we cache the
-- generated suggestions per-user for ~6 hours and only refresh when the
-- cached row is missing or expired.
--
-- The Edge Function (service role) writes; the client only reads its own
-- row. Each user has at most one row, keyed by user_id.

CREATE TABLE public.ai_suggestions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  suggestions JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '6 hours')
);
ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;
-- Users may read only their own cached suggestions.
CREATE POLICY ai_suggestions_select_own
  ON public.ai_suggestions
  FOR SELECT
  USING (auth.uid() = user_id);
-- Writes happen only from the Edge Function via the service role, which
-- bypasses RLS. No insert/update/delete policy for authenticated users.

CREATE INDEX ai_suggestions_expires_at_idx
  ON public.ai_suggestions (expires_at);
