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
import { useTheme } from "@/lib/theme-context";
import { querySessionById } from "@/lib/session-queries";
import { sendCallRinging } from "@/lib/call-signals";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { useFeatureEnabled } from "@/lib/feature-flags";
import type { Enums } from "@/integrations/supabase/types";
import { ArrowLeft, MessageCircle, MonitorUp, PhoneOff, VideoOff } from "lucide-react";
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
  const [sharing, setSharing] = useState(false);
  const [showModHint, setShowModHint] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiExternalApiInstance | null>(null);

  const isTeacher = Boolean(session && user && session.teacher_id === user.id);

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
        // real Jitsi URL is always derived from sessionId — meet_link is just
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
  }, [navigate, sessionId, user]);

  const apiRoomName = useMemo(() => {
    if (!session) return "";
    return getApiRoomName(session.id, session.skills?.name);
  }, [session]);

  // Ring the other party once when the caller joins. Skipped if the other
  // party is already in the room (the route will load again when they
  // navigate in, but only the first caller actually issues a ring).
  const ringedRef = useRef(false);
  useEffect(() => {
    if (!session || !user || !viewer || ringedRef.current) return;
    ringedRef.current = true;
    const otherPartyId = session.teacher_id === user.id ? session.learner_id : session.teacher_id;
    void sendCallRinging(otherPartyId, {
      sessionId: session.id,
      callerId: user.id,
      callerName: viewer.displayName,
      skillName: session.skills?.name ?? null,
    }).catch(() => {
      // Realtime not available — silently skip; the other party can still
      // open the call from the dashboard "Join" button.
    });
  }, [session, user, viewer]);

  // Listen for a decline coming back from the other party so the caller
  // doesn't sit indefinitely in an empty Jitsi room.
  //
  // Previously this used Supabase Realtime Broadcast on a per-session
  // channel — broadcast has no sender authentication, so anyone with the
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
    const handleLeft = () => {
      if (cancelled) return;
      recordLeave();
      navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
    };
    const handleScreenShare = (payload: unknown) => {
      const on = Boolean(
        payload && typeof payload === "object" && (payload as { on?: boolean }).on,
      );
      setSharing(on);
    };
    const handleJoined = () => {
      if (cancelled) return;
      setCallReady(true);
      setShowModHint(false);
      if (modHintTimer != null) window.clearTimeout(modHintTimer);
      if (viewer.avatarUrl && api) {
        api.executeCommand("avatarUrl", viewer.avatarUrl);
      }
      // Heartbeat the attendance row every 30s. session_attended_seconds()
      // decays open intervals 90s after the last heartbeat, so missing one
      // is forgiving but a tab that stops heartbeating (closed, crashed,
      // forged-from-console) stops accruing credited time within ~90s.
      stopHeartbeat();
      void supabase.rpc("record_session_heartbeat" as never, { p_session_id: session.id } as never);
      heartbeatTimer = window.setInterval(() => {
        void supabase.rpc("record_session_heartbeat" as never, { p_session_id: session.id } as never);
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
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      toast.error(error instanceof Error ? error.message : "Could not start the video call");
    });

    return () => {
      cancelled = true;
      if (modHintTimer != null) window.clearTimeout(modHintTimer);
      stopHeartbeat();
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
        api?.dispose();
      } catch {
        // ignore — disposed iframe may already be detached
      }
      apiRef.current = null;
      setCallReady(false);
      setSharing(false);
      setShowModHint(false);
    };
  }, [apiRoomName, navigate, session, videoCallsEnabled, viewer]);

  if (authLoading || loading || !session || !viewer) {
    return <PageLoading variant="video" />;
  }

  // Refuse to render the call surface when no authenticated provider is
  // configured. The previous behaviour fell back to public meet.jit.si with
  // a deterministic room name — anyone with that URL could enter the room
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

      <section className="relative min-h-0 flex-1 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-card">
        <div ref={containerRef} className="h-full w-full" />
        {!callReady && (
          // Scrim sits on top of whatever Jitsi has painted into the iframe
          // (often a near-black backdrop), so we tint it with a theme-aware
          // wash and lift the text to foreground/80 instead of muted —
          // muted-foreground washed out against the dark iframe.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-sm font-medium text-foreground/80 backdrop-blur-sm">
            Connecting to your secure SkillSwap room…
          </div>
        )}
      </section>
    </main>
  );
}
