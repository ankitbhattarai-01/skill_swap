import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  getApiRoomName,
  getJitsiDomain,
  getVideoRoomUrl,
  isJaasMode,
  loadJitsiExternalApi,
  type JitsiExternalApiInstance,
} from "@/lib/jitsi";
import { fetchJitsiToken } from "@/lib/jitsi-token";
import { canJoinSession, describeJoinWindow } from "@/lib/sessions";
import { isUuid } from "@/lib/uuid";
import { useTheme } from "@/lib/theme-context";
import { querySessionById } from "@/lib/session-queries";
import { sendCallRinging } from "@/lib/call-signals";
import { startRingback, stopRingback } from "@/lib/sounds";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { useFeatureEnabled } from "@/lib/feature-flags";
import { useRecordingWatcher } from "@/lib/recording-signal";
import { SessionNotesRecorder } from "@/components/SessionNotesRecorder";
import { useSessionNotesRecorder } from "@/lib/use-session-notes-recorder";
import type { Enums } from "@/integrations/supabase/types";
import {
  ArrowLeft,
  Circle,
  Loader2,
  MessageCircle,
  MonitorUp,
  PhoneOff,
  VideoOff,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/video/$sessionId")({
  head: () => ({ meta: [{ title: "Video Call - SkillSwap" }] }),
  component: VideoCallPage,
});

// Jitsi exposes a single `DEFAULT_BACKGROUND` knob in interfaceConfigOverwrite.
// We map the app theme onto two hex values picked to sit just below the
// surrounding chrome (bg-card) on each palette, so the iframe's loading
// flash and "no participant" tile blend in instead of punching a hole.
const JITSI_BACKGROUND_BY_THEME = {
  light: "#f5f6fa",
  dark: "#0b0f17",
} as const;

type SessionStatus = Enums<"session_status">;

type SessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  status: SessionStatus;
  meet_link: string | null;
  scheduled_at: string | null;
  duration_minutes: number;
  skills: { name: string } | null;
  learnerName: string;
  teacherName: string;
};

type Viewer = {
  displayName: string;
  email?: string;
  avatarUrl?: string;
};

function VideoCallPage() {
  const { sessionId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const videoCallsEnabled = useFeatureEnabled("features.video_calls.enabled", true);
  const { theme } = useTheme();
  // Snapshot the theme at mount via a ref so the Jitsi iframe doesn't
  // reinitialize (and kick the user out of the call) every time they toggle
  // the app theme. Theme changes mid-call take effect on the next rejoin.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [session, setSession] = useState<SessionRow | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [callReady, setCallReady] = useState(false);
  // The scrim only hides Jitsi's initial near-black loading flash. It must
  // lift the moment the iframe paints *any* interactive UI - the prejoin/join
  // controls or the moderator Google login - not wait for `callReady`
  // (videoConferenceJoined), which never fires while the user is still sitting
  // on those pre-join screens, leaving the scrim covering the controls.
  const [connecting, setConnecting] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [showModHint, setShowModHint] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiExternalApiInstance | null>(null);

  const isTeacher = Boolean(session && user && session.teacher_id === user.id);

  const notesEnabled = useFeatureEnabled("features.session_notes.enabled", true);
  const notesRecorder = useSessionNotesRecorder({
    sessionId,
    userId: user?.id,
    displayName: viewer?.displayName ?? "Your session partner",
  });
  // The Jitsi effect below closes over `handleLeft` once; a ref keeps that
  // handler pointed at the current recorder state instead of the state at
  // mount, so ending a call always flushes a recording that is actually live.
  const notesRecorderRef = useRef(notesRecorder);
  notesRecorderRef.current = notesRecorder;

  // Banner for the participant who is NOT recording.
  const peerRecordingName = useRecordingWatcher({ sessionId, selfUserId: user?.id });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: `/video/${sessionId}` } });
    }
  }, [authLoading, navigate, sessionId, user]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const controller = new AbortController();

    const loadVideoSession = async () => {
      // Reject `/video/<garbage>` URLs before hitting PostgREST. An invalid
      // UUID would otherwise bubble up as a 400 the catch block turns into
      // a vague "Could not load video room" toast.
      if (!isUuid(sessionId)) {
        toast.error("That video link looks malformed.");
        navigate({ to: "/dashboard" });
        return;
      }
      setLoading(true);
      try {
        // Go through the shared helper so this route benefits from the same
        // older-schema fallback ladder the dashboard/history/sessions pages
        // use. Without it, a deployment whose schema cache hasn't picked up
        // `initiator_id` / `duration_minutes` would 400 every join attempt.
        const row = await querySessionById({
          sessionId,
          signal: controller.signal,
        });

        if (!alive) return;
        if (!row) {
          toast.error("Session not found");
          navigate({ to: "/dashboard" });
          return;
        }
        if (row.learner_id !== user.id && row.teacher_id !== user.id) {
          toast.error("You do not have access to this video room");
          navigate({ to: "/dashboard" });
          return;
        }

        if (row.status !== "accepted" && row.status !== "active") {
          toast.error("Video opens after the session is accepted");
          navigate({ to: "/sessions/$sessionId", params: { sessionId } });
          return;
        }

        // Enforce the same join window the dashboard uses for the Join button.
        // Without this, anyone with a session URL could open the call hours
        // before the scheduled start or long after it ends (SEC-003).
        if (!canJoinSession(row.scheduled_at, row.duration_minutes)) {
          const hint =
            describeJoinWindow(row.scheduled_at, row.duration_minutes) ??
            "This video room isn't open right now";
          toast.error(hint);
          navigate({ to: "/sessions/$sessionId", params: { sessionId } });
          return;
        }

        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name, avatar_url")
          .in("id", [row.learner_id, row.teacher_id])
          .abortSignal(controller.signal);
        const profiles = new Map((people ?? []).map((p) => [p.id, p]));

        // meet_link is locked at accept time (UPDATE grant revoked). The
        // real Jitsi URL is always derived from sessionId - meet_link is just
        // the internal /video/<id> deep link.
        const roomLink = getVideoRoomUrl({
          link: row.meet_link,
          sessionId: row.id,
          skillName: row.skills?.name,
        });

        if (!alive) return;
        setSession({
          ...row,
          meet_link: roomLink,
          learnerName: profiles.get(row.learner_id)?.full_name ?? "Student",
          teacherName: profiles.get(row.teacher_id)?.full_name ?? "Student",
        });

        const me = profiles.get(user.id);
        const avatarUrl = me?.avatar_url ? await signSingleAvatarUrl(me.avatar_url) : null;
        if (!alive) return;
        setViewer({
          displayName: me?.full_name ?? user.email?.split("@")[0] ?? "SkillSwap user",
          email: user.email ?? undefined,
          avatarUrl: avatarUrl ?? undefined,
        });
      } catch (error) {
        if (!alive) return;
        if (error instanceof Error && error.name === "AbortError") return;
        toast.error(error instanceof Error ? error.message : "Could not load video room");
      } finally {
        if (alive) setLoading(false);
      }
    };

    void loadVideoSession();
    return () => {
      alive = false;
      controller.abort();
    };
    // user?.id only - auth token refreshes rotate the user object reference
    // without changing the user. Depending on `user` re-ran this load, which
    // produced a new `session`/`viewer` object and re-initialized the Jitsi
    // iframe mid-call, kicking the user out of the conference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, sessionId, user?.id]);

  const apiRoomName = useMemo(() => {
    if (!session) return "";
    return getApiRoomName(session.id, session.skills?.name);
  }, [session]);

  // Ring the other party once when we join, and play a ringback ("calling…")
  // tone to ourselves while we wait for them to pick up. The ringback is
  // stopped as soon as another participant is detected in the room (see the
  // Jitsi effect's participant handlers), on decline, on timeout, or unmount -
  // so the answerer, who joins to an already-present caller, hears at most a
  // single burst.
  const ringedRef = useRef(false);
  // Re-arm the ring for a different call: navigating from /video/A straight
  // to /video/B reuses this mounted component, and without the reset the
  // second session would never ring the other party.
  useEffect(() => {
    ringedRef.current = false;
  }, [sessionId]);
  useEffect(() => {
    if (!session || !user || !viewer || ringedRef.current) return;
    ringedRef.current = true;
    const otherPartyId = session.teacher_id === user.id ? session.learner_id : session.teacher_id;
    startRingback();
    // Don't ring out forever if nobody answers.
    const ringbackTimeout = window.setTimeout(stopRingback, 30000);
    void sendCallRinging(otherPartyId, {
      sessionId: session.id,
      callerId: user.id,
      callerName: viewer.displayName,
      skillName: session.skills?.name ?? null,
    }).catch(() => {
      // Realtime not available - silently skip; the other party can still
      // open the call from the dashboard "Join" button.
    });
    return () => {
      window.clearTimeout(ringbackTimeout);
      stopRingback();
    };
  }, [session, user, viewer]);

  // Listen for a decline coming back from the other party so the caller
  // doesn't sit indefinitely in an empty Jitsi room.
  //
  // Previously this used Supabase Realtime Broadcast on a per-session
  // channel - broadcast has no sender authentication, so anyone with the
  // session id could push a fake decline. We now subscribe to
  // postgres_changes on call_decline_signals (RLS-gated to participants),
  // and only act when the inserted row's decliner is the counterparty.
  useEffect(() => {
    if (!session || !user) return;
    const otherId = session.teacher_id === user.id ? session.learner_id : session.teacher_id;
    const channel = supabase
      .channel(`call-decline-table-${session.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_decline_signals",
          filter: `session_id=eq.${session.id}`,
        },
        (msg) => {
          const row = msg.new as { decliner_id?: string };
          if (row?.decliner_id !== otherId) return;
          stopRingback();
          const otherName =
            session.teacher_id === user.id ? session.learnerName : session.teacherName;
          toast.error(`${otherName} declined the call`);
          navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, user, navigate]);

  useEffect(() => {
    if (!session || !viewer || !apiRoomName || !containerRef.current) return;
    if (!videoCallsEnabled) return;

    let cancelled = false;
    let api: JitsiExternalApiInstance | null = null;
    // The moderator-login waiting room only exists on the public meet.jit.si.
    // In JaaS, our backend mints a moderator token, so we never show this hint.
    const modHintTimer = isJaasMode()
      ? null
      : window.setTimeout(() => {
          if (!cancelled) setShowModHint(true);
        }, 10000);

    let leaveRecorded = false;
    let heartbeatTimer: number | null = null;
    const stopHeartbeat = () => {
      if (heartbeatTimer != null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const recordLeave = () => {
      // Idempotent on both sides: server-side RPC closes the most-recent open
      // attendance row; the leaveRecorded flag stops us from firing twice in
      // the common case (Jitsi emits both videoConferenceLeft and readyToClose
      // on a normal hangup).
      if (leaveRecorded) return;
      leaveRecorded = true;
      stopHeartbeat();
      void supabase.rpc("record_session_leave", { p_session_id: session.id });
    };
    const goToSession = () => {
      navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
    };
    const handleLeft = () => {
      if (cancelled) return;
      recordLeave();
      // If a recording is still running when the call ends, hold the user here
      // while we stop, upload, and generate. Navigating immediately would
      // unmount the recorder mid-flight and throw the capture away - the
      // effect cleanup calls cancel(). The overlay below explains the wait.
      if (notesRecorderRef.current.isActive) {
        void notesRecorderRef.current.stopAndGenerate().finally(goToSession);
        return;
      }
      goToSession();
    };
    const handleScreenShare = (payload: unknown) => {
      const on = Boolean(
        payload && typeof payload === "object" && (payload as { on?: boolean }).on,
      );
      setSharing(on);
    };
    // The other party is here - stop ringing out to ourselves.
    const handleParticipantJoined = () => {
      stopRingback();
    };
    const handleJoined = () => {
      if (cancelled) return;
      setCallReady(true);
      setConnecting(false);
      setShowModHint(false);
      // If we joined to an already-occupied room (e.g. we're answering), there
      // won't be a participantJoined event for the person already inside, so
      // silence the ringback up front.
      if (api?.getNumberOfParticipants && api.getNumberOfParticipants() > 1) {
        stopRingback();
      }
      if (modHintTimer != null) window.clearTimeout(modHintTimer);
      if (viewer.avatarUrl && api) {
        api.executeCommand("avatarUrl", viewer.avatarUrl);
      }
      // Heartbeat the attendance row every 30s. session_attended_seconds()
      // decays open intervals 90s after the last heartbeat, so missing one
      // is forgiving but a tab that stops heartbeating (closed, crashed,
      // forged-from-console) stops accruing credited time within ~90s.
      stopHeartbeat();
      void supabase.rpc("record_session_heartbeat", { p_session_id: session.id });
      heartbeatTimer = window.setInterval(() => {
        void supabase.rpc("record_session_heartbeat", { p_session_id: session.id });
      }, 30_000);
    };

    const start = async () => {
      let jwt: string | null = null;
      if (isJaasMode()) {
        try {
          const result = await fetchJitsiToken({
            sessionId: session.id,
          });
          jwt = result.token;
        } catch (error) {
          if (cancelled) return;
          toast.error(
            error instanceof Error
              ? `Could not authorize the call: ${error.message}`
              : "Could not authorize the call",
          );
          return;
        }
      }

      const Ctor = await loadJitsiExternalApi();
      if (cancelled || !containerRef.current) return;

      const options: Record<string, unknown> = Object.create(null);
      Object.assign(options, {
        roomName: apiRoomName,
        parentNode: containerRef.current,
        width: "100%",
        height: "100%",
        userInfo: {
          displayName: viewer.displayName,
          email: viewer.email,
        },
        configOverwrite: {
          prejoinPageEnabled: false,
          disableDeepLinking: true,
          startWithAudioMuted: false,
          startWithVideoMuted: true,
          enableWelcomePage: false,
          enableClosePage: false,
          disableInviteFunctions: true,
          toolbarButtons: [
            "microphone",
            "camera",
            "desktop",
            "chat",
            "raisehand",
            "tileview",
            "participants-pane",
            "settings",
            "fullscreen",
            "hangup",
          ],
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          DEFAULT_REMOTE_DISPLAY_NAME: "SkillSwap participant",
          MOBILE_APP_PROMO: false,
          DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
          DEFAULT_BACKGROUND: JITSI_BACKGROUND_BY_THEME[themeRef.current],
        },
      });
      if (jwt) options.jwt = jwt;
      api = new Ctor(getJitsiDomain(), options);
      apiRef.current = api;
      api.addListener("videoConferenceJoined", handleJoined);
      api.addListener("videoConferenceLeft", handleLeft);
      api.addListener("readyToClose", handleLeft);
      api.addListener("screenSharingStatusChanged", handleScreenShare);
      api.addListener("participantJoined", handleParticipantJoined);
      // Lift the scrim once the iframe has painted its UI (prejoin/join
      // controls, moderator login, or the conference itself), rather than
      // waiting on videoConferenceJoined - otherwise the scrim covers the
      // very controls the user needs to tap to get into the call.
      const iframe = api.getIFrame();
      if (iframe) {
        iframe.addEventListener(
          "load",
          () => {
            if (!cancelled) setConnecting(false);
          },
          { once: true },
        );
      }
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      toast.error(error instanceof Error ? error.message : "Could not start the video call");
    });

    return () => {
      cancelled = true;
      if (modHintTimer != null) window.clearTimeout(modHintTimer);
      stopHeartbeat();
      stopRingback();
      // Safety net for "user navigated away without Jitsi emitting a leave"
      // (browser back button, route change). The 30-min grace clamp in
      // session_attended_seconds() handles the worst case where this also
      // fails to land (tab crash, lost network).
      recordLeave();
      try {
        api?.removeListener("videoConferenceJoined", handleJoined);
        api?.removeListener("videoConferenceLeft", handleLeft);
        api?.removeListener("readyToClose", handleLeft);
        api?.removeListener("screenSharingStatusChanged", handleScreenShare);
        api?.removeListener("participantJoined", handleParticipantJoined);
        api?.dispose();
      } catch {
        // ignore - disposed iframe may already be detached
      }
      apiRef.current = null;
      setCallReady(false);
      setConnecting(true);
      setSharing(false);
      setShowModHint(false);
    };
  }, [apiRoomName, navigate, session, videoCallsEnabled, viewer]);

  if (authLoading || loading || !session || !viewer) {
    return <PageLoading variant="video" />;
  }

  // Refuse to render the call surface when no authenticated provider is
  // configured. The previous behaviour fell back to public meet.jit.si with
  // a deterministic room name - anyone with that URL could enter the room
  // without joining the app. Now we treat "no JaaS" the same as the admin
  // disable flag and route the user back to chat instead.
  if (!videoCallsEnabled || !isJaasMode()) {
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
              <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: session.id }}>
                <ArrowLeft className="h-4 w-4" />
                Back to session
              </Link>
            </Button>
            <Button asChild>
              <Link to="/messages" preload="intent" search={{ s: session.id }}>
                <MessageCircle className="h-4 w-4" />
                Open chat
              </Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const toggleScreenShare = () => {
    apiRef.current?.executeCommand("toggleShareScreen");
  };

  const hangUp = () => {
    apiRef.current?.executeCommand("hangup");
  };

  return (
    <main className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-7xl flex-col px-4 py-[18px] sm:px-[18px] md:py-6">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold sm:text-2xl">
            {session.skills?.name ?? "Skill session"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {session.learnerName} learns from {session.teacherName}
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
            variant={sharing ? "hero" : "outline"}
            onClick={toggleScreenShare}
            disabled={!callReady}
          >
            <MonitorUp className="h-4 w-4" />
            {sharing ? "Stop Sharing" : "Share Screen"}
          </Button>
          {notesEnabled && (
            <SessionNotesRecorder
              recorder={notesRecorder}
              disabled={!callReady}
              sessionId={session.id}
              selfUserId={user?.id}
              peerName={isTeacher ? session.learnerName : session.teacherName}
            />
          )}
          <Button variant="destructive" onClick={hangUp} disabled={!callReady}>
            <PhoneOff className="h-4 w-4" />
            Leave
          </Button>
        </div>
      </div>

      {showModHint && !callReady && (
        <div className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <div className="font-medium">Waiting for the room to start</div>
          <p className="mt-1 text-amber-900/85 dark:text-amber-100/85">
            {isTeacher
              ? "As the teacher, click Log-in inside the call window and sign in with Google to start the room. You only need to do this once per browser."
              : "Waiting for the teacher to start the room. They'll sign in once with Google. You don't need to log in."}
          </p>
        </div>
      )}

      {/* Consent is one-sided by nature: only the recorder ticks the box, but
          the recording captures both voices. This banner is the other half of
          that consent, so nobody is recorded without knowing. */}
      {peerRecordingName && (
        <div className="mb-3 flex items-center gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
          <Circle className="h-3 w-3 shrink-0 animate-pulse fill-current" />
          <span>
            <span className="font-medium">{peerRecordingName} is recording this call</span> to
            generate AI session notes. The recording is deleted once the notes are made.
          </span>
        </div>
      )}

      <section className="relative min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-card">
        <div ref={containerRef} className="h-full w-full" />
        {notesRecorder.status === "processing" && (
          // Shown after hangup while we finish the upload + generation. The
          // route deliberately delays navigation until this resolves.
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/85 px-6 text-center backdrop-blur-sm">
            <Loader2 className="h-7 w-7 animate-spin text-brand-purple" />
            <p className="text-sm font-medium">Generating your session notes…</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              This usually takes under a minute. The recording is deleted as soon as the notes are
              ready.
            </p>
          </div>
        )}
        {connecting && (
          // Scrim sits on top of whatever Jitsi has painted into the iframe
          // (often a near-black backdrop), so we tint it with a theme-aware
          // wash and lift the text to foreground/80 instead of muted -
          // muted-foreground washed out against the dark iframe.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-sm font-medium text-foreground/80 backdrop-blur-sm">
            Connecting to your secure SkillSwap room…
          </div>
        )}
      </section>
    </main>
  );
}
