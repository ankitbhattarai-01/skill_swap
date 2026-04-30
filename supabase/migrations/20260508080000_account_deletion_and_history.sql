-- Account deletion and history preservation.
--
-- Three things in one migration because they have to land together:
--
-- 1. Switch the user-referencing FKs on shared records (sessions, messages,
--    reviews) from ON DELETE CASCADE to ON DELETE SET NULL. Today, deleting a
--    teacher's auth row erases the *learner's* completed-session history,
--    earned reviews, and chat transcripts. With SET NULL, the surviving party
--    keeps their record; the deleted user just shows up as a tombstone.
--
-- 2. A BEFORE DELETE trigger on auth.users that walks every non-terminal
--    session the user is part of, refunds escrow to the learner if it was
--    held, and flips the session to 'cancelled'. Without this, the cascade
--    would silently destroy the session row and the learner's already-
--    deducted credits would be unrecoverable.
--
-- 3. A SECURITY DEFINER RPC `delete_my_account` so authenticated users can
--    delete themselves without a service-role key. Deleting from auth.users
--    fires the trigger above, which cleans up escrow before the SET NULL
--    cascade settles the FKs.

-- 1. Sessions: allow nulls and switch FK action.
ALTER TABLE public.sessions
  ALTER COLUMN teacher_id DROP NOT NULL,
  ALTER COLUMN learner_id DROP NOT NULL;
ALTER TABLE public.sessions
  DROP CONSTRAINT sessions_teacher_id_fkey,
  ADD CONSTRAINT sessions_teacher_id_fkey FOREIGN KEY (teacher_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sessions
  DROP CONSTRAINT sessions_learner_id_fkey,
  ADD CONSTRAINT sessions_learner_id_fkey FOREIGN KEY (learner_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;
-- 2. Messages: keep the chat history attached to the session even when the
--    sender's account is gone. NULL sender renders as "Deleted user" in the UI.
ALTER TABLE public.messages
  ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE public.messages
  DROP CONSTRAINT messages_sender_id_fkey,
  ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;
-- 3. Reviews: preserve star aggregates and comment history.
ALTER TABLE public.reviews
  ALTER COLUMN reviewer_id DROP NOT NULL,
  ALTER COLUMN reviewee_id DROP NOT NULL;
ALTER TABLE public.reviews
  DROP CONSTRAINT reviews_reviewer_id_fkey,
  ADD CONSTRAINT reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.reviews
  DROP CONSTRAINT reviews_reviewee_id_fkey,
  ADD CONSTRAINT reviews_reviewee_id_fkey FOREIGN KEY (reviewee_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;
-- 4. Pre-delete refund trigger.
CREATE OR REPLACE FUNCTION public.refund_open_sessions_before_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
BEGIN
  FOR v_session IN
    SELECT *
    FROM public.sessions
    WHERE (teacher_id = OLD.id OR learner_id = OLD.id)
      AND status IN ('pending', 'accepted', 'active')
    FOR UPDATE
  LOOP
    IF v_session.escrow_held AND v_session.learner_id IS NOT NULL THEN
      UPDATE public.profiles
      SET credits = credits + v_session.credits
      WHERE id = v_session.learner_id;

      INSERT INTO public.credit_transactions (
        from_user, to_user, amount, session_id, description
      ) VALUES (
        NULL, v_session.learner_id, v_session.credits, v_session.id,
        'Refund: counterparty deleted account'
      );
    END IF;

    UPDATE public.sessions
    SET status = 'cancelled', escrow_held = false
    WHERE id = v_session.id;
  END LOOP;

  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS refund_open_sessions_before_auth_user_delete ON auth.users;
CREATE TRIGGER refund_open_sessions_before_auth_user_delete
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.refund_open_sessions_before_user_delete();
-- 5. Self-serve deletion RPC. Removing the auth row cascades through the
--    pre-delete trigger above (refunds), then SET NULL on shared records,
--    then CASCADE on profile/teaching/learning skills/notifications.
CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
