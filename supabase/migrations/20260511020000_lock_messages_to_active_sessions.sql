-- Stop direct-API chat on pending sessions.
--
-- Before: the insert policy on public.messages allowed sender_id = auth.uid()
-- as long as the session was in pending/accepted/active. The UI already only
-- exposes chat once the session is accepted (CHAT_SESSION_STATUSES in
-- src/lib/sessions.ts), but a caller using the raw Supabase client could
-- still drop messages into a pending session and bypass the "no contact
-- before acceptance" boundary (SEC-002).
--
-- After: messages can only be inserted while the session is accepted or
-- active. The select policy stays unchanged — old pending threads are not
-- a concern because none were intentionally allowed.

DROP POLICY IF EXISTS "Participants send messages" ON public.messages;
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND s.status IN ('accepted', 'active')
        AND (s.teacher_id = auth.uid() OR s.learner_id = auth.uid())
    )
  );
