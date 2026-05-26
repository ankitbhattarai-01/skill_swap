-- Make pre-acceptance message caps unsend-proof.
--
-- Before: enforce_pending_message_caps counted rows in public.messages.
-- Unsending a message hard-deletes the row, so a user could send 15
-- messages, unsend them all, and get 15 fresh sends — bypassing the cap
-- entirely. Same bypass for the 5-unanswered cap.
--
-- After: every pre-acceptance send is recorded in an append-only log
-- (pending_message_send_log) that is never decremented. The trigger and
-- the quota RPC count from the log, so unsend removes the chat bubble
-- but does not refund the daily or unanswered quota.

CREATE TABLE IF NOT EXISTS public.pending_message_send_log (
  id bigserial PRIMARY KEY,
  sender_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_message_send_log_sender_day_idx
  ON public.pending_message_send_log (sender_id, created_at);

CREATE INDEX IF NOT EXISTS pending_message_send_log_session_sender_idx
  ON public.pending_message_send_log (session_id, sender_id);

ALTER TABLE public.pending_message_send_log ENABLE ROW LEVEL SECURITY;
-- No direct access. Only the SECURITY DEFINER trigger and quota RPC
-- read/write this table.
REVOKE ALL ON public.pending_message_send_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.pending_message_send_log_id_seq FROM PUBLIC, anon, authenticated;

-- Backfill from current pending-session messages so existing same-day
-- sends still count toward today's quota after the migration runs.
INSERT INTO public.pending_message_send_log (sender_id, session_id, created_at)
SELECT m.sender_id, m.session_id, m.created_at
FROM public.messages m
JOIN public.sessions s ON s.id = m.session_id
WHERE s.status = 'pending'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_pending_message_caps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_teacher uuid;
  v_learner uuid;
  v_recipient uuid;
  v_daily_count int;
  v_unanswered_count int;
BEGIN
  SELECT status, teacher_id, learner_id
  INTO v_status, v_teacher, v_learner
  FROM public.sessions
  WHERE id = NEW.session_id;

  IF v_status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  v_recipient := CASE
    WHEN NEW.sender_id = v_teacher THEN v_learner
    ELSE v_teacher
  END;

  SELECT COUNT(*) INTO v_daily_count
  FROM public.pending_message_send_log
  WHERE sender_id = NEW.sender_id
    AND created_at >= date_trunc('day', timezone('UTC', now()));

  IF v_daily_count >= 15 THEN
    RAISE EXCEPTION 'Daily message limit reached (15). Resets at midnight UTC.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.messages m2
    WHERE m2.session_id = NEW.session_id
      AND m2.sender_id = v_recipient
  ) THEN
    SELECT COUNT(*) INTO v_unanswered_count
    FROM public.pending_message_send_log
    WHERE session_id = NEW.session_id
      AND sender_id = NEW.sender_id;

    IF v_unanswered_count >= 5 THEN
      RAISE EXCEPTION 'You can send up to 5 messages before they reply.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.pending_message_send_log (sender_id, session_id)
  VALUES (NEW.sender_id, NEW.session_id);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.my_pending_message_quota()
RETURNS TABLE(used int, daily_limit int, reset_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((
      SELECT COUNT(*)::int
      FROM public.pending_message_send_log
      WHERE sender_id = auth.uid()
        AND created_at >= date_trunc('day', timezone('UTC', now()))
    ), 0) AS used,
    15 AS daily_limit,
    (date_trunc('day', timezone('UTC', now())) + INTERVAL '1 day') AS reset_at;
$$;
