-- =============================================================================
-- Per-conversation latest-message previews for the Messages inbox.
--
-- The sidebar used to fetch the newest min(5 × conversations, 200) message
-- rows ACROSS all of a user's conversations and pick each thread's latest in
-- JS. One chatty thread could fill the whole window, leaving quieter threads
-- with no preview at all. DISTINCT ON gives exactly one row — the newest — per
-- conversation, regardless of how busy the others are.
--
-- SECURITY INVOKER: runs under the caller's RLS, so it can only see messages
-- in conversations the caller participates in — same visibility as the direct
-- query it replaces.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.conversation_latest_messages(p_conversation_ids uuid[])
RETURNS TABLE (
  conversation_id uuid,
  text text,
  created_at timestamptz,
  sender_id uuid,
  attachment_kind text,
  attachment_name text
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    m.text,
    m.created_at,
    m.sender_id,
    m.attachment_kind::text,
    m.attachment_name
  FROM public.messages m
  WHERE m.conversation_id = ANY (p_conversation_ids)
  ORDER BY m.conversation_id, m.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.conversation_latest_messages(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_latest_messages(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
