import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ReportDialog } from "@/components/ReportDialog";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { getVideoRoomUrl } from "@/lib/jitsi";
import { canJoinSession, describeJoinWindow } from "@/lib/sessions";
import { isUuid } from "@/lib/uuid";
import { ConfirmAction } from "@/components/ConfirmAction";
import { RescheduleSection } from "@/components/RescheduleSection";
import { SessionNotesPanel } from "@/components/SessionNotesPanel";
import type { Enums } from "@/integrations/supabase/types";
// Same rule as the sessions list: the only icons left are the back arrow and
// the join button. A per-card icon made every section look machine-stamped.
import { ArrowLeft, Loader2, Video } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { playCancelChime } from "@/lib/sounds";
import { markSelfAction } from "@/lib/self-action";
import { invalidateAiSuggestionsCache } from "@/lib/ai-suggestions";
import { useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { querySessionById, type RawSessionRow as SharedRawSessionRow } from "@/lib/session-queries";
import { SESSION_DETAIL_CACHE_PREFIX } from "@/lib/page-caches";

export const Route = createFileRoute("/sessions/$sessionId")({
  head: () => ({ meta: [{ title: "Session - SkillSwap" }] }),
  component: SessionPage,
});

type SessionStatus = Enums<"session_status">;

type SessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  initiator_id: string | null;
  skill_id: string;
  status: SessionStatus;
  credits: number;
  duration_minutes: number;
  meet_link: string | null;
  scheduled_at: string | null;
  created_at: string;
  batch_id: string | null;
  is_swap?: boolean;
  swap_id?: string | null;
  skills: { id: string; name: string; category: string | null } | null;
  learnerName: string;
  teacherName: string;
};

type RawSessionRow = Omit<SessionRow, "learnerName" | "teacherName"> & SharedRawSessionRow;

// Lightweight sibling rows for the "Learning plan" card (sessions sharing this
// one's batch_id).
type PlanSibling = {
  id: string;
  scheduled_at: string | null;
  status: SessionStatus;
};

async function querySessionRow(sessionId: string) {
  const row = await querySessionById({
    sessionId,
    selectOptions: { includeSkillCategory: true },
  });
  return row as RawSessionRow | null;
}

// Same trick dashboard/explore/credits use: keep the last successful payload in
// sessionStorage so re-entering a session paints instantly instead of sitting
// on the skeleton for the whole fetch. The fetch still runs on every mount -
// the snapshot only decides whether the user stares at placeholders while it
// does. Scoped to the viewer so a cached payload can never render for someone
// who isn't a participant.
const SESSION_DETAIL_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type SessionDetailCache = {
  savedAt: number;
  session: SessionRow;
  planSiblings: PlanSibling[];
};

function sessionDetailCacheKey(sessionId: string, userId: string) {
  return `${SESSION_DETAIL_CACHE_PREFIX}-${userId}-${sessionId}`;
}

function getSessionDetailCache(sessionId: string, userId: string): SessionDetailCache | null {
  try {
    const raw = sessionStorage.getItem(sessionDetailCacheKey(sessionId, userId));
    if (!raw) return null;
    const cache = JSON.parse(raw) as SessionDetailCache;
    if (Date.now() - cache.savedAt > SESSION_DETAIL_CACHE_MAX_AGE_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function setSessionDetailCache(
  sessionId: string,
  userId: string,
  cache: Omit<SessionDetailCache, "savedAt">,
) {
  try {
    sessionStorage.setItem(
      sessionDetailCacheKey(sessionId, userId),
      JSON.stringify({ ...cache, savedAt: Date.now() }),
    );
  } catch {
    // Cache is only a speed boost; ignore quota/private-mode failures.
  }
}

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [planSiblings, setPlanSiblings] = useState<PlanSibling[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState("");
  // Do we already have something on screen? Drives two things: whether a load
  // shows the skeleton at all, and whether a stale in-flight response is still
  // allowed to win (see loadTokenRef).
  const hasSessionRef = useRef(false);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: `/sessions/${sessionId}` } });
    }
  }, [authLoading, navigate, sessionId, user]);

  const loadSession = async () => {
    if (!user) return;
    // Guard against `/sessions/<garbage>` URLs. Without this, PostgREST
    // rejects the eq() with "invalid input syntax for type uuid" and the
    // catch below shows a confusing 500-style error instead of "not found".
    if (!isUuid(sessionId)) {
      toast.error("That session link looks malformed.");
      navigate({ to: "/dashboard" });
      return;
    }
    const token = ++loadTokenRef.current;
    const isCurrent = () => token === loadTokenRef.current;

    // Paint the last known payload first. Everything below still runs - this
    // only decides whether the wait happens behind a skeleton or behind real
    // content. It also lets the two child cards (RescheduleSection,
    // SessionNotesPanel) mount and start their own queries immediately rather
    // than after the whole load resolves.
    if (!hasSessionRef.current) {
      const cached = getSessionDetailCache(sessionId, user.id);
      if (cached) {
        setSession(cached.session);
        setPlanSiblings(cached.planSiblings);
        hasSessionRef.current = true;
      }
    }
    // Never blank out content we're already showing - a refetch after
    // accept/cancel/reschedule used to drop the whole page back to the
    // skeleton and read as a full page reload.
    setLoading(!hasSessionRef.current);

    try {
      const row = await querySessionRow(sessionId);
      if (!isCurrent()) return;

      if (!row) {
        toast.error("Session not found");
        navigate({ to: "/dashboard" });
        return;
      }

      if (row.learner_id !== user.id && row.teacher_id !== user.id) {
        toast.error("You do not have access to this session");
        navigate({ to: "/dashboard" });
        return;
      }

      // Both follow-ups depend on the row but not on each other, so issue them
      // together. Awaiting the profiles query before even starting the sibling
      // one turned this into a three-request chain.
      //
      // Promise.resolve() is load-bearing: a PostgrestFilterBuilder is lazy and
      // only sends its request when something calls .then(). Just assigning the
      // builders would leave the sibling query sitting idle behind the profiles
      // await, i.e. exactly the serial behaviour we're removing.
      const peoplePromise = Promise.resolve(
        supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", [row.learner_id, row.teacher_id]),
      );
      // Sibling sessions in the same booking plan, for the progress card.
      const siblingsPromise = row.batch_id
        ? Promise.resolve(
            supabase
              .from("sessions")
              .select("id, scheduled_at, status")
              .eq("batch_id", row.batch_id)
              .order("scheduled_at", { ascending: true }),
          )
        : null;

      const { data: people } = await peoplePromise;
      if (!isCurrent()) return;
      const names = new Map(
        (people ?? []).map((person) => [person.id, person.full_name ?? "Student"]),
      );

      // meet_link is set by accept_session() to the internal /video/<id> deep
      // link and is locked thereafter (UPDATE grant revoked). The actual Jitsi
      // URL is always derived client-side from sessionId via getVideoRoomUrl.
      const derivedLink =
        row.status === "accepted" || row.status === "active"
          ? getVideoRoomUrl({
              link: row.meet_link,
              sessionId: row.id,
              skillName: row.skills?.name,
            })
          : row.meet_link;

      const nextSession: SessionRow = {
        ...row,
        batch_id: row.batch_id ?? null,
        meet_link: derivedLink,
        learnerName: names.get(row.learner_id) ?? "Student",
        teacherName: names.get(row.teacher_id) ?? "Student",
      };
      setSession(nextSession);
      hasSessionRef.current = true;
      // Everything the page needs to render is in hand - the plan card is the
      // only thing still outstanding, and it's optional, so don't hold the
      // first paint for it.
      setLoading(false);

      const nextSiblings = siblingsPromise
        ? (((await siblingsPromise).data ?? []) as PlanSibling[])
        : [];
      if (!isCurrent()) return;
      setPlanSiblings(nextSiblings);
      setSessionDetailCache(sessionId, user.id, {
        session: nextSession,
        planSiblings: nextSiblings,
      });
    } catch (error) {
      if (!isCurrent()) return;
      toastError(error, "Could not load session");
      setLoading(false);
    }
  };

  useEffect(() => {
    // A different session id means the on-screen payload belongs to the old
    // one, so the skeleton is correct again until the new row lands.
    hasSessionRef.current = false;
    setSession(null);
    setPlanSiblings([]);
    void loadSession();
    // user?.id (not user) - auth token refreshes rotate the user object
    // reference without changing the user; depending on the object re-ran
    // this whole load (and its profile fan-out) on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, user?.id]);

  // Has the scheduled start already passed? After that point cancel_session()
  // no longer blanket-refunds - it routes through attendance-based settlement
  // (see migration 20260523010000_fix_cancel_refund_exploit.sql), so the UI
  // copy must not promise a refund.
  const sessionStartPassed = Boolean(
    session?.scheduled_at && Date.parse(session.scheduled_at) <= Date.now(),
  );

  const acceptSession = async () => {
    if (!session || busy) return;
    setBusy("accept");
    try {
      // meet_link is derived server-side by accept_session() - the second arg
      // is accepted for backward compatibility but ignored. We pass null so
      // there's no chance of a teacher-supplied URL leaking through.
      const { error } = await supabase.rpc("accept_session", {
        p_session_id: session.id,
        p_meet_link: null,
      });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_accepted"]);
      void invalidateCreditBalance();
      toast.success(`Session accepted, ${session.credits} credits held in escrow`);
      await loadSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not accept session");
    } finally {
      setBusy(null);
    }
  };

  const rejectSession = async () => {
    if (!session || busy) return;
    setBusy("reject");
    try {
      const { error } = await supabase.rpc("reject_session", {
        p_session_id: session.id,
      });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_rejected"]);
      toast.success("Session rejected");
      await loadSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reject session");
    } finally {
      setBusy(null);
    }
  };

  const completeSession = async () => {
    if (!session || busy) return;
    setBusy("complete");
    try {
      const { error } = await supabase.rpc("complete_session", { p_session_id: session.id });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_completed"]);
      void invalidateCreditBalance();
      // Completion changes streak/momentum signals - regenerate suggestions.
      void invalidateAiSuggestionsCache();
      // During pending_review this routes through the attendance rule, so the
      // outcome might be a refund (no-show) rather than a transfer. Use a
      // neutral success message and let the history page show the detail.
      toast.success(
        session.status === "pending_review"
          ? "Session settled. See history for the outcome."
          : "Session completed and credits transferred",
      );
      navigate({ to: "/history" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete session");
    } finally {
      setBusy(null);
    }
  };

  const cancelSession = async () => {
    if (!session || busy) return;
    setBusy("cancel");
    try {
      const wasOpenEscrow = session.status === "accepted" || session.status === "active";
      const { error } = await supabase.rpc("cancel_session", { p_session_id: session.id });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_cancelled"]);
      void invalidateCreditBalance();
      playCancelChime();
      toast(
        wasOpenEscrow
          ? sessionStartPassed
            ? "Session ended. Credits were settled based on attendance. See history for the outcome."
            : "Session cancelled. Credits refunded."
          : "Request cancelled.",
      );
      await loadSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel session");
    } finally {
      setBusy(null);
    }
  };

  // "Something's wrong" during the review window. Freezes the session in
  // 'disputed' so the 24h auto-settle doesn't fire; the user should then
  // file a regular Report so admin has context.
  const disputeSession = async () => {
    if (!session || busy) return;
    setBusy("dispute");
    try {
      const { error } = await supabase.rpc("dispute_session", { p_session_id: session.id });
      if (error) return toast.error(error.message);
      toast.success("Session flagged for admin review. Please file a report with details.");
      await loadSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not flag session");
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async () => {
    if (!session || busy) return;
    if (!scheduleDraft) {
      toast.error("Pick a date and time first");
      return;
    }
    const scheduledAt = new Date(scheduleDraft);
    if (Number.isNaN(scheduledAt.getTime())) {
      toast.error("Invalid date and time");
      return;
    }
    // 60s buffer matches RescheduleSection - accounts for the user typing the
    // current minute exactly. The DB trigger is still authoritative.
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      toast.error("Pick a time in the future");
      return;
    }
    const iso = scheduledAt.toISOString();
    setBusy("schedule");
    try {
      const { error } = await supabase
        .from("sessions")
        .update({ scheduled_at: iso })
        .eq("id", session.id);
      if (error) return toast.error(error.message);
      toast.success("Session scheduled");
      setScheduleDraft("");
      await loadSession();
    } finally {
      setBusy(null);
    }
  };

  const clearSchedule = async () => {
    if (!session || busy) return;
    setBusy("schedule");
    try {
      const { error } = await supabase
        .from("sessions")
        .update({ scheduled_at: null })
        .eq("id", session.id);
      if (error) return toast.error(error.message);
      toast.success("Schedule cleared");
      await loadSession();
    } finally {
      setBusy(null);
    }
  };

  if (authLoading || loading || !session) {
    return <PageLoading variant="detail" />;
  }

  const isTeacher = session.teacher_id === user?.id;
  const isSwap = Boolean(session.is_swap);
  const sessionInitiatorId = session.initiator_id ?? session.learner_id;
  // Swaps use a paired accept/decline flow (both legs at once) handled from the
  // dashboard's Skill swaps card, never the per-session accept_session RPC.
  const canRespondToPending =
    !isSwap && session.status === "pending" && Boolean(user?.id && user.id !== sessionInitiatorId);
  const canCancelPending =
    !isSwap && session.status === "pending" && Boolean(user?.id && user.id === sessionInitiatorId);
  const isPendingSwap = isSwap && session.status === "pending";
  const isAcceptedSession = session.status === "accepted" || session.status === "active";
  const isInReview = session.status === "pending_review";
  const isDisputed = session.status === "disputed";
  // Finished for good - nothing left to join, schedule, or act on. These
  // sessions previously still rendered the live "Video room" card ("your
  // secure video room is ready") which is both wrong and the main reason the
  // completed view read as a stack of empty white boxes.
  const isFinished =
    session.status === "completed" ||
    session.status === "cancelled" ||
    session.status === "rejected";
  // Early-release flow during accepted/active: only the learner may complete
  // before the scheduled end, AND only after the session's halfway point
  // (scheduled_at + duration/2) has passed. The server
  // (private.complete_session) re-checks the same time gate AND requires
  // BOTH parties to have attended ≥ 50% of the planned duration via Jitsi -
  // those checks gate against Sybil farming where fake learners funnel
  // credits to a main account without any real teaching.
  const earlyReleaseUnlockAt =
    session.scheduled_at && session.duration_minutes
      ? Date.parse(session.scheduled_at) + (session.duration_minutes * 60_000) / 2
      : null;
  const earlyReleaseUnlocked = earlyReleaseUnlockAt !== null && earlyReleaseUnlockAt <= Date.now();
  // Swaps hold no escrow, so there are no credits to release early - the cron
  // sweeper auto-completes swap legs after their scheduled end.
  const canEarlyRelease = !isSwap && isAcceptedSession && !isTeacher && earlyReleaseUnlocked;
  const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
  const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
  const statusTone = sessionStatusTone(session.status);
  const scheduledLabel = session.scheduled_at
    ? new Date(session.scheduled_at).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const isPlan = planSiblings.length > 1;
  const planCompleted = planSiblings.filter((s) => s.status === "completed").length;
  const planPct = isPlan ? Math.round((planCompleted / planSiblings.length) * 100) : 0;

  return (
    <div className="relative min-h-screen flex flex-col">
      {/* Ambient page wash. Without it the white glass cards sit on a plain
          white page and the whole detail view reads as a blank sheet - most
          noticeable on completed sessions, where the cards carry little
          content. Light mode only; dark mode gets its depth from surfaces. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 dark:hidden bg-[radial-gradient(at_10%_0%,rgba(124,58,237,0.10),transparent_45%),radial-gradient(at_90%_5%,rgba(16,185,129,0.09),transparent_45%),radial-gradient(at_55%_95%,rgba(167,139,250,0.09),transparent_50%)]"
      />
      <main className="mx-auto w-full max-w-6xl px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          <div className="relative p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="-ml-2 mb-4 text-muted-foreground hover:text-foreground"
                >
                  <Link to="/history" preload="intent">
                    <ArrowLeft className="h-4 w-4" />
                    All sessions
                  </Link>
                </Button>
                <h1 className="text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
                  {session.skills?.name ?? "Skill session"}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground sm:text-base">
                  <span className="font-medium text-foreground">{session.learnerName}</span> is
                  learning from{" "}
                  <span className="font-medium text-foreground">{session.teacherName}</span>
                </p>
                <p className="mt-4 text-sm text-muted-foreground">
                  {[
                    scheduledLabel ?? "No time set yet",
                    `${session.duration_minutes} min`,
                    `${session.credits} credits`,
                    isPlan ? `${planCompleted} of ${planSiblings.length} in this plan done` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Badge
                className={cn(
                  "rounded-full border-0 px-3 py-1 text-xs font-medium capitalize",
                  statusTone,
                )}
              >
                {session.status === "active"
                  ? "Accepted"
                  : session.status === "pending_review"
                    ? "Awaiting review"
                    : session.status === "disputed"
                      ? "Under review"
                      : session.status}
              </Badge>
            </div>
          </div>
        </section>

        <div className="grid lg:grid-cols-3 gap-4">
          <section className="lg:col-span-2 space-y-4">
            {isPlan && (
              <div className="animate-fade-up glass-gradient rounded-3xl border border-white/10 p-6 md:p-7">
                <SectionTitle note={`${planCompleted} of ${planSiblings.length} done`}>
                  Learning plan
                </SectionTitle>
                <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${planPct}%` }}
                  />
                </div>
                <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  {planSiblings.map((sibling, index) => {
                    const isCurrent = sibling.id === session.id;
                    const when = sibling.scheduled_at ? new Date(sibling.scheduled_at) : null;
                    return (
                      <li
                        key={sibling.id}
                        className={cn(
                          "flex items-center justify-between gap-3 px-3 py-2.5",
                          isCurrent && "bg-muted/60",
                        )}
                      >
                        <Link
                          to="/sessions/$sessionId"
                          params={{ sessionId: sibling.id }}
                          preload="intent"
                          className="flex min-w-0 items-center gap-3 transition-colors hover:text-primary"
                        >
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="truncate text-sm font-medium">
                            {when
                              ? when.toLocaleString(undefined, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "Unscheduled"}
                            {isCurrent && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                · this one
                              </span>
                            )}
                          </span>
                        </Link>
                        <Badge
                          className={cn(
                            "shrink-0 rounded-full border-0 px-2.5 py-0.5 text-xs font-medium capitalize",
                            sessionStatusTone(sibling.status),
                          )}
                        >
                          {sibling.status === "active" ? "accepted" : sibling.status}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div className="animate-fade-up glass-gradient rounded-3xl border border-white/10 p-6 md:p-7">
              <SectionTitle>Session details</SectionTitle>
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                <Field label="Learner" value={session.learnerName} />
                <Field label="Teacher" value={session.teacherName} />
                <Field label="Skill" value={session.skills?.name ?? "Skill"} />
                <Field label="Duration" value={`${session.duration_minutes} min`} />
                <Field label="Credits" value={`${session.credits} credits`} />
                {session.skills?.category && (
                  <Field label="Category" value={session.skills.category} />
                )}
              </dl>
            </div>

            <div className="animate-fade-up glass-gradient rounded-3xl border border-white/10 p-6 md:p-7">
              <SectionTitle>{isFinished ? "When it happened" : "Schedule"}</SectionTitle>
              <p className="text-sm text-muted-foreground">
                {session.scheduled_at
                  ? new Date(session.scheduled_at).toLocaleString(undefined, {
                      dateStyle: "full",
                      timeStyle: "short",
                    })
                  : isFinished
                    ? "This session was never scheduled."
                    : isTeacher
                      ? "Pick a date and time to let the learner know when to join."
                      : "The teacher hasn't scheduled this session yet."}
              </p>
              {/* Direct schedule edit only on pending sessions - once accepted,
                  changes must go through the two-sided propose_reschedule flow. */}
              {isTeacher && !isSwap && session.status === "pending" && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="datetime-local"
                    value={scheduleDraft}
                    onChange={(event) => setScheduleDraft(event.target.value)}
                    className="glass h-10 border-white/10"
                  />
                  <Button
                    variant="outline"
                    onClick={saveSchedule}
                    disabled={busy === "schedule" || !scheduleDraft}
                  >
                    {busy === "schedule" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {session.scheduled_at ? "Update" : "Save"}
                  </Button>
                  {session.scheduled_at && (
                    <Button variant="ghost" onClick={clearSchedule} disabled={busy === "schedule"}>
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {isAcceptedSession && user?.id && (
                <div className="mt-3">
                  <RescheduleSection
                    sessionId={session.id}
                    currentUserId={user.id}
                    teacherId={session.teacher_id}
                    durationMinutes={session.duration_minutes}
                    onScheduleChanged={() => void loadSession()}
                  />
                </div>
              )}
            </div>

            {/* Hidden once the session is over - meet_link survives completion,
                so this card used to claim the room was "ready" for sessions
                that had already ended. */}
            {!isFinished && (
              <div className="animate-fade-up glass-gradient rounded-3xl border border-white/10 p-6 md:p-7">
                <SectionTitle>Video room</SectionTitle>
                <p className="text-sm text-muted-foreground">
                  {session.meet_link
                    ? "Your room is ready. It opens shortly before the start time."
                    : session.status === "pending"
                      ? "A room appears here once the teacher accepts."
                      : "A room will be set up for you automatically."}
                </p>
                {isAcceptedSession &&
                  (getVideoRoomUrl({
                    link: session.meet_link,
                    sessionId: session.id,
                    skillName: session.skills?.name,
                  }) ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {joinAllowed ? (
                        <Button variant="hero" asChild>
                          <Link
                            to="/video/$sessionId"
                            preload="intent"
                            params={{ sessionId: session.id }}
                          >
                            <Video className="h-4 w-4" />
                            Join session
                          </Link>
                        </Button>
                      ) : (
                        <Button variant="hero" disabled title={joinHint ?? "Not in session window"}>
                          <Video className="h-4 w-4" />
                          {joinHint ?? "Join session"}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      variant="hero"
                      className="mt-4"
                      onClick={() =>
                        toast.error("Video room is unavailable. Try opening the session again.")
                      }
                    >
                      <Video className="h-4 w-4" />
                      Join session
                    </Button>
                  ))}
              </div>
            )}

            <aside className="animate-fade-up glass-gradient rounded-3xl border border-white/10 p-6 md:p-7 space-y-3">
              <SectionTitle className="mb-4">Actions</SectionTitle>
              {isPendingSwap && (
                <div className="rounded-xl border border-brand-purple/25 bg-brand-purple/[0.06] px-4 py-3 text-sm">
                  <p className="font-medium">This is a skill swap.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Accept or decline both sides at once from the Skill swaps card on your{" "}
                    <Link to="/dashboard" className="text-brand-purple hover:underline">
                      dashboard
                    </Link>
                    .
                  </p>
                </div>
              )}
              {canRespondToPending && (
                <>
                  <Button
                    variant="hero"
                    className="w-full"
                    onClick={acceptSession}
                    disabled={busy === "accept"}
                  >
                    {busy === "accept" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Accept
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={rejectSession}
                    disabled={Boolean(busy)}
                  >
                    Decline
                  </Button>
                </>
              )}
              {canCancelPending && (
                <ConfirmAction
                  title="Cancel this pending session?"
                  description="The other person will no longer see this pending session. You can create a new one anytime."
                  confirmLabel="Cancel"
                  cancelLabel="Keep it"
                  destructive
                  onConfirm={cancelSession}
                >
                  <Button variant="outline" className="w-full" disabled={busy === "cancel"}>
                    {busy === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Cancel request
                  </Button>
                </ConfirmAction>
              )}
              {(isAcceptedSession || isInReview || isDisputed) && (
                <Button variant="outline" className="w-full" asChild>
                  <Link to="/messages" search={{ s: session.id }}>
                    Message {isTeacher ? session.learnerName : session.teacherName}
                  </Link>
                </Button>
              )}
              {isInReview && (
                <>
                  <ConfirmAction
                    title="Confirm this session is settled?"
                    description={
                      "We'll release escrow based on who attended the call. If both showed up, the teacher receives the credits. " +
                      "If someone didn't show, you'll be refunded automatically."
                    }
                    confirmLabel="All good, settle now"
                    onConfirm={completeSession}
                  >
                    <Button variant="hero" className="w-full" disabled={busy === "complete"}>
                      {busy === "complete" && <Loader2 className="h-4 w-4 animate-spin" />}
                      All good, settle it
                    </Button>
                  </ConfirmAction>
                  <ConfirmAction
                    title="Flag this session for review?"
                    description={
                      "Escrow stays frozen until a moderator reviews the case. Please also file a report so admins have context."
                    }
                    confirmLabel="Flag for review"
                    cancelLabel="Never mind"
                    destructive
                    onConfirm={disputeSession}
                  >
                    <Button variant="outline" className="w-full" disabled={busy === "dispute"}>
                      {busy === "dispute" && <Loader2 className="h-4 w-4 animate-spin" />}
                      Something went wrong
                    </Button>
                  </ConfirmAction>
                  <p className="text-xs text-muted-foreground">
                    We&apos;ll auto-settle this session in 24h if no one acts. Outcome is based on
                    attendance.
                  </p>
                </>
              )}
              {isDisputed && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                  This session is frozen pending admin review. Credits stay in escrow until
                  resolved.
                </div>
              )}
              {!isSwap &&
                isAcceptedSession &&
                !isTeacher &&
                !earlyReleaseUnlocked &&
                earlyReleaseUnlockAt && (
                  <p className="text-xs text-muted-foreground">
                    Early release becomes available at{" "}
                    {new Date(earlyReleaseUnlockAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}{" "}
                    (halfway through the planned {session.duration_minutes} min), and only if both
                    of you have spent at least that much time in the video room. Otherwise credits
                    release automatically after the scheduled end.
                  </p>
                )}
              {canEarlyRelease && (
                <ConfirmAction
                  title="Release credits to your teacher now?"
                  description={`This sends ${session.credits} credits to ${session.teacherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room, otherwise the release will be blocked and credits will release automatically once the session wraps up.`}
                  confirmLabel="Release now"
                  onConfirm={completeSession}
                >
                  <Button variant="hero" className="w-full" disabled={busy === "complete"}>
                    {busy === "complete" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Release credits now
                  </Button>
                </ConfirmAction>
              )}
              {isAcceptedSession && (
                <ConfirmAction
                  title={
                    isSwap
                      ? "Cancel this skill swap?"
                      : sessionStartPassed
                        ? "End this session?"
                        : "Cancel this session?"
                  }
                  description={
                    isSwap
                      ? "This session is one half of a skill swap, so cancelling calls off both linked sessions. No credits are involved."
                      : sessionStartPassed
                        ? `The session has already started, so the ${session.credits} escrowed credits are settled based on who attended the call. They may transfer to the teacher, be refunded, or split. There's no blanket refund after the start time.`
                        : `Cancelling will refund the ${session.credits} credits held in escrow back to the learner. You can re-request later if plans change.`
                  }
                  confirmLabel={
                    isSwap
                      ? "Cancel swap"
                      : sessionStartPassed
                        ? "End and settle"
                        : "Cancel session"
                  }
                  cancelLabel="Keep it"
                  destructive
                  onConfirm={cancelSession}
                >
                  <Button variant="outline" className="w-full" disabled={busy === "cancel"}>
                    {busy === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {isSwap ? "Cancel swap" : sessionStartPassed ? "End session" : "Cancel session"}
                  </Button>
                </ConfirmAction>
              )}
              {user?.id && (
                <ReportDialog
                  reportedUserId={isTeacher ? session.learner_id : session.teacher_id}
                  sessionId={session.id}
                  label="Report"
                />
              )}
              <p className="text-xs text-muted-foreground">
                {isFinished
                  ? "This session is closed, so there's nothing left to accept, cancel, or settle. You can still report a problem."
                  : "Chat is tied to this session. Credits transfer only when the session is completed."}
              </p>
            </aside>
          </section>

          {/* Renders nothing until a recording has actually been made for
              this session, so untouched sessions are unaffected. */}
          <SessionNotesPanel
            sessionId={session.id}
            skillName={session.skills?.name ?? null}
            teacherName={session.teacherName}
            learnerName={session.learnerName}
            scheduledAt={session.scheduled_at}
          />
        </div>
      </main>
    </div>
  );
}

// Quiet, consistent card heading: a solid title and an optional muted note.
// Deliberately no icon or colored icon-chip - a symbol on every card reads as
// a generated template rather than a considered layout.
function SectionTitle({
  note,
  className,
  children,
}: {
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-5 flex items-baseline gap-2", className)}>
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate font-medium leading-tight">{value}</dd>
    </div>
  );
}

function sessionStatusTone(status: SessionStatus): string {
  const styles: Record<SessionStatus, string> = {
    pending: "bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/20",
    accepted: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
    active: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
    completed: "bg-blue-400/15 text-blue-400 ring-1 ring-blue-400/20",
    rejected: "bg-red-400/15 text-red-400 ring-1 ring-red-400/20",
    cancelled: "bg-slate-400/15 text-slate-400 ring-1 ring-slate-400/20",
    pending_review: "bg-brand-purple/15 text-brand-purple ring-1 ring-brand-purple/20",
    disputed: "bg-rose-400/15 text-rose-400 ring-1 ring-rose-400/20",
  };
  return styles[status];
}
