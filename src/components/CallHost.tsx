import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Circle,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionNotesConsentDialogs } from "@/components/SessionNotesRecorder";
import { useCall } from "@/lib/call-context";
import { cn } from "@/lib/utils";

// The one element in the app that holds a live Jitsi iframe.
//
// It is mounted once, above the router outlet, and is NEVER reparented: moving
// an <iframe> in the DOM reloads it, which for a conference means dropping out
// of the room and rejoining. So instead of living inside whichever page wants to
// show it, it is position:fixed and simply re-measures itself against the video
// page's stage rectangle every frame. Leave that page and there is no rectangle
// to track, so it settles into the corner as a mini-player and the call carries
// on while the user reads their notes, opens chat, or goes home.

export function CallHost() {
  const call = useCall();
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { stageEl, sessionId, docked } = call;

  const applyRect = useCallback((host: HTMLDivElement, stage: HTMLElement) => {
    const rect = stage.getBoundingClientRect();
    host.style.top = `${rect.top}px`;
    host.style.left = `${rect.left}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
  }, []);

  // Land on the right rectangle before the browser paints, so anchoring to a
  // freshly-mounted video page never flashes at the docked position.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!stageEl) {
      // Hand positioning back to the docked utility classes.
      host.style.top = "";
      host.style.left = "";
      host.style.width = "";
      host.style.height = "";
      return;
    }
    applyRect(host, stageEl);
  }, [applyRect, stageEl, sessionId]);

  // Keep following it. A rAF loop rather than ResizeObserver + scroll listeners
  // because the stage moves for reasons neither of those reports: a banner
  // appearing above it, the mobile URL bar collapsing, a sidebar animating open.
  // It reads one rect per frame and only touches the DOM when the rect actually
  // changed, and it is only running while a call is on screen.
  useEffect(() => {
    if (!stageEl) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const host = hostRef.current;
      if (!host) return;
      const rect = stageEl.getBoundingClientRect();
      const key = `${rect.top}|${rect.left}|${rect.width}|${rect.height}`;
      if (key === last) return;
      last = key;
      applyRect(host, stageEl);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [applyRect, stageEl]);

  const returnToCall = () => {
    if (!sessionId) return;
    navigate({ to: "/video/$sessionId", params: { sessionId } });
  };

  // Nothing to show until the session behind the call has loaded — otherwise
  // opening the video page would flash an empty mini-player in the corner for
  // the moment before its stage exists. The container still mounts in the same
  // commit that sets `session`, which is the commit the conference effect runs
  // in, so it is always there in time.
  if (!sessionId || !call.session) return null;

  const notesProcessing = call.notes.status === "processing";
  const showConnecting = call.connecting && !call.fatal && !call.leaving && !notesProcessing;
  // A consent dialog is up. The mini-player normally sits above the mobile tab
  // bar and the full-screen mobile chat shell (both z-50) so it stays reachable,
  // but it must not float over a modal it would overlap on a narrow screen.
  // Dropping the layer keeps the conference untouched — hiding the element
  // would risk the browser stalling the iframe's video.
  const modalOpen = call.consent.incoming || call.consent.outgoing !== "idle";

  return (
    <>
      <div
        ref={hostRef}
        role="region"
        aria-label="Video call"
        className={cn(
          "fixed isolate overflow-hidden border border-border/60 bg-card",
          docked
            ? // Stacked above the mobile tab bar (z-50) and the sidebar (z-40),
              // below the heads-up banners that must never be covered (z-98+).
              // The bottom offsets clear the floating Help button, which claims
              // this exact corner (h-12 + a 0.75rem gap = 3.75rem).
              cn(
                "bottom-[calc(9.25rem+env(safe-area-inset-bottom))] right-4 w-[min(19rem,calc(100vw-2rem))] rounded-2xl shadow-2xl md:bottom-[5.25rem] md:right-6",
                modalOpen ? "z-40" : "z-[60]",
              )
            : "z-20 rounded-3xl shadow-card",
        )}
      >
        <div className={cn("relative", docked ? "aspect-video w-full" : "h-full w-full")}>
          {/* The Jitsi iframe's permanent home. Nothing may move this node. */}
          <div
            ref={call.containerRef}
            className={cn("h-full w-full", docked && "pointer-events-none")}
          />

          {/* Docked: the whole tile is a way back into the call. */}
          {docked && !call.fatal && (
            <button
              type="button"
              onClick={returnToCall}
              className="absolute inset-0 z-10 cursor-pointer bg-transparent transition-colors hover:bg-foreground/5"
              aria-label="Return to the call"
            />
          )}

          {docked && !call.fatal && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 bg-gradient-to-b from-black/60 to-transparent px-2.5 py-1.5 text-[11px] font-medium text-white">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className="truncate">
                {call.callReady ? "In call" : "Connecting"}
                {call.peerName ? ` · ${call.peerName}` : ""}
              </span>
              {call.notes.isActive && (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-red-300">
                  <Circle className="h-2 w-2 animate-pulse fill-current" />
                  REC
                </span>
              )}
            </div>
          )}

          {docked && !call.fatal && (
            <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-5">
              <button
                type="button"
                onClick={call.toggleAudio}
                disabled={!call.callReady}
                className="grid h-8 w-8 place-content-center rounded-full bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-40"
                aria-label={call.audioMuted ? "Unmute microphone" : "Mute microphone"}
              >
                {call.audioMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={returnToCall}
                className="grid h-8 w-8 place-content-center rounded-full bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25"
                aria-label="Back to the call screen"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void call.endCall()}
                disabled={call.leaving}
                className="grid h-8 w-8 place-content-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:opacity-60"
                aria-label="Leave the call"
              >
                <PhoneOff className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Terminal failures. Anchored, this is the full explanation with a
              retry; docked, it is a compact card that still offers both ways
              out rather than a frozen thumbnail. */}
          {call.fatal && (
            <div
              className={cn(
                "absolute inset-0 z-30 flex flex-col items-center justify-center bg-background/95 text-center backdrop-blur-sm",
                docked ? "gap-1.5 px-3" : "gap-3 px-6",
              )}
            >
              <div
                className={cn(
                  "flex items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400",
                  docked ? "h-7 w-7" : "h-12 w-12",
                )}
              >
                <TriangleAlert className={docked ? "h-4 w-4" : "h-6 w-6"} />
              </div>
              <p className={cn("max-w-sm font-medium", docked ? "text-[11px]" : "text-sm")}>
                {call.fatal}
              </p>
              {!docked && (
                <p className="max-w-sm text-xs text-muted-foreground">
                  Your session is still on — you can rejoin, or pick this back up from the session
                  page.
                </p>
              )}
              <div
                className={cn("flex flex-wrap justify-center", docked ? "gap-1.5" : "mt-1 gap-2")}
              >
                <Button size="sm" onClick={() => void call.retryJoin()} disabled={call.leaving}>
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void call.dismissFatal()}
                  disabled={call.leaving}
                >
                  <ArrowLeft className="h-4 w-4" />
                  {docked ? "Close" : "Back to session"}
                </Button>
              </div>
            </div>
          )}

          {call.leaving && (
            // The hangup -> readyToClose handshake takes a moment. Say so rather
            // than looking frozen.
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-background/85 px-4 text-center backdrop-blur-sm">
              <Loader2
                className={cn("animate-spin text-brand-purple", docked ? "h-5 w-5" : "h-7 w-7")}
              />
              <p className={cn("font-medium", docked ? "text-[11px]" : "text-sm")}>
                Leaving the call…
              </p>
            </div>
          )}

          {notesProcessing && !call.leaving && (
            // Shown after a stop while the upload + generation finish. The call
            // may already be over; this deliberately stays put until the notes
            // land so the audio is never thrown away.
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/85 px-4 text-center backdrop-blur-sm">
              <Loader2
                className={cn("animate-spin text-brand-purple", docked ? "h-5 w-5" : "h-7 w-7")}
              />
              <p className={cn("font-medium", docked ? "text-[11px]" : "text-sm")}>
                Generating your session notes…
              </p>
              {!docked && (
                <p className="max-w-sm text-xs text-muted-foreground">
                  This usually takes under a minute. The recording is deleted as soon as the notes
                  are ready.
                </p>
              )}
            </div>
          )}

          {showConnecting && (
            // Scrim over Jitsi's near-black loading backdrop, tinted with a
            // theme-aware wash so the text stays readable against it.
            <div
              className={cn(
                "pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 text-center font-medium text-foreground/80 backdrop-blur-sm",
                docked ? "px-2 text-[11px]" : "px-4 text-sm",
              )}
            >
              {docked ? "Connecting…" : "Connecting to your secure SkillSwap room…"}
            </div>
          )}
        </div>
      </div>

      {/* Consent lives with the call, not with the video page: the other side
          can ask to record while this user is off reading their notes, and that
          prompt still has to reach them. */}
      {call.notesEnabled && call.session && (
        <SessionNotesConsentDialogs
          recorder={call.notes}
          consent={call.consent}
          peerName={call.peerName}
        />
      )}
    </>
  );
}
