import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Live "the other person is recording this call" indicator, and the thing that
// arms the peer's companion capture for dual-sided AI notes.
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
//
// ONE CHANNEL, BOTH DIRECTIONS. This used to be two hooks — an announcer and a
// watcher — each calling supabase.channel() with the SAME topic. supabase-js
// hands back the *existing* channel for a topic it already has, and calling
// .subscribe() on a channel that is already joined is a silent no-op: the
// status callback never fires. The announcer's heartbeat was started inside
// that callback, so on the recorder's own client (which always has the watcher
// subscribed first) the announcement was never sent at all. Nobody ever saw the
// banner, the peer's companion capture was never armed, and its leg was
// discarded 45s later — which is why AI notes only ever contained the voice of
// whoever pressed record. Send and receive share one channel now, so there is
// no second subscribe to swallow.

const RECORDING_HEARTBEAT_MS = 5_000;
const RECORDING_EVENT = "recording_state";

type RecordingPayload = {
  recording: boolean;
  byUserId: string;
  byName: string;
};

function channelName(sessionId: string) {
  return `session-recording-${sessionId}`;
}

/**
 * Announces that *this* client is recording while `active` is true, and returns
 * the OTHER participant's display name while THEY are recording (or null).
 *
 * The banner auto-clears if heartbeats stop arriving (tab crashed, network
 * dropped) rather than sticking forever.
 */
export function useRecordingSignal(input: {
  sessionId: string;
  userId: string | undefined;
  displayName: string;
  active: boolean;
}): string | null {
  const { sessionId, userId, displayName, active } = input;
  const [recorderName, setRecorderName] = useState<string | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const subscribedRef = useRef(false);
  const expiryTimer = useRef<number | null>(null);
  // Read at announce time so a display name that resolves late doesn't tear the
  // heartbeat down and re-announce (which reads as a stop-then-start peer-side).
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;
  // Lets the subscribe callback fire the first announcement the moment the
  // channel is ready, for the case where recording started before it joined.
  const announceRef = useRef<() => void>(() => {});

  // Declared BEFORE the subscription effect on purpose: React runs cleanups in
  // declaration order, so on unmount the final "recording stopped" message is
  // sent while the channel is still alive, not after it has been removed.
  useEffect(() => {
    if (!active || !userId) return;

    const send = (recording: boolean) => {
      const channel = channelRef.current;
      if (!channel || !subscribedRef.current) return;
      void channel.send({
        type: "broadcast",
        event: RECORDING_EVENT,
        payload: {
          recording,
          byUserId: userId,
          byName: displayNameRef.current,
        } satisfies RecordingPayload,
      });
    };

    announceRef.current = () => send(true);
    // A tick that lands before the channel joins is dropped; the next heartbeat
    // covers it, as does the subscribe callback.
    send(true);
    const timer = window.setInterval(() => send(true), RECORDING_HEARTBEAT_MS);

    return () => {
      window.clearInterval(timer);
      announceRef.current = () => {};
      // Best-effort "stopped" so the peer's banner clears immediately rather
      // than waiting for the heartbeat to lapse. The peer's companion capture
      // stops and uploads its leg off the back of this, so it matters.
      send(false);
    };
  }, [active, userId]);

  useEffect(() => {
    // The hook is held by the app-wide call provider, so it is mounted with an
    // empty sessionId whenever no call is up. Nothing to listen to then.
    if (!userId || !sessionId) return;

    const clearExpiry = () => {
      if (expiryTimer.current != null) {
        window.clearTimeout(expiryTimer.current);
        expiryTimer.current = null;
      }
    };

    const channel = supabase
      .channel(channelName(sessionId), { config: { broadcast: { self: false } } })
      .on("broadcast", { event: RECORDING_EVENT }, (msg) => {
        const payload = msg.payload as RecordingPayload | undefined;
        if (!payload || payload.byUserId === userId) return;

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
      });

    channelRef.current = channel;
    subscribedRef.current = false;
    channel.subscribe((status) => {
      subscribedRef.current = status === "SUBSCRIBED";
      // Recording may already be running by the time the join completes.
      if (subscribedRef.current) announceRef.current();
    });
    // Defensive: supabase-js returns the EXISTING channel for a topic it
    // already holds, and .subscribe() on one that is already joined never
    // invokes the callback. That is the exact failure this hook was written to
    // end, so if it somehow recurs, go on announcing rather than going mute.
    if (channel.state === "joined") {
      subscribedRef.current = true;
      announceRef.current();
    }

    return () => {
      clearExpiry();
      channelRef.current = null;
      subscribedRef.current = false;
      setRecorderName(null);
      void supabase.removeChannel(channel);
    };
  }, [sessionId, userId]);

  return recorderName;
}
