import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { isJaasMode } from "@/lib/jitsi";
import { useFeatureEnabled } from "@/lib/feature-flags";
import { useCall } from "@/lib/call-context";
import { SessionNotesControls } from "@/components/SessionNotesRecorder";
import {
  ArrowLeft,
  Circle,
  MessageCircle,
  MonitorUp,
  PhoneOff,
  PictureInPicture2,
  RefreshCw,
  VideoOff,
  WifiOff,
} from "lucide-react";

export const Route = createFileRoute("/video/$sessionId")({
  head: () => ({ meta: [{ title: "Video Call - SkillSwap" }] }),
  component: VideoCallPage,
});

// This page no longer owns the call — CallProvider does, above the router.
//
// It used to hold the Jitsi client itself, with a navigation blocker that hung
// up on every exit: the Details link, the Chat link, the back button, a tap on
// Home. Opening the session page to read the AI notes you had just made ended
// the call you made them in.
//
// All this route does now is claim the call for its session and hand the
// persistent host a rectangle to sit in. Navigate away and the host keeps the
// conference alive in a corner instead of tearing it down.
function VideoCallPage() {
  const { sessionId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const videoCallsEnabled = useFeatureEnabled("features.video_calls.enabled", true);
  const call = useCall();
  const { startCall, attachStage } = call;

  // Refuse to render the call surface when no authenticated provider is
  // configured. The previous behaviour fell back to public meet.jit.si with a
  // deterministic room name — anyone with that URL could enter the room without
  // joining the app. "No JaaS" is treated the same as the admin disable flag.
  const available = videoCallsEnabled && isJaasMode();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: `/video/${sessionId}` } });
    }
  }, [authLoading, navigate, sessionId, user]);

  useEffect(() => {
    if (!user || !available) return;
    // Idempotent: returning to this page mid-call re-anchors the existing
    // conference rather than rejoining it.
    startCall(sessionId);
  }, [available, sessionId, startCall, user]);

  if (!available) {
    const adminDisabled = !videoCallsEnabled;
    return (
      <main className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col items-center justify-center px-4 py-10">
        <div className="glass flex w-full flex-col items-center rounded-3xl p-8 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <VideoOff className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold">
            {adminDisabled
              ? "Video calls are temporarily disabled"
              : "Video calls are not configured"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {adminDisabled
              ? "An administrator has disabled in-app video calling. You can still chat and reschedule from the session page."
              : "This deployment does not have a video provider configured. You can still chat and reschedule from the session page."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId }}>
                <ArrowLeft className="h-4 w-4" />
                Back to session
              </Link>
            </Button>
            <Button asChild>
              <Link to="/messages" preload="intent" search={{ s: sessionId }}>
                <MessageCircle className="h-4 w-4" />
                Open chat
              </Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const session = call.sessionId === sessionId ? call.session : null;
  if (authLoading || !session) {
    return <PageLoading variant="video" />;
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-7xl flex-col px-4 py-[18px] sm:px-[18px] md:py-6">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold sm:text-2xl">
            {session.skillName ?? "Skill session"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {session.learnerName} learns from {session.teacherName}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <PictureInPicture2 className="h-3.5 w-3.5 shrink-0" />
            Open another page any time — the call keeps running in the corner.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: session.id }}>
              <ArrowLeft className="h-4 w-4" />
              Details
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/messages" preload="intent" search={{ s: session.id }}>
              <MessageCircle className="h-4 w-4" />
              Chat
            </Link>
          </Button>
          <Button
            variant={call.sharing ? "hero" : "outline"}
            onClick={call.toggleScreenShare}
            disabled={!call.callReady}
          >
            <MonitorUp className="h-4 w-4" />
            {call.sharing ? "Stop Sharing" : "Share Screen"}
          </Button>
          {call.notesEnabled && (
            <SessionNotesControls
              recorder={call.notes}
              consent={call.consent}
              disabled={!call.callReady}
            />
          )}
          <Button variant="destructive" onClick={() => void call.endCall()} disabled={call.leaving}>
            <PhoneOff className="h-4 w-4" />
            {call.leaving ? "Leaving…" : "Leave"}
          </Button>
        </div>
      </div>

      {/* Jitsi dropped the conference and is trying to get back in. The call is
          not over: the provider deliberately stays put instead of ending on
          videoConferenceLeft, which also fires on blips. */}
      {call.reconnecting && !call.fatal && (
        <div className="mb-3 flex items-center gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">Connection dropped — trying to get back in.</span> Stay on
            this page; the call resumes on its own once the network recovers.
          </span>
        </div>
      )}

      {/* The join never landed. Whatever the cause (rejected token, blocked
          websocket, a room that never starts), this is the "why am I waiting"
          affordance, and it carries the escape hatches. */}
      {call.joinSlow && !call.callReady && !call.fatal && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <span className="min-w-0 flex-1">
            <span className="font-medium">This is taking longer than usual.</span> The room hasn’t
            let us in yet. You can retry the connection or come back to it from the session page.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void call.retryJoin()}
            disabled={call.leaving}
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      )}

      {/* Consent is one-sided by nature: only the recorder ticks the box, but
          the recording captures both voices. This banner is the other half of
          that consent, so nobody is recorded without knowing. */}
      {call.notes.peerRecordingName && (
        <div className="mb-3 flex items-center gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
          <Circle className="h-3 w-3 shrink-0 animate-pulse fill-current" />
          <span>
            <span className="font-medium">
              {call.notes.peerRecordingName} is recording this call
            </span>{" "}
            to generate AI session notes. The recording is deleted once the notes are made.
          </span>
        </div>
      )}

      {/* The stage. Deliberately empty: CallHost paints the live iframe over
          this rectangle and follows it, because reparenting the iframe into a
          page would reload it — which is to say, leave and rejoin the room. */}
      <section
        ref={attachStage}
        className="min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-card"
        aria-label="Video call stage"
      />
    </main>
  );
}
