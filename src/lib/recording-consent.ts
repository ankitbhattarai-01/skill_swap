import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Two-sided consent for AI-notes recording.
//
// The recorder asks the other participant; capture only starts once they
// accept on their own screen. Requests and answers go through the RLS-gated
// recording_consent_signals table (migration 20260724050000), NOT Realtime
// Broadcast — an "accept" starts a recording on the asker's client, so a
// forged accept is the dangerous direction. RLS guarantees only a real
// participant of the session can produce an accept, exactly like the call
// decline signal.

type ConsentKind = "request" | "accept" | "decline";

/** State of the request *I* sent to the other participant. */
export type OutgoingConsent = "idle" | "waiting" | "accepted" | "declined" | "timeout";

// If the peer doesn't answer within this window they're probably not at their
// screen. We surface that instead of spinning forever.
const CONSENT_TIMEOUT_MS = 30_000;

async function emitRecordingConsent(sessionId: string, kind: ConsentKind): Promise<void> {
  const { error } = await supabase.rpc("emit_recording_consent", {
    p_session_id: sessionId,
    p_kind: kind,
  });
  if (error) throw error;
}

export type RecordingConsent = {
  /** State of my outgoing request. */
  outgoing: OutgoingConsent;
  /** True when the peer is asking me and I haven't answered yet. */
  incoming: boolean;
  /** Ask the other participant for permission to record. */
  request: () => void;
  /** Answer an incoming request. */
  accept: () => void;
  decline: () => void;
  /** Drop my outgoing state back to idle (dialog dismissed / recording begun). */
  reset: () => void;
};

/**
 * Drives the ask/accept/decline handshake for one call. Both participants run
 * the same hook: either can be the asker or the responder. Names aren't sent
 * on the wire — with exactly two people in a session, any event that isn't
 * mine came from the peer.
 */
export function useRecordingConsent(input: {
  sessionId: string;
  selfUserId: string | undefined;
}): RecordingConsent {
  const { sessionId, selfUserId } = input;
  const [outgoing, setOutgoing] = useState<OutgoingConsent>("idle");
  const [incoming, setIncoming] = useState(false);

  // The realtime handler is set up once; a ref keeps it reading the live
  // outgoing state so a late accept/decline is only honoured while I'm waiting.
  const outgoingRef = useRef(outgoing);
  outgoingRef.current = outgoing;
  const timeoutRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!selfUserId) return;
    const channel = supabase
      .channel(`recording-consent-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "recording_consent_signals",
          filter: `session_id=eq.${sessionId}`,
        },
        (msg) => {
          const row = msg.new as { from_user_id?: string; kind?: ConsentKind };
          // Ignore my own rows — I hear the echo of everything I insert.
          if (!row || row.from_user_id === selfUserId) return;

          if (row.kind === "request") {
            setIncoming(true);
            return;
          }
          if (row.kind === "accept" && outgoingRef.current === "waiting") {
            clearTimer();
            setOutgoing("accepted");
            return;
          }
          if (row.kind === "decline" && outgoingRef.current === "waiting") {
            clearTimer();
            setOutgoing("declined");
          }
        },
      )
      .subscribe();

    return () => {
      clearTimer();
      void supabase.removeChannel(channel);
    };
  }, [sessionId, selfUserId, clearTimer]);

  const request = useCallback(() => {
    setOutgoing("waiting");
    clearTimer();
    timeoutRef.current = window.setTimeout(() => {
      if (outgoingRef.current === "waiting") setOutgoing("timeout");
    }, CONSENT_TIMEOUT_MS);
    void emitRecordingConsent(sessionId, "request").catch(() => {
      clearTimer();
      setOutgoing("idle");
      toast.error("Could not reach the other participant.");
    });
  }, [sessionId, clearTimer]);

  const accept = useCallback(() => {
    setIncoming(false);
    void emitRecordingConsent(sessionId, "accept").catch(() => {
      toast.error("Could not send your answer.");
    });
  }, [sessionId]);

  const decline = useCallback(() => {
    setIncoming(false);
    void emitRecordingConsent(sessionId, "decline").catch(() => {
      // Best effort — if it doesn't land, the asker just times out.
    });
  }, [sessionId]);

  const reset = useCallback(() => {
    clearTimer();
    setOutgoing("idle");
  }, [clearTimer]);

  return { outgoing, incoming, request, accept, decline, reset };
}
