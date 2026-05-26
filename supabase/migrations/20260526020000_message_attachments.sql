-- Message attachments: allow a single image or document per message, capped
-- at 5 MiB. Files live in the private `message-attachments` bucket; clients
-- must request a signed URL to render or download. Storage RLS limits read
-- to session participants, write to the uploading user, and bucket-level
-- size + MIME caps enforce limits regardless of which SDK the caller uses.

-- 1. Schema -----------------------------------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_path TEXT,
  ADD COLUMN IF NOT EXISTS attachment_kind TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size INT,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_attachment_kind_chk,
  DROP CONSTRAINT IF EXISTS messages_attachment_complete_chk,
  DROP CONSTRAINT IF EXISTS messages_text_or_attachment_chk,
  DROP CONSTRAINT IF EXISTS messages_attachment_size_chk;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_attachment_kind_chk
    CHECK (attachment_kind IS NULL OR attachment_kind IN ('image', 'document'));

-- Either the attachment quintuple is fully populated or fully null.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_attachment_complete_chk
    CHECK (
      (attachment_path IS NULL
        AND attachment_kind IS NULL
        AND attachment_name IS NULL
        AND attachment_size IS NULL
        AND attachment_mime IS NULL)
      OR
      (attachment_path IS NOT NULL
        AND attachment_kind IS NOT NULL
        AND attachment_name IS NOT NULL
        AND attachment_size IS NOT NULL
        AND attachment_mime IS NOT NULL)
    );

-- A message must carry text, an attachment, or both.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_text_or_attachment_chk
    CHECK (length(btrim(text)) > 0 OR attachment_path IS NOT NULL);

-- Defense-in-depth on the 5 MiB cap (storage bucket also enforces).
ALTER TABLE public.messages
  ADD CONSTRAINT messages_attachment_size_chk
    CHECK (attachment_size IS NULL OR (attachment_size > 0 AND attachment_size <= 5 * 1024 * 1024));

-- 2. Column grants ---------------------------------------------------------
-- Mirror migration 20260509080000 — only allow the client to populate the
-- attachment fields on INSERT. UPDATE still only allows `text` so callers
-- cannot retroactively attach or swap files.

REVOKE INSERT, UPDATE ON public.messages FROM anon, authenticated;
GRANT INSERT (
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

-- 3. Integrity trigger -----------------------------------------------------
-- Lock attachment columns post-insert so an edit can't replace the file.

CREATE OR REPLACE FUNCTION public.protect_message_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
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

-- 4. Storage bucket --------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('message-attachments', 'message-attachments', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

UPDATE storage.buckets
SET
  file_size_limit = 5 * 1024 * 1024,
  allowed_mime_types = ARRAY[
    -- Images
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    -- Documents (standard set)
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- .docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       -- .xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', -- .pptx
    'text/plain',
    'text/csv'
  ]
WHERE id = 'message-attachments';

-- 5. Storage RLS ----------------------------------------------------------
-- Path convention: {session_id}/{uploader_user_id}/{uuid}.{ext}
-- folder[1] = session_id, folder[2] = uploader_user_id.

DROP POLICY IF EXISTS "Participants read message attachments" ON storage.objects;
CREATE POLICY "Participants read message attachments" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'message-attachments'
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id::text = (storage.foldername(name))[1]
        AND (s.teacher_id = (SELECT auth.uid()) OR s.learner_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Participants upload message attachments" ON storage.objects;
CREATE POLICY "Participants upload message attachments" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'message-attachments'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id::text = (storage.foldername(name))[1]
        AND (s.teacher_id = (SELECT auth.uid()) OR s.learner_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Uploaders delete own message attachments" ON storage.objects;
CREATE POLICY "Uploaders delete own message attachments" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'message-attachments'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );
