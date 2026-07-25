-- =============================================================================
-- Fix: teacher-initiated offers notified the WRONG person.
--
-- A pending session can be created from either side:
--   • learner initiates  → "request to learn"  (initiator_id = learner_id)
--   • teacher initiates  → "offer to teach"    (initiator_id = teacher_id),
--     the dashboard/explore "Offer" button on a learner who wants that skill.
--
-- notify_session_lifecycle's INSERT branch hard-coded NEW.teacher_id as the
-- recipient and "<learner> requested a session" as the title. For an offer that
-- is exactly backwards: the teacher (who just clicked Offer) got a bell item
-- saying the OTHER person had requested a session, while the learner — the one
-- who actually has to accept or decline — was told nothing at all. Same
-- mis-addressing on the accepted/rejected updates, which always notified the
-- learner even when the learner was the one who had just responded.
--
-- The rule everywhere else in the codebase (accept_session, reject_session, and
-- all four accept/reject surfaces in the client) is: the initiator is
-- COALESCE(initiator_id, learner_id), and the OTHER participant is the one who
-- must respond. This trigger now follows the same rule:
--
--   INSERT   → notify the counterparty (the person who must respond)
--   accepted → notify the initiator (the person who was waiting on the reply)
--   rejected → notify the initiator
--   cancelled / completed → unchanged, both participants are notified
--
-- Offers get their own notification type, 'session_offered', which the client
-- already styles and toasts (SessionEventHeadsUp) but which nothing had ever
-- produced. Requests keep 'session_requested' so existing bell items, email
-- templates and the send-session-email allow-list are unaffected.
--
-- Everything else in this function is copied VERBATIM from the current
-- production version (20260612200000_direct_skill_swaps.sql, section 4),
-- including the leading swap short-circuit — swap rows are still notified only
-- by propose_swap / respond_to_swap / cancel_swap.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.notify_session_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_skill_name TEXT;
  v_teacher_name TEXT;
  v_learner_name TEXT;
  v_initiator UUID;
  v_is_offer BOOLEAN;
  v_meta JSONB;
BEGIN
  -- Swaps are notified from propose_swap / respond_to_swap / completion.
  IF NEW.is_swap THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(name, 'Skill session') INTO v_skill_name
  FROM public.skills WHERE id = NEW.skill_id;

  SELECT COALESCE(full_name, 'Teacher') INTO v_teacher_name
  FROM public.profiles WHERE id = NEW.teacher_id;

  SELECT COALESCE(full_name, 'Learner') INTO v_learner_name
  FROM public.profiles WHERE id = NEW.learner_id;

  -- Who started this? Legacy rows predate initiator_id and were always created
  -- by the learner, hence the COALESCE — identical to the RPCs' own guard.
  v_initiator := COALESCE(NEW.initiator_id, NEW.learner_id);
  -- Defensive on the IS DISTINCT FROM: a row where teacher = learner would make
  -- "offer" and "request" indistinguishable, so treat it as an ordinary request.
  v_is_offer := (v_initiator = NEW.teacher_id AND NEW.teacher_id IS DISTINCT FROM NEW.learner_id);

  v_meta := jsonb_build_object(
    'sessionId', NEW.id, 'skillId', NEW.skill_id,
    'learnerId', NEW.learner_id, 'teacherId', NEW.teacher_id,
    'initiatorId', v_initiator,
    'status', NEW.status
  );

  IF TG_OP = 'INSERT' THEN
    IF v_is_offer THEN
      -- Teacher offered to teach: the LEARNER decides.
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.learner_id,
        'session_offered',
        COALESCE(v_teacher_name, 'Someone') || ' offered to teach you',
        COALESCE(v_skill_name, 'Skill session') || ' • ' || NEW.credits::TEXT || ' credits',
        '/sessions/' || NEW.id::TEXT,
        v_meta
      );
    ELSE
      -- Learner requested a session: the TEACHER decides.
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        NEW.teacher_id,
        'session_requested',
        COALESCE(v_learner_name, 'Someone') || ' requested a session',
        COALESCE(v_skill_name, 'Skill session') || ' • ' || NEW.credits::TEXT || ' credits',
        '/sessions/' || NEW.id::TEXT,
        v_meta
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'accepted' THEN
      IF v_is_offer THEN
        INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
        VALUES (
          NEW.teacher_id,
          'session_accepted',
          COALESCE(v_learner_name, 'Your learner') || ' accepted your offer',
          COALESCE(v_skill_name, 'Skill session') || ' is ready',
          '/sessions/' || NEW.id::TEXT,
          v_meta
        );
      ELSE
        INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
        VALUES (
          NEW.learner_id,
          'session_accepted',
          COALESCE(v_teacher_name, 'Your teacher') || ' accepted your session',
          COALESCE(v_skill_name, 'Skill session') || ' is ready',
          '/sessions/' || NEW.id::TEXT,
          v_meta
        );
      END IF;
    ELSIF NEW.status = 'rejected' THEN
      IF v_is_offer THEN
        INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
        VALUES (
          NEW.teacher_id,
          'session_rejected',
          COALESCE(v_learner_name, 'Your learner') || ' declined your offer',
          COALESCE(v_skill_name, 'Skill session') || ' offer was not accepted',
          '/dashboard',
          v_meta
        );
      ELSE
        INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
        VALUES (
          NEW.learner_id,
          'session_rejected',
          COALESCE(v_teacher_name, 'Your teacher') || ' rejected your session',
          COALESCE(v_skill_name, 'Skill session') || ' request was not accepted',
          '/dashboard',
          v_meta
        );
      END IF;
    ELSIF NEW.status = 'cancelled' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_teacher_name, 'your teacher') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          v_meta
        ),
        (
          NEW.teacher_id,
          'session_cancelled',
          COALESCE(v_skill_name, 'Skill session') || ' was cancelled',
          'Session with ' || COALESCE(v_learner_name, 'your learner') || ' is off',
          '/sessions/' || NEW.id::TEXT,
          v_meta
        );
    ELSIF NEW.status = 'completed' THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES
        (
          NEW.learner_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were sent to ' || COALESCE(v_teacher_name, 'your teacher'),
          '/history',
          v_meta
        ),
        (
          NEW.teacher_id,
          'session_completed',
          COALESCE(v_skill_name, 'Skill session') || ' completed',
          NEW.credits::TEXT || ' credits were received from ' || COALESCE(v_learner_name, 'your learner'),
          '/history',
          v_meta
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_session_lifecycle() FROM PUBLIC, anon, authenticated;


-- ─── Repair: drop the self-addressed rows the old trigger already wrote ──────
-- Every offer made so far put a "<the other person> requested a session" item
-- in the OFFERER's own bell. They are pure noise (the offerer is the initiator;
-- there is nothing for them to accept) and they are what makes the app look
-- like it is showing you your own request. Matched by joining on the session id
-- stored in metadata — compared as text so a row with malformed metadata can
-- never raise a cast error mid-migration.
--
-- Deliberately no backfill of the missing learner-side notifications: an INSERT
-- into notifications fires the email fanout trigger, and blasting emails about
-- weeks-old offers would be worse than the silence. New offers notify correctly
-- from here on, and the offers themselves are still visible in both dashboards.
DELETE FROM public.notifications n
USING public.sessions s
WHERE n.type = 'session_requested'
  AND s.id::text = n.metadata->>'sessionId'
  AND s.initiator_id = s.teacher_id
  AND s.teacher_id IS DISTINCT FROM s.learner_id
  AND n.user_id = s.teacher_id;
