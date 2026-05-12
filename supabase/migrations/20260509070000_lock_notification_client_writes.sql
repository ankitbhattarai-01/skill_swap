-- Keep notification contents server-owned.
--
-- Users may read/delete their own notifications through RLS and may mark them
-- read, but browser clients should not be able to forge notification titles,
-- links, metadata, recipients, or system-created timestamps.

REVOKE INSERT, UPDATE ON public.notifications FROM anon, authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;
