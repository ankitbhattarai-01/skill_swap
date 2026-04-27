-- Allow teachers to edit scheduling and meeting details while a session is
-- still open. The integrity trigger continues to reject invalid status changes
-- and participant/skill/credit edits.
DROP POLICY IF EXISTS "Teachers update open session details" ON public.sessions;
CREATE POLICY "Teachers update open session details" ON public.sessions
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = teacher_id
    AND status IN ('pending', 'accepted')
  )
  WITH CHECK (
    auth.uid() = teacher_id
    AND status IN ('pending', 'accepted')
  );
