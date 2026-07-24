import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Live "the other person is recording this call" indicator.
//
// Unlike call declines (which are persisted to call_decline_signals precisely
// because a forged decline could kick someone out of a real call), this uses
// Realtime Broadcast and no DB table. The threat model is the reason: the only
// thing a spoofed message here can do is make someone see a recording warning
// that isn't true. That fails SAFE — it over-warns. The dangerous direction,
// suppressing a warning while recording really happens, is not reachable by
// broadcast at all, because the banner's default state is "off" and only the
// real recorder's own client turns it on.
//
// Broadcast has no retained state, so a participant who joins mid-recording
// would see nothing. The recorder therefore re-announces on an interval and
// late joiners pick the banner up within one heartbeat.

const RECORDING_HEARTBEAT_MS = 5_000;

type RecordingPayload = {
  recording: boolean;
  byUserId: string;
  byName: string;
};

function channelName(sessionId: string) {
  return `session-recording-${sessionId}`;
}

/**
 * Announces that *this* client is recording, re-broadcasting on an interval so
 * anyone who joins mid-call still sees the banner. Returns a stop function
 * that sends a final "recording stopped" message.
 */
export function useRecordingAnnouncer(input: {
  sessionId: string;
  userId: string | undefined;
  displayName: string;
  active: boolean;
}) {
  const { sessionId, userId, displayName, active } = input;

  useEffect(() => {
    if (!active || !userId) return;

    const channel = supabase.channel(channelName(sessionId), {
      config: { broadcast: { self: false } },
    });

    let timer: number | null = null;
    const payload: RecordingPayload = { recording: true, byUserId: userId, byName: displayName };

    const announce = () => {
      void channel.send({ type: "broadcast", event: "recording_state", payload });
    };

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      announce();
      timer = window.setInterval(announce, RECORDING_HEARTBEAT_MS);
    });

    return () => {
      if (timer != null) window.clearInterval(timer);
      // Best-effort "stopped" so the peer's banner clears immediately rather
      // than waiting for the heartbeat to lapse.
      void channel
        .send({
          type: "broadcast",
          event: "recording_state",
          payload: { ...payload, recording: false },
        })
        .finally(() => {
          void supabase.removeChannel(channel);
        });
    };
  }, [active, sessionId, userId, displayName]);
}

/**
 * Watches for the OTHER participant recording. Returns their display name
 * while a recording is live, or null. The banner auto-clears if heartbeats
 * stop arriving (tab crashed, network dropped) rather than sticking forever.
 */
export function useRecordingWatcher(input: {
  sessionId: string;
  selfUserId: string | undefined;
}): string | null {
  const { sessionId, selfUserId } = input;
  const [recorderName, setRecorderName] = useState<string | null>(null);
  const expiryTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!selfUserId) return;

    const clearExpiry = () => {
      if (expiryTimer.current != null) {
        window.clearTimeout(expiryTimer.current);
        expiryTimer.current = null;
      }
    };

    const channel = supabase
      .channel(channelName(sessionId), { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "recording_state" }, (msg) => {
        const payload = msg.payload as RecordingPayload | undefined;
        if (!payload || payload.byUserId === selfUserId) return;

        clearExpiry();
        if (!payload.recording) {
          setRecorderName(null);
          return;
        }
        setRecorderName(payload.byName || "The other participant");
        // Expect another heartbeat within 5s; give it 3x slack before assuming
        // the recorder vanished.
        expiryTimer.current = window.setTimeout(
          () => setRecorderName(null),
          RECORDING_HEARTBEAT_MS * 3,
        );
      })
      .subscribe();

    return () => {
      clearExpiry();
      void supabase.removeChannel(channel);
    };
  }, [sessionId, selfUserId]);

  return recorderName;
}
