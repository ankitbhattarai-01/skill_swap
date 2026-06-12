-- =============================================================================
-- Delivery log + dedupe for the send-session-email Edge Function.
--
-- The function previously had no persistence: a pg_net retry or a double
-- trigger fire sent the same notification email twice, and there was no way
-- to answer "did the accepted-session email for X actually go out?" without
-- trawling function logs. One row per notification id fixes both:
--   - the PRIMARY KEY on notification_id makes the first dispatch win
--     (the function INSERTs a claim before talking to SMTP; a conflict means
--     another invocation already handled it);
--   - status/detail record the outcome (sent / failed / skipped + reason),
--     queryable from the SQL editor for support questions.
--
-- Service-role only: the Edge Function uses the service key (bypasses RLS).
-- RLS is enabled with NO policies and all client grants revoked, so regular
-- users can neither read recipients' emails nor forge delivery rows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.session_email_deliveries (
  notification_id UUID PRIMARY KEY REFERENCES public.notifications (id) ON DELETE CASCADE,
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.session_email_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.session_email_deliveries FROM PUBLIC, anon, authenticated;

-- Triage queries ("what failed today?") hit status + recency.
CREATE INDEX IF NOT EXISTS session_email_deliveries_status_idx
  ON public.session_email_deliveries (status, created_at DESC);

NOTIFY pgrst, 'reload schema';
