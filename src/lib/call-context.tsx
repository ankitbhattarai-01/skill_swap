import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useFeatureEnabled } from "@/lib/feature-flags";
import {
  getApiRoomName,
  getJitsiDomain,
  isJaasMode,
  loadJitsiExternalApi,
  requestHangUp,
  type JitsiExternalApiInstance,
} from "@/lib/jitsi";
import { fetchJitsiToken } from "@/lib/jitsi-token";
import { canJoinSession, describeJoinWindow } from "@/lib/sessions";
import { querySessionById } from "@/lib/session-queries";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { sendCallRinging } from "@/lib/call-signals";
import { startRingback, stopRingback } from "@/lib/sounds";
import { isUuid } from "@/lib/uuid";
import { useRecordingConsent, type RecordingConsent } from "@/lib/recording-consent";
import {
  useSessionNotesRecorder,
  type SessionNotesRecorder,
} from "@/lib/use-session-notes-recorder";
import type { Enums } from "@/integrations/supabase/types";

// ── Why this lives outside the route ────────────────────────────────────────
//
// The conference used to be owned by /video/$sessionId. Every exit from that
// route - the Details link, the Chat link, the browser back button, a tap on
// Home - ran a navigation blocker that hung up the call and disposed the
// client. So "let me glance at the notes we just made" ended the call, which is
// exactly the complaint this module exists to fix.
//
// The call now belongs to the app, not to a page. This provider is mounted once
// above the router outlet, holds the Jitsi instance for its whole life, and the
// video route is reduced to a *stage*: a rectangle it asks the persistent host
// to align itself with. Navigate away and the host simply docks into a floating
// mini-player; the conference, the microphone and any AI-notes recording carry
// straight on.
//
// The one hard constraint behind that design: an <iframe> that is reparented in
// the DOM reloads, which for Jitsi means leaving and rejoining the room. The
// host element therefore NEVER moves in the tree - it is position:fixed and is
// only repositioned, so the same browsing context survives every route change.

type SessionStatus = Enums<"session_status">;

export type CallSession = {
  id: string;
  learnerId: string;
  teacherId: string;
  status: SessionStatus;
  skillName: string | null;
  learnerName: string;
  teacherName: string;
};

export type CallViewer = {
  displayName: string;
  email?: string;
  avatarUrl?: string;
};

/** idle → starting (loading the session) → live → ending → idle */
export type CallPhase = "idle" | "starting" | "live" | "ending";

type CallContextValue = {
  /** Session id of the call that is currently up, or null when there is none. */
  sessionId: string | null;
  session: CallSession | null;
  viewer: CallViewer | null;
  phase: CallPhase;
  /** True while the session row / token is still being fetched. */
  loading: boolean;
  connecting: boolean;
  callReady: boolean;
  joinSlow: boolean;
  reconnecting: boolean;
  fatal: string | null;
  leaving: boolean;
  sharing: boolean;
  audioMuted: boolean;
  /** True when no page is showing the call, i.e. the mini-player is on screen. */
  docked: boolean;
  isTeacher: boolean;
  /** The other participant's display name. */
  peerName: string;
  notesEnabled: boolean;
  notes: SessionNotesRecorder;
  consent: RecordingConsent;
  /** Join (or re-anchor) the call for this session. Safe to call repeatedly. */
  startCall: (sessionId: string) => void;
  /** Hang up, flush any recording, and clear the call. */
  endCall: () => void;
  retryJoin: () => void;
  toggleScreenShare: () => void;
  toggleAudio: () => void;
  dismissFatal: () => void;
  /** Ref callback the video route hands its stage element to. */
  attachStage: (element: HTMLElement | null) => void;
  stageEl: HTMLElement | null;
  /** The node the Jitsi iframe is mounted into. Owned by CallHost. */
  containerRef: RefObject<HTMLDivElement | null>;
};

const CallContext = createContext<CallContextValue | null>(null);

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
// Ceiling on how long a hangup waits for a recording to be flushed into notes.
// Generation normally lands inside a minute; the cap exists so a wedged upload
// can't hold the call open indefinitely. Generation continues server-side
// either way, so the notes still show up on the session page.
const NOTES_FLUSH_MAX_MS = 120000;

function afterMs(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const videoCallsEnabled = useFeatureEnabled("features.video_calls.enabled", true);
  const notesEnabled = useFeatureEnabled("features.session_notes.enabled", true);

  // Snapshot the theme via a ref so toggling the app theme can't reinitialize
  // the Jitsi iframe (and kick the user out). Theme changes take effect on the
  // next join.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // The call the user has asked to be in. Everything downstream keys off this.
  const [requestedId, setRequestedId] = useState<string | null>(null);
  // A call asked for while another one is still tearing down.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [session, setSession] = useState<CallSession | null>(null);
  const [viewer, setViewer] = useState<CallViewer | null>(null);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [callReady, setCallReady] = useState(false);
  // The scrim only hides Jitsi's initial near-black loading flash. It lifts the
  // moment the iframe paints any UI, not on videoConferenceJoined - which never
  // fires while the user sits on a prejoin/login screen.
  const [connecting, setConnecting] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [joinSlow, setJoinSlow] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The video page's rectangle, when a video page is mounted. Null means the
  // mini-player is showing.
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiExternalApiInstance | null>(null);
  const requestedIdRef = useRef<string | null>(null);
  requestedIdRef.current = requestedId;
  // Set before we ask for a hangup so the videoConferenceLeft/readyToClose that
  // follow are read as "we meant that" rather than as a dropped connection.
  const intentionalLeaveRef = useRef(false);
  // Non-null while a hangup is in flight; doubles as the idempotency guard.
  const endingRef = useRef<Promise<void> | null>(null);
  // Points at the live attendance-close callback of the current join attempt.
  const recordLeaveRef = useRef<() => void>(() => {});

  // Which video page (if any) the router is on right now. Used to decide
  // whether a hangup should also move the user somewhere else - hanging up from
  // the mini-player must leave them on the page they were reading.
  const routeVideoSessionId = useRouterState({
    select: (state) => {
      const match = state.matches.find((m) => m.routeId === "/video/$sessionId");
      const params = match?.params as { sessionId?: string } | undefined;
      return params?.sessionId ?? null;
    },
  });
  const routeVideoSessionIdRef = useRef(routeVideoSessionId);
  routeVideoSessionIdRef.current = routeVideoSessionId;

  const isTeacher = Boolean(session && user && session.teacherId === user.id);
  const peerName = session ? (isTeacher ? session.learnerName : session.teacherName) : "";

  // ── AI notes ──────────────────────────────────────────────────────────────
  //
  // Both of these used to live on the video route, which is why a recording
  // could not survive a trip to another page. They hang off the call now, so
  // the capture keeps running (and the consent dialogs keep working) wherever
  // the user happens to be.
  const notes = useSessionNotesRecorder({
    sessionId: requestedId ?? "",
    userId: user?.id,
    displayName: viewer?.displayName ?? "Your session partner",
  });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const consent = useRecordingConsent({
    sessionId: requestedId ?? "",
    selfUserId: user?.id,
  });

  const disposeInstance = useCallback((api: JitsiExternalApiInstance) => {
    // Only clear the ref if it still points at the instance being disposed - a
    // retry may already have put a fresh one there.
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

  const attachStage = useCallback((element: HTMLElement | null) => {
    setStageEl(element);
  }, []);

  // ── Ending the call ───────────────────────────────────────────────────────
  //
  // Jitsi's contract is hangup -> readyToClose -> dispose, and it has to run
  // while the iframe is still in the document, or the bridge holds our endpoint
  // until its own ping timeout and a rejoin inside that window sits next to the
  // stale one ("A, A, B"). Every deliberate exit goes through here.
  const endCall = useCallback(() => {
    if (endingRef.current) return endingRef.current;
    const id = requestedIdRef.current;
    if (!id) return Promise.resolve();

    setPhase("ending");
    // Get off the video page immediately: staring at a dead stage while the
    // recording flushes reads as a hang. Anywhere else, leave the user put -
    // hanging up from the mini-player must not yank them out of what they are
    // reading.
    if (routeVideoSessionIdRef.current === id) {
      navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
    }

    const api = apiRef.current;
    if (api) {
      apiRef.current = null;
      intentionalLeaveRef.current = true;
      setLeaving(true);
    }

    const run = (async () => {
      // Yield once before doing anything. Without it, a teardown with no live
      // client and no recording would run to completion synchronously and its
      // `finally` would clear endingRef *before* the assignment below set it -
      // leaving a stale promise in there that made every later endCall a no-op
      // and stranded any queued call.
      await Promise.resolve();
      try {
        if (api) {
          await requestHangUp(api);
          disposeInstance(api);
        }
        setLeaving(false);
        recordLeaveRef.current();
        if (notesRef.current.isActive) {
          // Stopping the capture has to finish before the recorder is reset -
          // otherwise the audio is thrown away. The "Generating your session
          // notes…" overlay explains the wait, and the cap keeps a stalled
          // upload from becoming a trap of its own.
          await Promise.race([
            notesRef.current.stopAndGenerate().catch(() => {}),
            afterMs(NOTES_FLUSH_MAX_MS),
          ]);
        }
        if (notesRef.current.companionActive) {
          // Same reasoning for the silent companion leg: upload it before the
          // reset would discard it.
          await Promise.race([
            notesRef.current.flushCompanion().catch(() => {}),
            afterMs(NOTES_FLUSH_MAX_MS),
          ]);
        }
      } finally {
        endingRef.current = null;
        intentionalLeaveRef.current = false;
        setLeaving(false);
        setRequestedId(null);
        setSession(null);
        setViewer(null);
        setCallReady(false);
        setConnecting(true);
        setSharing(false);
        setAudioMuted(false);
        setJoinSlow(false);
        setReconnecting(false);
        setFatal(null);
        setPhase("idle");
      }
    })();

    endingRef.current = run;
    return run;
  }, [disposeInstance, navigate]);

  // The conference effect must never list endCall in its deps: a new identity
  // there would tear the iframe down and rejoin the room. A ref keeps its
  // handlers pointed at the current one without making it a dependency.
  const endCallRef = useRef(endCall);
  endCallRef.current = endCall;

  const startCall = useCallback(
    (id: string) => {
      // Already in this room: this is a return trip to the video page, not a
      // rejoin. Re-initialising here is what would tear the conference down.
      if (requestedIdRef.current === id) return;
      if (requestedIdRef.current) void endCall();
      setPendingId(id);
    },
    [endCall],
  );

  // Promote a queued call once the previous one has finished leaving.
  useEffect(() => {
    if (!pendingId || requestedId || endingRef.current) return;
    setRequestedId(pendingId);
    setPendingId(null);
    setPhase("starting");
  }, [pendingId, requestedId, phase]);

  const retryJoin = useCallback(async () => {
    setConnecting(true);
    setFatal(null);
    setJoinSlow(false);
    setReconnecting(false);
    // Leave the old attempt properly before rejoining, or the retry itself is
    // what leaves a ghost of us in the room.
    const api = apiRef.current;
    if (api) {
      apiRef.current = null;
      intentionalLeaveRef.current = true;
      await requestHangUp(api);
      disposeInstance(api);
    }
    // Deliberately left set: requestHangUp resolves on a 1.5s timeout as well
    // as on readyToClose, and a readyToClose that lands after we cleared the
    // flag would be read as "Jitsi hung up on us" and end the very call we are
    // rejoining. The conference effect clears it when the new attempt starts.
    setCallReady(false);
    setSharing(false);
    setAttempt((n) => n + 1);
  }, [disposeInstance]);

  const toggleScreenShare = useCallback(() => {
    apiRef.current?.executeCommand("toggleShareScreen");
  }, []);

  const toggleAudio = useCallback(() => {
    apiRef.current?.executeCommand("toggleAudio");
  }, []);

  const dismissFatal = useCallback(() => {
    void endCall();
  }, [endCall]);

  // Signing out has to take the call with it.
  useEffect(() => {
    if (user || !requestedIdRef.current) return;
    disposeApi();
    setRequestedId(null);
    setPendingId(null);
    setSession(null);
    setViewer(null);
    setPhase("idle");
  }, [user, disposeApi]);

  // Tab close and reload never give us an awaitable teardown, so this is purely
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

  // ── Loading the session behind the call ───────────────────────────────────
  useEffect(() => {
    if (!requestedId || !user) return;
    let alive = true;
    const controller = new AbortController();

    // Only send the user somewhere if they are actually looking at this call's
    // page; a failure discovered while they are elsewhere just ends the call.
    const bailTo = (to: "dashboard" | "session", message: string) => {
      toast.error(message);
      if (routeVideoSessionIdRef.current === requestedId) {
        if (to === "session") {
          navigate({ to: "/sessions/$sessionId", params: { sessionId: requestedId } });
        } else {
          navigate({ to: "/dashboard" });
        }
      }
      setRequestedId(null);
      setPhase("idle");
    };

    const loadVideoSession = async () => {
      // Reject `/video/<garbage>` URLs before hitting PostgREST. An invalid
      // UUID would otherwise bubble up as a 400 the catch block turns into a
      // vague "Could not load video room" toast.
      if (!isUuid(requestedId)) {
        bailTo("dashboard", "That video link looks malformed.");
        return;
      }
      setPhase("starting");
      try {
        // Go through the shared helper so this benefits from the same
        // older-schema fallback ladder the dashboard/history/sessions pages
        // use. Without it, a deployment whose schema cache hasn't picked up
        // `initiator_id` / `duration_minutes` would 400 every join attempt.
        const row = await querySessionById({ sessionId: requestedId, signal: controller.signal });
        if (!alive) return;
        if (!row) {
          bailTo("dashboard", "Session not found");
          return;
        }
        if (row.learner_id !== user.id && row.teacher_id !== user.id) {
          bailTo("dashboard", "You do not have access to this video room");
          return;
        }
        if (row.status !== "accepted" && row.status !== "active") {
          bailTo("session", "Video opens after the session is accepted");
          return;
        }
        // Enforce the same join window the dashboard uses for the Join button.
        // Without this, anyone with a session URL could open the call hours
        // before the scheduled start or long after it ends (SEC-003).
        if (!canJoinSession(row.scheduled_at, row.duration_minutes)) {
          bailTo(
            "session",
            describeJoinWindow(row.scheduled_at, row.duration_minutes) ??
              "This video room isn't open right now",
          );
          return;
        }

        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name, avatar_url")
          .in("id", [row.learner_id, row.teacher_id])
          .abortSignal(controller.signal);
        const profiles = new Map((people ?? []).map((p) => [p.id, p]));
        if (!alive) return;

        const me = profiles.get(user.id);
        const avatarUrl = me?.avatar_url ? await signSingleAvatarUrl(me.avatar_url) : null;
        if (!alive) return;

        setSession({
          id: row.id,
          learnerId: row.learner_id,
          teacherId: row.teacher_id,
          status: row.status,
          skillName: row.skills?.name ?? null,
          learnerName: profiles.get(row.learner_id)?.full_name ?? "Student",
          teacherName: profiles.get(row.teacher_id)?.full_name ?? "Student",
        });
        setViewer({
          displayName: me?.full_name ?? user.email?.split("@")[0] ?? "SkillSwap user",
          email: user.email ?? undefined,
          avatarUrl: avatarUrl ?? undefined,
        });
        setPhase("live");
      } catch (error) {
        if (!alive) return;
        if (error instanceof Error && error.name === "AbortError") return;
        bailTo("dashboard", error instanceof Error ? error.message : "Could not load video room");
      }
    };

    void loadVideoSession();
    return () => {
      alive = false;
      controller.abort();
    };
    // user?.id only - auth token refreshes rotate the user object reference
    // without changing the user. Depending on `user` re-ran this load, which
    // produced a new session/viewer object and re-initialized the Jitsi iframe
    // mid-call, kicking the user out of the conference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedId, user?.id]);

  const apiRoomName = useMemo(() => {
    if (!session) return "";
    return getApiRoomName(session.id, session.skillName);
  }, [session]);

  // ── Ringing the other party ───────────────────────────────────────────────
  //
  // Once per call, not once per visit to the video page: re-ringing every time
  // the user came back from the session page would pop an incoming-call toast
  // at someone already sitting in the room with us.
  const ringedForRef = useRef<string | null>(null);
  const ringingRef = useRef(false);
  // Sticky for the lifetime of this call: once anybody has been in the room
  // with us, no decline signal may end the call.
  const hasRemoteRef = useRef(false);
  const markRemotePresent = useCallback(() => {
    hasRemoteRef.current = true;
    ringingRef.current = false;
    stopRingback();
  }, []);

  useEffect(() => {
    if (!session || !user || !viewer) return;
    if (ringedForRef.current === session.id) return;
    ringedForRef.current = session.id;
    hasRemoteRef.current = false;
    const otherPartyId = session.teacherId === user.id ? session.learnerId : session.teacherId;
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
      skillName: session.skillName,
    }).catch(() => {
      // Realtime not available - silently skip; the other party can still open
      // the call from the dashboard "Join" button.
    });
    return () => {
      window.clearTimeout(ringbackTimeout);
      ringingRef.current = false;
      stopRingback();
    };
  }, [session, user, viewer]);

  // Clear the ring guard when the call is over, so the same session can be
  // called again later.
  useEffect(() => {
    if (!requestedId) ringedForRef.current = null;
  }, [requestedId]);

  // Listen for a decline coming back from the other party so the caller doesn't
  // sit indefinitely in an empty Jitsi room.
  //
  // This uses postgres_changes on call_decline_signals (RLS-gated to
  // participants) rather than Realtime Broadcast, which has no sender
  // authentication - anyone with the session id could push a fake decline.
  //
  // Being the counterparty is not enough on its own, though. The row carries no
  // correlation to a particular ring, so any later decline the other person taps
  // used to eject us from a call that was very much live. A decline is only
  // honoured while it can actually be an answer to our ring: still ringing out,
  // and nobody has ever been in the room with us.
  useEffect(() => {
    if (!session || !user) return;
    const otherId = session.teacherId === user.id ? session.learnerId : session.teacherId;
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
          toast.error(
            `${session.teacherId === user.id ? session.learnerName : session.teacherName} declined the call`,
          );
          void endCallRef.current();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, user]);

  // ── The conference itself ─────────────────────────────────────────────────
  useEffect(() => {
    if (!session || !viewer || !apiRoomName || !containerRef.current) return;
    if (!videoCallsEnabled) return;

    let cancelled = false;
    let api: JitsiExternalApiInstance | null = null;

    intentionalLeaveRef.current = false;

    const joinSlowTimer = window.setTimeout(() => {
      if (cancelled) return;
      // Whatever Jitsi has painted is more useful than our scrim by now, and the
      // banner this unlocks carries the retry/back escape hatch.
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
      // Idempotent on both sides: the server-side RPC closes the most-recent
      // open attendance row, and the flag stops us firing twice when several
      // exit signals arrive for the same departure.
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
    recordLeaveRef.current = recordLeave;

    const handleScreenShare = (payload: unknown) => {
      setSharing(
        Boolean(payload && typeof payload === "object" && (payload as { on?: boolean }).on),
      );
    };
    const handleAudioMute = (payload: unknown) => {
      setAudioMuted(
        Boolean(payload && typeof payload === "object" && (payload as { muted?: boolean }).muted),
      );
    };
    // The other party is here - stop ringing out to ourselves, and lock out any
    // decline signal from ending the call from here on.
    const handleParticipantJoined = () => {
      markRemotePresent();
    };
    // videoConferenceLeft is NOT an exit signal. Jitsi emits it on connection
    // failure, on kicks and on its own recovery paths as well as on a real
    // hangup, so a three-second network blip must not end the call.
    const handleConferenceLeft = () => {
      if (cancelled) return;
      setCallReady(false);
      setSharing(false);
      if (intentionalLeaveRef.current) return;
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
    // "The client has finished leaving and the iframe is safe to destroy."
    // Reached from our own hangup (which owns the teardown already) or from the
    // hangup button inside Jitsi's own toolbar, which has to end the call.
    const handleReadyToClose = () => {
      disposeApi();
      if (intentionalLeaveRef.current) return;
      clearReconnectTimers();
      recordLeave();
      void endCallRef.current();
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
      // If we joined an already-occupied room (e.g. we're answering), there
      // won't be a participantJoined event for whoever is already inside, so
      // silence the ringback up front.
      if (api?.getNumberOfParticipants && api.getNumberOfParticipants() > 1) {
        markRemotePresent();
      }
      if (viewer.avatarUrl && api) {
        api.executeCommand("avatarUrl", viewer.avatarUrl);
      }
      // Heartbeat the attendance row every 30s. session_attended_seconds()
      // decays open intervals 90s after the last heartbeat, so missing one is
      // forgiving but a tab that stops heartbeating (closed, crashed,
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
          const result = await fetchJitsiToken({ sessionId: session.id });
          jwt = result.token;
        } catch (error) {
          if (cancelled) return;
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
      // removes the iframe it created, but it is best-effort by design here - it
      // is wrapped in try/catch, and a teardown that raced a detach can leave
      // the old iframe sitting in this container. That iframe is still a full
      // conference endpoint: still holding the microphone, still playing the
      // room out of the speakers. Two endpoints on one machine means this
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
      api.addListener("audioMuteStatusChanged", handleAudioMute);
      api.addListener("participantJoined", handleParticipantJoined);
      api.addListener("errorOccurred", handleErrorOccurred);
      api.addListener("participantKicked", handleParticipantKicked);
      api.addListener("suspendDetected", handleSuspendDetected);
      api.addListener("browserSupport", handleBrowserSupport);
      api.addListener("passwordRequired", handlePasswordRequired);
      // Lift the scrim once the iframe has painted its UI (prejoin/join
      // controls, moderator login, or the conference itself) rather than waiting
      // on videoConferenceJoined - otherwise the scrim covers the very controls
      // the user needs to tap to get into the call. getIFrame() returning null
      // used to strand the scrim until a successful join; joinSlowTimer is the
      // backstop for that.
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
      // The 30-min grace clamp in session_attended_seconds() handles the worst
      // case where this also fails to land (tab crash, lost network).
      recordLeave();
      recordLeaveRef.current = () => {};
      try {
        api?.removeListener("videoConferenceJoined", handleJoined);
        api?.removeListener("videoConferenceLeft", handleConferenceLeft);
        api?.removeListener("readyToClose", handleReadyToClose);
        api?.removeListener("screenSharingStatusChanged", handleScreenShare);
        api?.removeListener("audioMuteStatusChanged", handleAudioMute);
        api?.removeListener("participantJoined", handleParticipantJoined);
        api?.removeListener("errorOccurred", handleErrorOccurred);
        api?.removeListener("participantKicked", handleParticipantKicked);
        api?.removeListener("suspendDetected", handleSuspendDetected);
        api?.removeListener("browserSupport", handleBrowserSupport);
        api?.removeListener("passwordRequired", handlePasswordRequired);
      } catch {
        // ignore - a disposed iframe may already be detached
      }
      // No-op when the exit path already hung up and disposed, which is the path
      // every deliberate exit now takes.
      disposeApi();
      setCallReady(false);
      setConnecting(true);
      setSharing(false);
    };
  }, [apiRoomName, attempt, disposeApi, markRemotePresent, session, videoCallsEnabled, viewer]);

  const value = useMemo<CallContextValue>(
    () => ({
      sessionId: requestedId,
      session,
      viewer,
      phase,
      loading: Boolean(requestedId) && !session,
      connecting,
      callReady,
      joinSlow,
      reconnecting,
      fatal,
      leaving,
      sharing,
      audioMuted,
      docked: !stageEl,
      isTeacher,
      peerName,
      notesEnabled,
      notes,
      consent,
      startCall,
      endCall,
      retryJoin,
      toggleScreenShare,
      toggleAudio,
      dismissFatal,
      attachStage,
      stageEl,
      containerRef,
    }),
    [
      attachStage,
      audioMuted,
      callReady,
      connecting,
      consent,
      dismissFatal,
      endCall,
      fatal,
      isTeacher,
      joinSlow,
      leaving,
      notes,
      notesEnabled,
      peerName,
      phase,
      reconnecting,
      requestedId,
      retryJoin,
      session,
      sharing,
      stageEl,
      startCall,
      toggleAudio,
      toggleScreenShare,
      viewer,
    ],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used inside <CallProvider>");
  return ctx;
}
