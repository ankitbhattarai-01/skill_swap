import { supabase } from "@/integrations/supabase/client";

// Chat is decoupled from sessions: a conversation is a first-class thread
// between two users that does NOT create or require a session. Opening a chat
// resolves (or lazily creates) the conversation via a SECURITY DEFINER RPC
// that canonicalizes the {me, other} pair server-side. A session request is a
// separate, explicit action — see getOrCreateSession in @/lib/sessions.
export async function getOrCreateConversation(otherUserId: string): Promise<{
  conversationId: string | null;
  error: Error | null;
}> {
  const { data, error } = await supabase.rpc("get_or_create_conversation", {
    other_user: otherUserId,
  });
  if (error) return { conversationId: null, error };
  return { conversationId: (data as string | null) ?? null, error: null };
}
