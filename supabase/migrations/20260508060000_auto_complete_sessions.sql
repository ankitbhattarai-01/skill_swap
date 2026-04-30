-- Auto-complete accepted sessions whose dispute window has elapsed.
--
-- A session that nobody completes or cancels stays in 'accepted' forever, with
-- credits held in escrow. This function sweeps up any session past its cutoff
-- and releases the credits to the teacher (defaulting in their favour, since
-- the credits were already debited from the learner at accept time).
--
-- Cutoff: 7 days after the session would have ended (scheduled_at +
-- duration_minutes), or 7 days after acceptance if no scheduled_at is set.
--
-- The function is callable by any authenticated user. It's idempotent: if no
-- sessions are due, it does nothing. It uses FOR UPDATE SKIP LOCKED so two
-- callers running concurrently don't fight over the same rows.

CREATE INDEX IF NOT EXISTS sessions_status_updated_at_idx
  ON public.sessions (status, updated_at)
  WHERE status = 'accepted' AND escrow_held = true;
CREATE OR REPLACE FUNCTION public.auto_complete_due_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions;
  v_count integer := 0;
BEGIN
  FOR v_session IN
    SELECT *
    FROM public.sessions
    WHERE status = 'accepted'
      AND escrow_held = true
      AND now() >
        COALESCE(
          scheduled_at + (duration_minutes * INTERVAL '1 minute'),
          updated_at
        ) + INTERVAL '7 days'
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.profiles
    SET credits = credits + v_session.credits
    WHERE id = v_session.teacher_id;

    INSERT INTO public.credit_transactions (
      from_user, to_user, amount, session_id, description
    ) VALUES (
      v_session.learner_id, v_session.teacher_id, v_session.credits, v_session.id,
      'Session auto-completed after 7 days'
    );

    UPDATE public.sessions
    SET status = 'completed', escrow_held = false
    WHERE id = v_session.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.auto_complete_due_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_complete_due_sessions() TO authenticated;
