-- Message edit + unsend support
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
-- Allow senders to edit their own messages (text only)
DROP POLICY IF EXISTS "Senders update own messages" ON public.messages;
CREATE POLICY "Senders update own messages" ON public.messages
  FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);
-- Allow senders to unsend (delete) their own messages
DROP POLICY IF EXISTS "Senders delete own messages" ON public.messages;
CREATE POLICY "Senders delete own messages" ON public.messages
  FOR DELETE TO authenticated
  USING (auth.uid() = sender_id);
-- Required so realtime DELETE/UPDATE events ship the full row to clients
ALTER TABLE public.messages REPLICA IDENTITY FULL;
