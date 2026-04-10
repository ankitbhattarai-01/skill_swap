// Ephemeral call-signaling over Supabase Realtime Broadcast.
//
// Persisting "ringing" events in the notifications table doesn't make sense
// — they're only meaningful while both parties are online at the same time,
// and they should disappear the moment the call is answered, declined, or
// times out. Broadcast fits exactly that shape: send-and-forget messages on
// a per-user channel, no DB write, no RLS, no cleanup.
//
// Channel naming: each user subscribes to `call-signal-<userId>` so other
// users can ring them by sending broadcasts on that channel name.

import { supabase } from "@/integrations/supabase/client";

export type CallRingingPayload = {
  sessionId: string;
  callerId: string;
  callerName: string;
  skillName: string | null;
};

export type CallDeclinedPayload = {
  sessionId: string;
};

export async function sendCallRinging(
  targetUserId: string,
  payload: CallRingingPayload,
): Promise<void> {
  const channel = supabase.channel(`call-signal-${targetUserId}`, {
    config: { broadcast: { self: false } },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("subscribe timeout")), 4000);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(t);
          resolve();
        }
      });
    });
    await channel.send({
      type: "broadcast",
      event: "call_ringing",
      payload,
    });
  } finally {
    void supabase.removeChannel(channel);
  }
}

// Decline is persisted to call_decline_signals (RLS-gated) instead of
// broadcast. Broadcast has no sender authentication — anyone authenticated
// who knew a sessionId could fake a decline and kick the legitimate caller
// out of an in-progress room. The RLS policy on call_decline_signals only
// permits inserts when the caller is a real participant of the named
// session, so only the actual callee can manifest a decline event. The
// caller's video route subscribes via postgres_changes on the table and
// gets RLS-filtered notifications.
export async function sendCallDeclined(
  _targetUserId: string,
  payload: CallDeclinedPayload,
): Promise<void> {
  void _targetUserId;
  // emit_call_decline is a thin SECURITY INVOKER RPC that wraps the INSERT
  // so we don't need to regenerate supabase types for the new table. The
  // table's RLS policy still applies — RPC is just the call shape.
  await supabase.rpc("emit_call_decline", { p_session_id: payload.sessionId });
}
