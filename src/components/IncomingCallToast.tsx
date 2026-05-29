import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { sendCallDeclined, type CallRingingPayload } from "@/lib/call-signals";
import { cn } from "@/lib/utils";

const ANIMATION_MS = 300;
const RING_TIMEOUT_MS = 30000;

// Looping two-tone ring via Web Audio. Plays bursts every ~1.5s until
// stopRing() is called.
let cachedCtx: AudioContext | null = null;
let ringInterval: ReturnType<typeof setInterval> | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!cachedCtx) cachedCtx = new Ctor();
    if (cachedCtx.state === "suspended") void cachedCtx.resume();
    return cachedCtx;
  } catch {
    return null;
  }
}

function playRingBurst() {
  const ctx = ensureCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const tone = (freq: number, offset: number, dur: number, gainPeak = 0.18) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(gainPeak, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + offset + dur);
    osc.start(now + offset);
    osc.stop(now + offset + dur);
  };
  // Classic two-pulse ring: 440 Hz → 480 Hz alternating, two short bursts.
  tone(440, 0, 0.35);
  tone(480, 0.15, 0.4);
}

function startRing() {
  if (ringInterval) return;
  playRingBurst();
  ringInterval = setInterval(playRingBurst, 1500);
}

function stopRing() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
}

export function IncomingCallToast() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [call, setCall] = useState<CallRingingPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the current route so we can suppress the toast when the user is
  // already inside the video room for the ringing session. Without this, when
  // the callee answers and their video page rings the original caller back,
  // the caller — already in the room — sees a spurious "incoming call" popup
  // for the call they themselves started. A ref keeps the latest value
  // readable from inside the broadcast handler's async closure.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const channel = supabase
      .channel(`call-signal-${user.id}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "call_ringing" }, (msg) => {
        // Broadcast channels have no sender authentication — anyone who
        // knows the recipient's user id can publish a fake call_ringing
        // event. Validate the payload against the sessions table before
        // showing the toast: the session must exist, be in a callable
        // state, and have THIS user as a participant with the claimed
        // caller as the counterparty. RLS on `sessions` enforces the
        // participant gate, so a non-participant simply gets no row back.
        const payload = msg.payload as CallRingingPayload;
        if (!payload?.sessionId || !payload?.callerId || typeof payload.callerName !== "string") {
          return;
        }
        void (async () => {
          const { data: session } = await supabase
            .from("sessions")
            .select("id, learner_id, teacher_id, status")
            .eq("id", payload.sessionId)
            .maybeSingle();
          if (cancelled || !session) return;
          const isParticipant = session.learner_id === user.id || session.teacher_id === user.id;
          const counterpartyId =
            session.learner_id === user.id ? session.teacher_id : session.learner_id;
          if (
            !isParticipant ||
            payload.callerId !== counterpartyId ||
            (session.status !== "accepted" && session.status !== "active")
          ) {
            return;
          }
          // Already in this session's video room — don't pop a call toast at
          // ourselves (this is the answerer's ring-back reaching the caller).
          if (pathnameRef.current === `/video/${payload.sessionId}`) return;
          setCall(payload);
          requestAnimationFrame(() => setVisible(true));
        })();
      })
      .subscribe();

    return () => {
      cancelled = true;
      stopRing();
      void supabase.removeChannel(channel);
    };
    // Depend on user.id only — Supabase rotates the user object reference on
    // every onAuthStateChange event (TOKEN_REFRESHED, USER_UPDATED, …) even
    // when the id is unchanged. Using [user] tore down + re-subscribed this
    // realtime channel 2–4 times during auth bootstrap.
  }, [user?.id]);

  // Start ringing whenever a call becomes visible; stop when it goes away.
  useEffect(() => {
    if (call && visible) {
      startRing();
      timeoutRef.current = setTimeout(() => setVisible(false), RING_TIMEOUT_MS);
      return () => {
        stopRing();
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }
    stopRing();
  }, [call, visible]);

  // After slide-out animation, clear the call state.
  useEffect(() => {
    if (visible || !call) return;
    teardownTimerRef.current = setTimeout(() => setCall(null), ANIMATION_MS);
    return () => {
      if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
    };
  }, [visible, call]);

  if (!call) return null;

  const onAnswer = () => {
    setVisible(false);
    navigate({ to: "/video/$sessionId", params: { sessionId: call.sessionId } });
  };

  const onDecline = () => {
    setVisible(false);
    // Best-effort signal the caller — they're in the Jitsi room waiting.
    void sendCallDeclined(call.callerId, { sessionId: call.sessionId });
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[101] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
      aria-live="assertive"
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-sm transform-gpu transition-all ease-out",
          visible ? "translate-y-0 opacity-100 scale-100" : "-translate-y-4 opacity-0 scale-95",
        )}
        style={{ transitionDuration: `${ANIMATION_MS}ms` }}
      >
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-600/95 to-teal-600/95 px-3 py-2 text-white shadow-xl backdrop-blur-md">
          <div className="grid h-7 w-7 shrink-0 animate-pulse place-content-center rounded-full bg-white/15">
            <Video className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1 text-xs leading-tight">
            <div className="truncate font-semibold">{call.callerName}</div>
            <div className="truncate opacity-90">calling…</div>
          </div>
          <button
            type="button"
            onClick={onDecline}
            className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
            aria-label="Decline call"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onAnswer}
            className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-white text-emerald-700 transition-colors hover:bg-white/90"
            aria-label="Answer call"
          >
            <Phone className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
