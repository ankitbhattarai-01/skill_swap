-- Decouple chat from sessions.
--
-- Messaging used to be implemented *through* sessions: every public.messages
-- row had a NOT NULL session_id, and the inbox grouped sessions by the other
-- participant. As a side effect, "Message" created a pending session request
-- the recipient could Accept. This migration introduces a first-class
-- conversation (one row per unordered user pair). Messages now belong to a
-- conversation; session_id becomes OPTIONAL context (kept so session dividers
-- and attachment-after-acceptance gating still work when a booking exists).
--
-- Order matters: create conversations, add messages.conversation_id, backfill
-- from existing session-linked messages, THEN add NOT NULL + swap policies.
-- The whole script is wrapped in one transaction and is safe to re-run.

BEGIN;

-- 1. Conversations ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_low uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_high uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CONSTRAINT conversations_pair_ordered_chk CHECK (user_low < user_high),
  CONSTRAINT conversations_pair_unique UNIQUE (user_low, user_high)
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants view conversations" ON public.conversations;
CREATE POLICY "Participants view conversations" ON public.conversations
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_low OR (select auth.uid()) = user_high);

-- No direct writes from clients; conversations are created through the
-- SECURITY DEFINER RPC so canonical ordering + race recovery is enforced.
REVOKE ALL ON public.conversations FROM anon, authenticated;
GRANT SELECT ON public.conversations TO authenticated;

-- get_or_create_conversation: canonicalize the {me, other} pair and
-- insert-or-return. Mirrors the 23505 race recovery in getOrCreateSession.
CREATE OR REPLACE FUNCTION public.get_or_create_conversation(other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := (select auth.uid());
  v_low uuid;
  v_high uuid;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'P0001';
  END IF;
  IF other_user IS NULL OR other_user = v_me THEN
    RAISE EXCEPTION 'A conversation needs a different participant.' USING ERRCODE = 'P0001';
  END IF;

  IF v_me < other_user THEN
    v_low := v_me; v_high := other_user;
  ELSE
    v_low := other_user; v_high := v_me;
  END IF;

  SELECT id INTO v_id FROM public.conversations
   WHERE user_low = v_low AND user_high = v_high;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.conversations (user_low, user_high)
  VALUES (v_low, v_high)
  ON CONFLICT (user_low, user_high) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.conversations
     WHERE user_low = v_low AND user_high = v_high;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) TO authenticated;

-- 2. messages.conversation_id + backfill ------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid
    REFERENCES public.conversations(id) ON DELETE CASCADE;

-- Create a conversation for every distinct participant pair that already owns
-- session-linked messages, seeding last_message_at from the newest message.
INSERT INTO public.conversations (user_low, user_high, last_message_at)
SELECT
  LEAST(s.teacher_id, s.learner_id)    AS user_low,
  GREATEST(s.teacher_id, s.learner_id) AS user_high,
  MAX(m.created_at)                    AS last_message_at
FROM public.messages m
JOIN public.sessions s ON s.id = m.session_id
WHERE m.conversation_id IS NULL
  AND s.teacher_id IS NOT NULL
  AND s.learner_id IS NOT NULL
  AND s.teacher_id <> s.learner_id
GROUP BY LEAST(s.teacher_id, s.learner_id), GREATEST(s.teacher_id, s.learner_id)
ON CONFLICT (user_low, user_high) DO UPDATE
  SET last_message_at = GREATEST(
    public.conversations.last_message_at,
    EXCLUDED.last_message_at
  );

-- Attach existing messages to their conversation.
UPDATE public.messages m
SET conversation_id = c.id
FROM public.sessions s
JOIN public.conversations c
  ON c.user_low  = LEAST(s.teacher_id, s.learner_id)
 AND c.user_high = GREATEST(s.teacher_id, s.learner_id)
WHERE m.session_id = s.id
  AND m.conversation_id IS NULL;

-- conversation_id stays NULLABLE on purpose. The only rows left unattached are
-- messages whose session lost a participant to account deletion (teacher_id or
-- learner_id was nulled via ON DELETE SET NULL) — there is no valid user pair
-- to form a conversation from. These were already invisible in the old inbox
-- (thread grouping skipped null-participant threads) and stay invisible now:
-- the SELECT policy below requires a conversation the caller belongs to, which
-- a NULL conversation_id can never satisfy. New messages always carry a
-- conversation_id — the INSERT policy rejects a NULL one (no membership match).
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at);

-- session_id becomes optional context; deleting a session keeps chat history.
ALTER TABLE public.messages ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_session_id_fkey;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

-- 3. Column grants: let the client set conversation_id on insert ------------

REVOKE INSERT, UPDATE ON public.messages FROM anon, authenticated;
GRANT INSERT (
  conversation_id,
  session_id,
  sender_id,
  text,
  attachment_path,
  attachment_kind,
  attachment_name,
  attachment_size,
  attachment_mime
) ON public.messages TO authenticated;
GRANT UPDATE (text) ON public.messages TO authenticated;

-- 4. RLS: gate on conversation membership instead of session participation --

DROP POLICY IF EXISTS "Participants view messages" ON public.messages;
CREATE POLICY "Participants view messages" ON public.messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id
      AND ((select auth.uid()) = c.user_low OR (select auth.uid()) = c.user_high)
  ));

DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = sender_id
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
        AND ((select auth.uid()) = c.user_low OR (select auth.uid()) = c.user_high)
    )
    -- A referenced session (for context/attachments) must include the sender.
    AND (
      session_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = session_id
          AND (s.teacher_id = (select auth.uid()) OR s.learner_id = (select auth.uid()))
      )
    )
  );

-- 5. Integrity: lock conversation_id (and existing immutable fields) --------

CREATE OR REPLACE FUNCTION public.protect_message_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR OLD.sender_id IS DISTINCT FROM NEW.sender_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.attachment_path IS DISTINCT FROM NEW.attachment_path
     OR OLD.attachment_kind IS DISTINCT FROM NEW.attachment_kind
     OR OLD.attachment_name IS DISTINCT FROM NEW.attachment_name
     OR OLD.attachment_size IS DISTINCT FROM NEW.attachment_size
     OR OLD.attachment_mime IS DISTINCT FROM NEW.attachment_mime THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Message ownership, timestamps, and attachments cannot be changed.';
  END IF;

  IF NEW.text IS DISTINCT FROM OLD.text THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.protect_message_integrity() FROM PUBLIC, anon, authenticated;

-- 6. Anti-spam caps, generalized to conversations ---------------------------
-- The 40/day + 5-unanswered caps now apply when the conversation has NO
-- accepted/active session (cold / pre-acceptance chat). Once an accepted or
-- active session exists between the pair, caps lift and attachments unlock.

ALTER TABLE public.pending_message_send_log
  ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE public.pending_message_send_log
  ALTER COLUMN session_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS pending_message_send_log_conv_sender_idx
  ON public.pending_message_send_log (conversation_id, sender_id);

-- Backfill conversation_id on existing log rows from their session's pair.
UPDATE public.pending_message_send_log l
SET conversation_id = c.id
FROM public.sessions s
JOIN public.conversations c
  ON c.user_low  = LEAST(s.teacher_id, s.learner_id)
 AND c.user_high = GREATEST(s.teacher_id, s.learner_id)
WHERE l.session_id = s.id
  AND l.conversation_id IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_pending_message_caps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_low uuid;
  v_high uuid;
  v_recipient uuid;
  v_has_open_session boolean;
  v_daily_count int;
  v_unanswered_count int;
BEGIN
  SELECT user_low, user_high
  INTO v_low, v_high
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- An accepted/active session between this pair is an established
  -- relationship: lift the caps and allow attachments.
  SELECT EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.status IN ('accepted', 'active')
      AND LEAST(s.teacher_id, s.learner_id) = v_low
      AND GREATEST(s.teacher_id, s.learner_id) = v_high
  ) INTO v_has_open_session;

  IF v_has_open_session THEN
    RETURN NEW;
  END IF;

  -- Cold / pre-acceptance chat. Attachments stay gated behind acceptance.
  IF NEW.attachment_path IS NOT NULL THEN
    RAISE EXCEPTION 'Image and file sharing unlocks after the teacher accepts the session.'
      USING ERRCODE = 'P0001';
  END IF;

  v_recipient := CASE WHEN NEW.sender_id = v_low THEN v_high ELSE v_low END;

  -- Daily cap: per-sender, counted from the append-only log (unsend-proof).
  SELECT COUNT(*) INTO v_daily_count
  FROM public.pending_message_send_log
  WHERE sender_id = NEW.sender_id
    AND created_at >= date_trunc('day', timezone('UTC', now()));

  IF v_daily_count >= 40 THEN
    RAISE EXCEPTION 'Daily message limit reached (40). Resets at midnight UTC.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Unanswered cap: until the recipient has sent in this conversation (read
  -- from the log so an unsent reply can't silently re-restrict the sender),
  -- the sender is limited to 5 messages.
  IF NOT EXISTS (
    SELECT 1 FROM public.pending_message_send_log l
    WHERE l.conversation_id = NEW.conversation_id
      AND l.sender_id = v_recipient
  ) THEN
    SELECT COUNT(*) INTO v_unanswered_count
    FROM public.pending_message_send_log
    WHERE conversation_id = NEW.conversation_id
      AND sender_id = NEW.sender_id;

    IF v_unanswered_count >= 5 THEN
      RAISE EXCEPTION 'You can send up to 5 messages before they reply.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.pending_message_send_log (sender_id, session_id, conversation_id)
  VALUES (NEW.sender_id, NEW.session_id, NEW.conversation_id);

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.enforce_pending_message_caps() FROM PUBLIC, anon, authenticated;

-- 7. Notifications: derive recipient from the conversation ------------------
-- Keep the function name so the existing messages_notify_session_message
-- trigger keeps firing. Also bump conversations.last_message_at for inbox
-- ordering. Link points the recipient at the sender's thread.

CREATE OR REPLACE FUNCTION public.notify_session_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_low uuid;
  v_high uuid;
  v_receiver_id uuid;
  v_sender_name text;
  v_skill_name text;
BEGIN
  SELECT user_low, user_high
  INTO v_low, v_high
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  UPDATE public.conversations
    SET last_message_at = NEW.created_at
    WHERE id = NEW.conversation_id;

  v_receiver_id := CASE WHEN NEW.sender_id = v_low THEN v_high ELSE v_low END;

  IF v_receiver_id IS NULL OR v_receiver_id = NEW.sender_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(full_name, 'Someone')
  INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;

  IF NEW.session_id IS NOT NULL THEN
    SELECT COALESCE(sk.name, 'a session')
    INTO v_skill_name
    FROM public.sessions s
    LEFT JOIN public.skills sk ON sk.id = s.skill_id
    WHERE s.id = NEW.session_id;
  END IF;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    body,
    link,
    metadata
  )
  VALUES (
    v_receiver_id,
    'message',
    COALESCE(v_sender_name, 'Someone') || ' sent you a message',
    LEFT(NEW.text, 160),
    '/messages?u=' || NEW.sender_id::text,
    jsonb_build_object(
      'conversationId', NEW.conversation_id,
      'sessionId', NEW.session_id,
      'senderId', NEW.sender_id,
      'skillName', COALESCE(v_skill_name, 'a message')
    )
  );

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_session_message() FROM PUBLIC, anon, authenticated;

-- 8. Reports: validate a reported message via its conversation -------------
-- check_report_safe used to INNER JOIN messages -> sessions to confirm the
-- reporter could see the message. Decoupled messages can have a NULL
-- session_id, so visibility is now checked against the conversation; a linked
-- session (when present) is still coalesced in for moderator context.

CREATE OR REPLACE FUNCTION public.check_report_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_count_24h INT;
  v_count_target INT;
  v_message RECORD;
  v_review RECORD;
  v_session RECORD;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Log in before submitting reports.';
  END IF;

  IF NEW.message_id IS NOT NULL AND NEW.review_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Report one item at a time.';
  END IF;

  NEW.reporter_id := v_actor;
  NEW.status := 'open';
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.details := NULLIF(btrim(NEW.details), '');

  IF NEW.reported_user_id IS NULL
     AND NEW.session_id IS NULL
     AND NEW.message_id IS NULL
     AND NEW.review_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Choose something to report.';
  END IF;

  IF NEW.message_id IS NOT NULL THEN
    SELECT
      m.session_id,
      m.sender_id
    INTO v_message
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = NEW.message_id
      AND (c.user_low = v_actor OR c.user_high = v_actor);

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported message was not found or is not visible to you.';
    END IF;

    IF NEW.session_id IS NOT NULL
       AND v_message.session_id IS NOT NULL
       AND NEW.session_id <> v_message.session_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported message does not belong to that session.';
    END IF;

    NEW.session_id := COALESCE(NEW.session_id, v_message.session_id);

    IF v_message.sender_id IS NOT NULL THEN
      IF NEW.reported_user_id IS NULL THEN
        NEW.reported_user_id := v_message.sender_id;
      ELSIF NEW.reported_user_id <> v_message.sender_id THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Reported user must match the message sender.';
      END IF;
    END IF;
  END IF;

  IF NEW.review_id IS NOT NULL THEN
    SELECT
      r.session_id,
      r.reviewer_id,
      r.reviewee_id
    INTO v_review
    FROM public.reviews r
    WHERE r.id = NEW.review_id
      AND (
        r.reviewer_id = v_actor
        OR r.created_at < now() - interval '14 days'
        OR EXISTS (
          SELECT 1
          FROM public.reviews r2
          WHERE r2.session_id = r.session_id
            AND r2.reviewer_id = r.reviewee_id
            AND r2.reviewee_id = r.reviewer_id
        )
      );

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported review was not found or is not visible to you.';
    END IF;

    IF NEW.session_id IS NOT NULL AND NEW.session_id <> v_review.session_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported review does not belong to that session.';
    END IF;

    IF v_review.reviewer_id IS NOT NULL THEN
      IF NEW.reported_user_id IS NULL THEN
        NEW.reported_user_id := v_review.reviewer_id;
      ELSIF NEW.reported_user_id <> v_review.reviewer_id THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Reported user must match the review author.';
      END IF;
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    SELECT
      s.teacher_id,
      s.learner_id
    INTO v_session
    FROM public.sessions s
    WHERE s.id = NEW.session_id
      AND (s.teacher_id = v_actor OR s.learner_id = v_actor);

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported session was not found or is not visible to you.';
    END IF;

    IF NEW.reported_user_id IS NULL THEN
      NEW.reported_user_id := CASE
        WHEN v_session.teacher_id = v_actor THEN v_session.learner_id
        WHEN v_session.learner_id = v_actor THEN v_session.teacher_id
        ELSE NULL
      END;
    ELSIF NOT (
      NEW.reported_user_id IS NOT DISTINCT FROM v_session.teacher_id
      OR NEW.reported_user_id IS NOT DISTINCT FROM v_session.learner_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Reported user must be part of the reported session.';
    END IF;
  END IF;

  IF NEW.reported_user_id IS NOT NULL AND NEW.reported_user_id = NEW.reporter_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You cannot report yourself.';
  END IF;

  IF NEW.reported_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles
       WHERE id = NEW.reported_user_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Reported user was not found.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = NEW.reporter_id AND onboarded = true
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Finish onboarding before submitting reports.';
  END IF;

  SELECT COUNT(*) INTO v_count_24h
  FROM public.reports
  WHERE reporter_id = NEW.reporter_id
    AND created_at > now() - interval '24 hours';
  IF v_count_24h >= 5 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'You have reached the daily report limit. Try again later.';
  END IF;

  IF NEW.reported_user_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count_target
    FROM public.reports
    WHERE reporter_id = NEW.reporter_id
      AND reported_user_id = NEW.reported_user_id
      AND created_at > now() - interval '7 days';
    IF v_count_target >= 3 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'You have already reported this user multiple times this week. A moderator will review the existing reports.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_report_safe() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
