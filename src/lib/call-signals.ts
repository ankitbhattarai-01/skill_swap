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

// Decline goes on a per-session channel rather than the caller's user-wide
// channel so the caller's video-route listener doesn't have to share a
// channel name with IncomingCallToast (separate logical purpose).
export async function sendCallDeclined(
  _targetUserId: string,
  payload: CallDeclinedPayload,
): Promise<void> {
  void _targetUserId;
  const channel = supabase.channel(`call-decline-${payload.sessionId}`, {
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
      event: "call_declined",
      payload,
    });
  } finally {
    void supabase.removeChannel(channel);
  }
}
