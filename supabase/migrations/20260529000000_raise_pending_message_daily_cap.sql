-- Raise the pre-acceptance daily message cap from 15 to 40 per sender, and
-- close the unsend bypass that 20260526050000 reopened.
--
-- The 15/day cap (migrations 20260526010000 → 20260526050000) was too
-- tight for learner/teacher to actually clarify scope before acceptance,
-- so we lift it to 40/day per sender. The cap is per-sender, so each side
-- gets its own 40/day allowance. The 5-unanswered cap is unchanged, and
-- attachments remain gated behind acceptance.
--
-- Unsend bug: 20260526020000 made both caps count from the append-only
-- pending_message_send_log (never decremented) so a user couldn't send N
-- messages, unsend them, and earn N fresh sends. But 20260526050000 added
-- the attachment gate by rewriting the trigger off the older revision —
-- reverting the counts to public.messages and dropping the log INSERT. So
-- the live trigger has been refundable-by-unsend ever since, while the
-- quota badge (still reading the log) drifts out of sync.
--
-- This migration restores the log as the single source of truth: both
-- caps count from pending_message_send_log, every accepted pre-acceptance
-- send is appended to it, and the attachment gate is preserved. Unsending
-- a message removes the chat bubble but never refunds quota, and the badge
-- now matches what the trigger enforces.

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

  -- Attachments are gated on the session being accepted. Reject any
  -- pending-session insert that carries one.
  IF NEW.attachment_path IS NOT NULL THEN
    RAISE EXCEPTION 'Image and file sharing unlocks after the teacher accepts the session.'
      USING ERRCODE = 'P0001';
  END IF;

  v_recipient := CASE
    WHEN NEW.sender_id = v_teacher THEN v_learner
    ELSE v_teacher
  END;

  -- Daily cap: count from the append-only log so unsending never refunds.
  SELECT COUNT(*) INTO v_daily_count
  FROM public.pending_message_send_log
  WHERE sender_id = NEW.sender_id
    AND created_at >= date_trunc('day', timezone('UTC', now()));

  IF v_daily_count >= 40 THEN
    RAISE EXCEPTION 'Daily message limit reached (40). Resets at midnight UTC.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Unanswered cap: also counted from the log. The "has the recipient
  -- replied yet" gate reads pending_message_send_log too, so a reply that
  -- is later unsent does not let the sender's restriction silently return.
  IF NOT EXISTS (
    SELECT 1 FROM public.pending_message_send_log l
    WHERE l.session_id = NEW.session_id
      AND l.sender_id = v_recipient
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

  -- Record this send. Append-only: unsend deletes the message row but not
  -- this row, so quota is never refunded.
  INSERT INTO public.pending_message_send_log (sender_id, session_id)
  VALUES (NEW.sender_id, NEW.session_id);

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_pending_message_caps() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.my_pending_message_quota()
RETURNS TABLE(used int, daily_limit int, reset_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((
      SELECT COUNT(*)::int
      FROM public.pending_message_send_log
      WHERE sender_id = (select auth.uid())
        AND created_at >= date_trunc('day', timezone('UTC', now()))
    ), 0) AS used,
    40 AS daily_limit,
    (date_trunc('day', timezone('UTC', now())) + INTERVAL '1 day') AS reset_at;
$$;

REVOKE EXECUTE ON FUNCTION public.my_pending_message_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pending_message_quota() TO authenticated;

NOTIFY pgrst, 'reload schema';
