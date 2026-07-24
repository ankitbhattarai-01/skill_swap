-- AI session notes.
--
-- Two pieces:
--   1. public.session_notes — the durable artifact. Holds the generated notes
--      so a participant can re-download the PDF months later without ever
--      re-processing audio.
--   2. storage bucket `session-audio` — a TRANSIENT staging area. The client
--      uploads the mixed call audio here; the generate-session-notes Edge
--      Function downloads it with the service-role key and deletes it in a
--      `finally` block as soon as Gemini returns (success or failure). Raw
--      audio is never meant to outlive a single function invocation.
--
-- The bucket therefore has NO select policy for `authenticated`: only the
-- service role ever reads it, and only to immediately consume-and-delete.

-- 1. Notes table -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.session_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL UNIQUE REFERENCES public.sessions(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'processing',
  notes        JSONB,
  error        TEXT,
  model        TEXT,
  duration_ms  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at TIMESTAMPTZ
);

ALTER TABLE public.session_notes
  DROP CONSTRAINT IF EXISTS session_notes_status_chk,
  DROP CONSTRAINT IF EXISTS session_notes_ready_chk;

ALTER TABLE public.session_notes
  ADD CONSTRAINT session_notes_status_chk
    CHECK (status IN ('processing', 'ready', 'failed'));

-- A row claiming to be 'ready' must actually carry notes, so the client can
-- treat status='ready' as a guarantee that `notes` is non-null.
ALTER TABLE public.session_notes
  ADD CONSTRAINT session_notes_ready_chk
    CHECK (status <> 'ready' OR notes IS NOT NULL);

CREATE INDEX IF NOT EXISTS session_notes_session_idx
  ON public.session_notes (session_id);

ALTER TABLE public.session_notes ENABLE ROW LEVEL SECURITY;

-- Participants read. Writes are service-role only (the Edge Function owns the
-- whole lifecycle), so there is deliberately no INSERT/UPDATE/DELETE policy
-- for `authenticated` — a client cannot forge or edit notes.
DROP POLICY IF EXISTS "Participants read session notes" ON public.session_notes;
CREATE POLICY "Participants read session notes" ON public.session_notes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_notes.session_id
        AND (s.teacher_id = (SELECT auth.uid()) OR s.learner_id = (SELECT auth.uid()))
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.session_notes FROM anon, authenticated;
GRANT SELECT ON public.session_notes TO authenticated;
GRANT ALL ON public.session_notes TO service_role;

-- Let the client watch its own row flip processing -> ready without polling.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'session_notes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.session_notes;
  END IF;
END
$$;

-- 2. Audio staging bucket ----------------------------------------------------
-- 18 MiB cap is the enforcement point for Gemini's 20 MB inline-request limit.
-- At the 32 kbps Opus bitrate the recorder uses, that is ~75 minutes of audio,
-- comfortably past any realistic session length.

INSERT INTO storage.buckets (id, name, public)
VALUES ('session-audio', 'session-audio', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

UPDATE storage.buckets
SET
  file_size_limit = 18 * 1024 * 1024,
  allowed_mime_types = ARRAY['audio/webm', 'audio/ogg', 'audio/mp4']
WHERE id = 'session-audio';

-- 3. Storage RLS -------------------------------------------------------------
-- Path convention: {session_id}/{uploader_user_id}/{uuid}.webm
-- folder[1] = session_id, folder[2] = uploader_user_id — same shape as the
-- message-attachments bucket (migration 20260526020000).

DROP POLICY IF EXISTS "Participants upload session audio" ON storage.objects;
CREATE POLICY "Participants upload session audio" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'session-audio'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id::text = (storage.foldername(name))[1]
        AND (s.teacher_id = (SELECT auth.uid()) OR s.learner_id = (SELECT auth.uid()))
    )
  );

-- Lets the client clean up after an aborted upload or a failed generation, so
-- a dropped request can't strand a recording in the bucket.
DROP POLICY IF EXISTS "Uploaders delete own session audio" ON storage.objects;
CREATE POLICY "Uploaders delete own session audio" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'session-audio'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );
