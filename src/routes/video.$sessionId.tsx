import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  requestHangUp,
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
  RefreshCw,
  TriangleAlert,
  VideoOff,
  WifiOff,
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

// A join that hasn't landed by now is stuck on something the user can't see
// (rejected token, blocked websocket, room that never starts). Lift the scrim
// and offer retry/back rather than leaving them under "Connecting…" forever.
const JOIN_SLOW_MS = 15000;
// videoConferenceLeft also precedes a deliberate hangup by a few milliseconds,
// so hold the "Reconnecting" banner briefly instead of flashing it on exit.
const RECONNECT_BANNER_DELAY_MS = 1200;
// How long Jitsi gets to find its way back before we call the call dead.
const RECONNECT_GIVE_UP_MS = 45000;
// Ceiling on how long an exit waits for a recording to be flushed into notes.
// Generation normally lands inside a minute; the cap exists so a wedged upload
// can't hold the user on this route indefinitely. Generation continues
// server-side either way, so the notes still show up on the session page.
const NOTES_FLUSH_MAX_MS = 120000;

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
  // Nothing has joined after JOIN_SLOW_MS. Surfaces the retry/back affordances
  // that used to be missing entirely on a silently-rejected join.
  const [joinSlow, setJoinSlow] = useState(false);
  // Jitsi lost the conference and is trying to get back in. Explicitly NOT a
  // reason to navigate: this route used to treat every drop as a hangup.
  const [reconnecting, setReconnecting] = useState(false);
  // Unrecoverable and terminal: token mint refused, JWT rejected, kicked,
  // browser unsupported, device suspended. Always rendered with a way out.
  const [fatal, setFatal] = useState<string | null>(null);
  // True while we hang up gracefully, so the moment between the click and the
  // navigation is explained instead of looking like a dead button.
  const [leaving, setLeaving] = useState(false);
  // Bumped by "Try again" to tear down and re-run the join from scratch.
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiExternalApiInstance | null>(null);

  const isTeacher = Boolean(session && user && session.teacher_id === user.id);

  const notesEnabled = useFeatureEnabled("features.session_notes.enabled", true);
  // Banner for the participant who is NOT recording. Also arms the companion
  // capture: the recorder hook treats the banner as proof the initiator's
  // recording really started.
  const peerRecordingName = useRecordingWatcher({ sessionId, selfUserId: user?.id });
  const notesRecorder = useSessionNotesRecorder({
    sessionId,
    userId: user?.id,
    displayName: viewer?.displayName ?? "Your session partner",
    peerRecordingName,
  });
  // The exit path closes over the recorder once; a ref keeps it pointed at the
  // current recorder state instead of the state at mount, so ending a call
  // always flushes a recording that is actually live.
  const notesRecorderRef = useRef(notesRecorder);
  notesRecorderRef.current = notesRecorder;

  // ── Leaving the conference ────────────────────────────────────────────────
  //
  // Jitsi's contract is hangup -> readyToClose -> dispose, and it has to run
  // while the iframe is still in the document. The old teardown was a single
  // `api.dispose()` in a passive effect cleanup, which React runs *after* it has
  // already detached the container - so the client never got to announce its
  // departure, the bridge held our endpoint until its own ping timeout, and a
  // rejoin inside that window sat next to the stale endpoint ("A, A, B").
  //
  // Everything below funnels every exit through leaveGracefully() first.

  // The in-flight (or completed) teardown for this join attempt. Doubles as the
  // idempotency guard: a second exit trigger awaits the same promise.
  const teardownRef = useRef<Promise<void> | null>(null);
  // Set before we ask for a hangup so the videoConferenceLeft that follows is
  // read as "we meant that" rather than as a dropped connection.
  const intentionalLeaveRef = useRef(false);
  // Non-null once a teardown is under way, so the readyToClose handler doesn't
  // hijack a navigation that is already heading somewhere else - or send us to
  // the session page when the teardown was only the first half of a retry.
  const exitReasonRef = useRef<"navigating" | "hangup" | "retrying" | null>(null);

  const disposeInstance = useCallback((api: JitsiExternalApiInstance) => {
    // Only clear the ref if it still points at the instance being disposed -
    // a retry may already have put a fresh one there.
    if (apiRef.current === api) apiRef.current = null;
    try {
      api.dispose();
    } catch {
      // Already disposed, or the iframe was detached out from under us.
    }
  }, []);

  const disposeApi = useCallback(() => {
    const api = apiRef.current;
    if (api) disposeInstance(api);
  }, [disposeInstance]);

  const leaveGracefully = useCallback(
    (options?: { silent?: boolean }) => {
      if (teardownRef.current) return teardownRef.current;
      const api = apiRef.current;
      if (!api) return Promise.resolve();
      // Hand ownership of the instance to this teardown up front so nothing
      // else - a later cleanup, a retry's fresh instance - can be disposed by
      // the callback below.
      apiRef.current = null;
      intentionalLeaveRef.current = true;
      if (!options?.silent) setLeaving(true);
      const run = requestHangUp(api).finally(() => {
        disposeInstance(api);
        setLeaving(false);
      });
      teardownRef.current = run;
      return run;
    },
    [disposeInstance],
  );

  // Hold any navigation off this route - our own, a Details/Chat link, or the
  // browser back button - until the conference has actually been left. This is
  // what makes every exit path graceful instead of only the Leave button, and
  // it keeps working for exit paths added later.
  //
  // enableBeforeUnload stays off on purpose: it would put a native "Leave
  // site?" confirm in front of every reload. The pagehide handler below covers
  // that case as far as it can be covered.
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async () => {
      exitReasonRef.current ??= "navigating";
      await leaveGracefully();
      if (notesRecorderRef.current.isActive) {
        // Stopping the capture has to finish before the recorder unmounts - its
        // cleanup cancels the recording and throws the audio away. The
        // "Generating your session notes…" overlay explains the wait, and the
        // cap keeps a stalled upload from becoming a trap of its own.
        await Promise.race([
          notesRecorderRef.current.stopAndGenerate().catch(() => {}),
          new Promise((resolve) => window.setTimeout(resolve, NOTES_FLUSH_MAX_MS)),
        ]);
      }
      if (notesRecorderRef.current.companionActive) {
        // Same reasoning for the silent companion leg: upload it before the
        // unmount cleanup would discard it. This is just a stop + upload, so
        // it's quick, but it still gets the same cap.
        await Promise.race([
          notesRecorderRef.current.flushCompanion().catch(() => {}),
          new Promise((resolve) => window.setTimeout(resolve, NOTES_FLUSH_MAX_MS)),
        ]);
      }
      return false;
    },
  });

  // Last-ditch teardown for unmounts the blocker never sees (an ignoreBlocker
  // navigation, a parent dropping the route, hot reload). This MUST be a layout
  // effect: passive cleanups run after React has detached the container, and a
  // hangup posted into a detached iframe goes nowhere.
  useLayoutEffect(() => {
    return () => {
      const api = apiRef.current;
      if (!api) return;
      apiRef.current = null;
      try {
        api.executeCommand("hangup");
        api.dispose();
      } catch {
        // Nothing left to hang up.
      }
    };
  }, []);

  // Tab close and reload never give us an awaitable cleanup, so this is purely
  // best effort: post the hangup while the iframe is still alive and let the
  // browser tear down the rest.
  useEffect(() => {
    const onPageHide = () => {
      try {
        apiRef.current?.executeCommand("hangup");
      } catch {
        // Already gone.
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const goToSession = useCallback(() => {
    navigate({ to: "/sessions/$sessionId", params: { sessionId } });
  }, [navigate, sessionId]);

  const retryJoin = useCallback(async () => {
    // Claim the teardown as a retry first: the hangup below emits readyToClose,
    // and that handler would otherwise read it as a hangup and navigate us off
    // the route instead of rejoining.
    exitReasonRef.current = "retrying";
    setConnecting(true);
    setFatal(null);
    setJoinSlow(false);
    setReconnecting(false);
    // Leave the old attempt properly before rejoining, or the retry itself is
    // what leaves a ghost of us in the room.
    await leaveGracefully({ silent: true });
    // The join effect resets these for the new attempt too; doing it here keeps
    // the window between the two from looking like a live call.
    teardownRef.current = null;
    intentionalLeaveRef.current = false;
    setCallReady(false);
    setSharing(false);
    setAttempt((n) => n + 1);
  }, [leaveGracefully]);

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
  // True only while our outgoing ring is still unanswered. A decline is only
  // meaningful in that window - see the decline subscription below.
  const ringingRef = useRef(false);
  // Sticky for the lifetime of this call: once anybody has been in the room
  // with us, no decline signal may end the call.
  const hasRemoteRef = useRef(false);
  const markRemotePresent = useCallback(() => {
    hasRemoteRef.current = true;
    ringingRef.current = false;
    stopRingback();
  }, []);
  // Re-arm the ring for a different call: navigating from /video/A straight
  // to /video/B reuses this mounted component, and without the reset the
  // second session would never ring the other party.
  useEffect(() => {
    ringedRef.current = false;
    ringingRef.current = false;
    hasRemoteRef.current = false;
  }, [sessionId]);
  useEffect(() => {
    if (!session || !user || !viewer || ringedRef.current) return;
    ringedRef.current = true;
    const otherPartyId = session.teacher_id === user.id ? session.learner_id : session.teacher_id;
    ringingRef.current = true;
    startRingback();
    // Don't ring out forever if nobody answers.
    const ringbackTimeout = window.setTimeout(() => {
      ringingRef.current = false;
      stopRingback();
    }, 30000);
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
      ringingRef.current = false;
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
  //
  // Being the counterparty is not enough on its own, though. The row carries no
  // correlation to a particular ring, so *any* later decline the other person
  // taps - most easily the incoming-call toast our own rejoin raises at them -
  // used to eject us from a call that was very much live. A decline is now only
  // honoured while it can actually be an answer to our ring: still ringing out,
  // and nobody has ever been in the room with us.
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
          if (!ringingRef.current || hasRemoteRef.current) return;
          ringingRef.current = false;
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

    // Fresh attempt: forget any teardown recorded against the previous one.
    teardownRef.current = null;
    intentionalLeaveRef.current = false;
    exitReasonRef.current = null;

    const joinSlowTimer = window.setTimeout(() => {
      if (cancelled) return;
      // Whatever Jitsi has painted is more useful than our scrim by now, and
      // the banner this unlocks carries the retry/back escape hatch.
      setConnecting(false);
      setJoinSlow(true);
    }, JOIN_SLOW_MS);

    let reconnectBannerTimer: number | null = null;
    let reconnectGiveUpTimer: number | null = null;
    const clearReconnectTimers = () => {
      if (reconnectBannerTimer != null) window.clearTimeout(reconnectBannerTimer);
      if (reconnectGiveUpTimer != null) window.clearTimeout(reconnectGiveUpTimer);
      reconnectBannerTimer = null;
      reconnectGiveUpTimer = null;
    };

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
      // attendance row; the leaveRecorded flag stops us from firing twice when
      // several exit signals arrive for the same departure.
      //
      // Only ever called for a departure we believe is final. A transient drop
      // must not close the row: record_session_heartbeat only touches an
      // already-open row, so a closed one silently stops crediting the rest of
      // the call even after Jitsi gets back in.
      if (leaveRecorded) return;
      leaveRecorded = true;
      stopHeartbeat();
      void supabase.rpc("record_session_leave", { p_session_id: session.id });
    };
    const handleScreenShare = (payload: unknown) => {
      const on = Boolean(
        payload && typeof payload === "object" && (payload as { on?: boolean }).on,
      );
      setSharing(on);
    };
    // The other party is here - stop ringing out to ourselves, and lock out any
    // decline signal from ending the call from here on.
    const handleParticipantJoined = () => {
      markRemotePresent();
    };
    // videoConferenceLeft is NOT an exit signal. Jitsi emits it on connection
    // failure, on kicks and on its own recovery paths as well as on a real
    // hangup, and the route used to navigate away on all of them - so a
    // three-second network blip threw the user out of the room. The deliberate
    // exit is driven by readyToClose (and by the navigation blocker) instead.
    const handleConferenceLeft = () => {
      if (cancelled) return;
      setCallReady(false);
      setSharing(false);
      if (intentionalLeaveRef.current || exitReasonRef.current) return;
      clearReconnectTimers();
      reconnectBannerTimer = window.setTimeout(() => {
        if (!cancelled) setReconnecting(true);
      }, RECONNECT_BANNER_DELAY_MS);
      reconnectGiveUpTimer = window.setTimeout(() => {
        if (cancelled) return;
        setReconnecting(false);
        setConnecting(false);
        setFatal("Lost connection to the room. Check your network, then rejoin.");
        recordLeave();
      }, RECONNECT_GIVE_UP_MS);
    };
    // The only event that means "the client has finished leaving and the iframe
    // is safe to destroy". Reached either from our own hangup or from Jitsi's
    // toolbar hangup button.
    const handleReadyToClose = () => {
      disposeApi();
      // A navigation is already in flight (Leave button, a link, back button):
      // it owns where we end up, so don't redirect it to the session page.
      if (exitReasonRef.current) return;
      exitReasonRef.current = "hangup";
      clearReconnectTimers();
      recordLeave();
      goToSession();
    };
    const handleFatal = (message: string) => {
      if (cancelled) return;
      clearReconnectTimers();
      window.clearTimeout(joinSlowTimer);
      setReconnecting(false);
      setConnecting(false);
      setJoinSlow(false);
      setCallReady(false);
      setFatal(message);
      recordLeave();
    };
    // Without these, a rejected JWT (bad kid, room-claim mismatch, expiry) meant
    // videoConferenceJoined never fired, callReady stayed false, and every
    // control stayed disabled with no explanation and no way out.
    const handleErrorOccurred = (payload: unknown) => {
      const error = (payload as { error?: { message?: string; isFatal?: boolean } } | null)?.error;
      if (!error?.isFatal) return;
      handleFatal(
        error.message
          ? `The call ended with an error: ${error.message}`
          : "The call ended with an error.",
      );
    };
    const handleParticipantKicked = (payload: unknown) => {
      const kicked = (payload as { kicked?: { local?: boolean } } | null)?.kicked;
      if (!kicked?.local) return;
      handleFatal("You were removed from this call.");
    };
    const handleSuspendDetected = () => {
      handleFatal("This device went to sleep and the call dropped. Rejoin to continue.");
    };
    const handleBrowserSupport = (payload: unknown) => {
      const supported = (payload as { supported?: boolean } | null)?.supported;
      if (supported !== false) return;
      handleFatal("This browser can't run SkillSwap video calls. Try Chrome, Edge, or Safari.");
    };
    const handlePasswordRequired = () => {
      handleFatal("The room wouldn't accept this join. Go back and open the call again.");
    };
    const handleJoined = () => {
      if (cancelled) return;
      window.clearTimeout(joinSlowTimer);
      clearReconnectTimers();
      setCallReady(true);
      setConnecting(false);
      setJoinSlow(false);
      // Reached on a recovered drop as well as a first join, so this is where
      // the reconnect banner and the give-up state get cleared.
      setReconnecting(false);
      setFatal(null);
      // If we joined to an already-occupied room (e.g. we're answering), there
      // won't be a participantJoined event for the person already inside, so
      // silence the ringback up front.
      if (api?.getNumberOfParticipants && api.getNumberOfParticipants() > 1) {
        markRemotePresent();
      }
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
          // Used to toast and return, leaving the user under "Connecting to your
          // secure SkillSwap room…" forever with no retry and no way back.
          handleFatal(
            error instanceof Error
              ? `Could not authorize the call: ${error.message}`
              : "Could not authorize the call.",
          );
          return;
        }
      }

      const Ctor = await loadJitsiExternalApi();
      if (cancelled || !containerRef.current) return;

      // Never build a second client on top of a first one. dispose() normally
      // removes the iframe it created, but it is best-effort by design here -
      // it is wrapped in try/catch, and a teardown that raced a detach can
      // leave the old iframe sitting in this container. That iframe is still a
      // full conference endpoint: still holding the microphone, still playing
      // the room out of the speakers. Two endpoints on one machine means this
      // device's mic hears its own speakers, and every "hello" loops back
      // through the room until it decays - which is exactly the repeat.
      // The container holds no React children, so clearing it is safe.
      containerRef.current.replaceChildren();

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
          // Audio processing, pinned on explicitly rather than left to whatever
          // the tenant's server-side config.js happens to say. These are the
          // knobs that decide whether the remote voice coming out of this
          // device's speakers is scrubbed back out of its microphone; with them
          // off, two people in the same room hear each other's echo build into
          // a howl. Jitsi defaults them the way we want, but the defaults live
          // on the provider's side and we don't control that file.
          disableAP: false, // master switch - off means none of the below run
          disableAEC: false, // acoustic echo cancellation
          disableNS: false, // noise suppression (fans, keyboards, room hiss)
          disableAGC: false, // auto gain
          disableHPF: false, // high-pass filter, kills low-end rumble
          // stereo: true makes Jitsi request the mic with echoCancellation,
          // noiseSuppression AND autoGainControl all forced off - it is the one
          // setting that silently undoes everything above.
          audioQuality: { stereo: false },
          enableNoisyMicDetection: true,
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
      api.addListener("videoConferenceLeft", handleConferenceLeft);
      api.addListener("readyToClose", handleReadyToClose);
      api.addListener("screenSharingStatusChanged", handleScreenShare);
      api.addListener("participantJoined", handleParticipantJoined);
      api.addListener("errorOccurred", handleErrorOccurred);
      api.addListener("participantKicked", handleParticipantKicked);
      api.addListener("suspendDetected", handleSuspendDetected);
      api.addListener("browserSupport", handleBrowserSupport);
      api.addListener("passwordRequired", handlePasswordRequired);
      // Lift the scrim once the iframe has painted its UI (prejoin/join
      // controls, moderator login, or the conference itself), rather than
      // waiting on videoConferenceJoined - otherwise the scrim covers the
      // very controls the user needs to tap to get into the call.
      // getIFrame() returning null used to strand the scrim until a successful
      // join; joinSlowTimer is the backstop for that.
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
      handleFatal(error instanceof Error ? error.message : "Could not start the video call.");
    });

    return () => {
      cancelled = true;
      window.clearTimeout(joinSlowTimer);
      clearReconnectTimers();
      stopHeartbeat();
      stopRingback();
      // Safety net for "user navigated away without Jitsi emitting a leave"
      // (browser back button, route change). The 30-min grace clamp in
      // session_attended_seconds() handles the worst case where this also
      // fails to land (tab crash, lost network).
      recordLeave();
      try {
        api?.removeListener("videoConferenceJoined", handleJoined);
        api?.removeListener("videoConferenceLeft", handleConferenceLeft);
        api?.removeListener("readyToClose", handleReadyToClose);
        api?.removeListener("screenSharingStatusChanged", handleScreenShare);
        api?.removeListener("participantJoined", handleParticipantJoined);
        api?.removeListener("errorOccurred", handleErrorOccurred);
        api?.removeListener("participantKicked", handleParticipantKicked);
        api?.removeListener("suspendDetected", handleSuspendDetected);
        api?.removeListener("browserSupport", handleBrowserSupport);
        api?.removeListener("passwordRequired", handlePasswordRequired);
      } catch {
        // ignore - disposed iframe may already be detached
      }
      // No-op when the exit path already hung up and disposed, which is the
      // path every navigation off this route now takes.
      disposeApi();
      setCallReady(false);
      setConnecting(true);
      setSharing(false);
    };
  }, [
    apiRoomName,
    attempt,
    disposeApi,
    goToSession,
    markRemotePresent,
    session,
    videoCallsEnabled,
    viewer,
  ]);

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

  // Just navigate: the blocker hangs up, waits for the client to finish, and
  // disposes the iframe before this is allowed to commit. That keeps Leave
  // working even when we never got into the conference, which is exactly when
  // the user most needs a way out.
  const hangUp = () => {
    goToSession();
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
          <Button variant="destructive" onClick={hangUp} disabled={leaving}>
            <PhoneOff className="h-4 w-4" />
            {leaving ? "Leaving…" : "Leave"}
          </Button>
        </div>
      </div>

      {/* Jitsi dropped the conference and is trying to get back in. The call is
          not over: the route deliberately stays put instead of navigating on
          videoConferenceLeft, which also fires on blips. */}
      {reconnecting && !fatal && (
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
      {joinSlow && !callReady && !fatal && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <span className="min-w-0 flex-1">
            <span className="font-medium">This is taking longer than usual.</span> The room hasn’t
            let us in yet. You can retry the connection or come back to it from the session page.
          </span>
          <Button size="sm" variant="outline" onClick={() => void retryJoin()} disabled={leaving}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
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
        {/* Terminal failures used to leave the user under the scrim with every
            control disabled and no way out but a link that abandoned the room. */}
        {fatal && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/90 px-6 text-center backdrop-blur-sm">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <TriangleAlert className="h-6 w-6" />
            </div>
            <p className="max-w-sm text-sm font-medium">{fatal}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Your session is still on — you can rejoin, or pick this back up from the session page.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => void retryJoin()} disabled={leaving}>
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                  <ArrowLeft className="h-4 w-4" />
                  Back to session
                </Link>
              </Button>
            </div>
          </div>
        )}
        {leaving && (
          // The hangup -> readyToClose handshake takes a moment, and every exit
          // now waits for it. Say so rather than looking frozen.
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/85 px-6 text-center backdrop-blur-sm">
            <Loader2 className="h-7 w-7 animate-spin text-brand-purple" />
            <p className="text-sm font-medium">Leaving the call…</p>
          </div>
        )}
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
