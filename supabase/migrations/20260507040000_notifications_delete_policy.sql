-- Allow users to dismiss their own notifications
DROP POLICY IF EXISTS "Users delete their notifications" ON public.notifications;
CREATE POLICY "Users delete their notifications" ON public.notifications
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
