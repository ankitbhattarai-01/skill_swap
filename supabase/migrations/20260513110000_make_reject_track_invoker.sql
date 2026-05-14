-- Supabase security advisor: Signed-In Users Can Execute SECURITY DEFINER Function.
--
-- reject_track only lets the teacher decline a proposed track. Put that rule
-- into RLS and run the RPC as the caller. accept_track/end_track still touch
-- planned-session rows and remain SECURITY DEFINER.
GRANT SELECT ON public.learning_tracks TO authenticated;
GRANT UPDATE (status, end_reason, ended_by, ended_at) ON public.learning_tracks TO authenticated;

DROP POLICY IF EXISTS "Teachers reject proposed tracks" ON public.learning_tracks;
CREATE POLICY "Teachers reject proposed tracks" ON public.learning_tracks
  FOR UPDATE TO authenticated
  USING (
    teacher_id = auth.uid()
    AND status = 'proposed'
  )
  WITH CHECK (
    teacher_id = auth.uid()
    AND status = 'rejected'
    AND ended_by = auth.uid()
    AND ended_at IS NOT NULL
  );

ALTER FUNCTION public.reject_track(UUID, TEXT) SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';
