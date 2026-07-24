import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ConfirmAction";
import { PageLoading } from "@/components/PageLoading";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { createVideoRoom, getVideoRoomUrl } from "@/lib/jitsi";
import {
  getOrCreateSession,
  canJoinSession,
  describeJoinWindow,
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
  type SessionCalendarDetails,
  type SessionDuration,
} from "@/lib/sessions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { playRequestSentChime } from "@/lib/sounds";
import { warmBookingDialogs } from "@/lib/warm-dialog-chunks";
import { markSelfAction } from "@/lib/self-action";
import { ReviewDialog } from "@/components/ReviewDialog";
import { useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";
import {
  queryUserSessions,
  type RawSessionRow as SharedRawSessionRow,
} from "@/lib/session-queries";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import type { Enums } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
// Icons are deliberately rare on this page: only the join button keeps one,
// because it is the single action people hunt for. Everything else is plain
// text - a button per icon made the list read like a generated template.
import { ChevronDown, Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { fetchReadySessionNotes, type SessionNotesRow } from "@/lib/session-notes";
import { downloadSessionNotesPdf } from "@/lib/session-notes-pdf";

// Lazy: SessionRequestDialog pulls in react-day-picker via the Calendar UI.
// Keeping it out of the history route chunk strips ~40-60kb from first paint
// since the rebook dialog only mounts when a user actually opens it.
const SessionRequestDialog = lazy(() =>
  import("@/components/SessionRequestDialog").then((m) => ({ default: m.SessionRequestDialog })),
);

const SESSION_FILTER_VALUES = ["all", "pending", "accepted", "completed"] as const;

export const Route = createFileRoute("/history")({
  validateSearch: (s: Record<string, unknown>): { filter?: SessionFilter } => ({
    filter:
      typeof s.filter === "string" &&
      (SESSION_FILTER_VALUES as readonly string[]).includes(s.filter)
        ? (s.filter as SessionFilter)
        : undefined,
  }),
  head: () => ({ meta: [{ title: "Sessions - SkillSwap" }] }),
  component: SessionsPage,
});

type SessionStatus = Enums<"session_status">;
type SessionFilter = "all" | "pending" | "accepted" | "completed";

type Profile = {
  full_name: string | null;
  credits: number;
};

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
  updated_at: string;
  batch_id: string | null;
  skills: { id: string; name: string } | null;
  learnerName: string;
  teacherName: string;
};

type RawSessionRow = Omit<SessionRow, "learnerName" | "teacherName"> & SharedRawSessionRow;

// A render unit in the list: either a standalone session, or a multi-session
// "plan" (sessions booked together, sharing a batch_id).
type SessionGroup =
  | { type: "single"; key: string; session: SessionRow }
  | { type: "plan"; key: string; sessions: SessionRow[] };

async function querySessionRows(userId: string) {
  const rows = await queryUserSessions({
    userId,
    statuses: ["pending", "accepted", "active", "completed"],
    limit: 50,
    selectOptions: { includeUpdatedAt: true },
  });
  return rows as RawSessionRow[];
}

const FILTERS: { label: string; value: SessionFilter }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Accepted", value: "accepted" },
  { label: "Completed", value: "completed" },
];

// Tail of the "Nothing …" heading shown when a filter has no rows.
const FILTER_EMPTY: Record<SessionFilter, string> = {
  all: "here yet",
  pending: "waiting on a reply",
  accepted: "coming up",
  completed: "finished yet",
};

// Count roll-up for the hero, e.g. "5 completed sessions" or "2 upcoming,
// 1 pending and 9 completed sessions". The noun is plural-matched to the last
// count, since that's the one sitting next to it.
function describeSessions(stats: {
  total: number;
  pending: number;
  accepted: number;
  completed: number;
}): string {
  if (stats.total === 0) {
    return "Nothing booked yet. Find someone to learn from and it'll show up here.";
  }
  const parts: string[] = [];
  let lastCount = 0;
  const add = (count: number, label: string) => {
    if (!count) return;
    parts.push(`${count} ${label}`);
    lastCount = count;
  };
  add(stats.accepted, "upcoming");
  add(stats.pending, "pending");
  add(stats.completed, "completed");
  if (parts.length === 0) return "Everything you've booked lives here.";
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${list} session${lastCount === 1 ? "" : "s"}`;
}

function SessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  // "Book again" on a past session opens a code-split dialog - fetch it while
  // the list is idle rather than on the click.
  useEffect(() => {
    warmBookingDialogs();
  }, []);
  const search = Route.useSearch();
  const filter = search.filter ?? "all";
  const setFilter = (next: SessionFilter) => {
    void navigate({
      to: "/history",
      search: { filter: next === "all" ? undefined : next },
      replace: true,
    });
  };
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [rebookSession, setRebookSession] = useState<SessionRow | null>(null);
  const [reviewSession, setReviewSession] = useState<SessionRow | null>(null);
  const [notesBySession, setNotesBySession] = useState<Map<string, SessionNotesRow>>(new Map());

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/history" } });
    }
  }, [authLoading, navigate, user]);

  // Notes are a side dish: fetched after the list renders so a slow (or empty)
  // session_notes query never holds up the cards themselves.
  const sessionIdsKey = sessions.map((session) => session.id).join(",");
  useEffect(() => {
    const ids = sessionIdsKey ? sessionIdsKey.split(",") : [];
    if (ids.length === 0) {
      setNotesBySession(new Map());
      return;
    }
    let alive = true;
    void fetchReadySessionNotes(ids).then((map) => {
      if (alive) setNotesBySession(map);
    });
    return () => {
      alive = false;
    };
  }, [sessionIdsKey]);

  const markBusy = useCallback((id: string) => {
    setBusyIds((current) => new Set(current).add(id));
  }, []);

  const clearBusy = useCallback((id: string) => {
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  // Monotonic token: realtime bursts can start a reload while one is already
  // in flight; only the newest invocation may write state, so an older slow
  // response can't overwrite a newer one.
  const loadSeqRef = useRef(0);

  const loadSessions = useCallback(async () => {
    if (!user) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const [{ data: profileData, error: profileError }, { data: creditBalance }, rawSessions] =
        await Promise.all([
          supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
          supabase.rpc("my_credit_balance"),
          querySessionRows(user.id),
        ]);

      if (profileError) throw profileError;

      const participantIds = Array.from(
        new Set(rawSessions.flatMap((session) => [session.learner_id, session.teacher_id])),
      );
      const names = new Map<string, string>();
      if (participantIds.length) {
        const { data: people, error: peopleError } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", participantIds);
        if (peopleError) console.error("[history] participant profile load failed:", peopleError);
        for (const person of people ?? []) {
          names.set(person.id, person.full_name ?? "Student");
        }
      }

      if (seq !== loadSeqRef.current) return;

      setProfile({
        full_name: (profileData as { full_name: string | null } | null)?.full_name ?? null,
        credits: creditBalance ?? 0,
      });
      const sessionRows = rawSessions.map((session) => {
        const normalizedLink =
          session.status === "accepted" || session.status === "active"
            ? getVideoRoomUrl({
                link: session.meet_link,
                sessionId: session.id,
                skillName: session.skills?.name,
              })
            : session.meet_link;
        return {
          ...session,
          meet_link: normalizedLink,
          batch_id: session.batch_id ?? null,
          learnerName: names.get(session.learner_id) ?? "Student",
          teacherName: names.get(session.teacher_id) ?? "Student",
        };
      });
      setSessions(sessionRows);
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      toastError(error, "Could not load sessions");
      setSessions([]);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
    // user?.id only - auth events rotate the user object reference even when
    // the underlying user hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Batch realtime bursts (e.g. accept_session fires multiple postgres_changes
  // from the same transaction) into a single reload.
  const debouncedReloadSessions = useDebouncedCallback(() => {
    void loadSessions();
  }, 250);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`sessions-page-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter: `learner_id=eq.${user.id}` },
        () => debouncedReloadSessions(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter: `teacher_id=eq.${user.id}` },
        () => debouncedReloadSessions(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [debouncedReloadSessions, user]);

  const stats = useMemo(() => {
    const acceptedCount = sessions.filter(
      (session) => session.status === "accepted" || session.status === "active",
    ).length;
    return {
      total: sessions.length,
      pending: sessions.filter((session) => session.status === "pending").length,
      accepted: acceptedCount,
      completed: sessions.filter((session) => session.status === "completed").length,
    };
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    if (filter === "all") return sessions;
    if (filter === "accepted") {
      return sessions.filter(
        (session) => session.status === "accepted" || session.status === "active",
      );
    }
    return sessions.filter((session) => session.status === filter);
  }, [filter, sessions]);

  // Progress per plan is computed over the *whole* batch (ignoring the active
  // filter) so "1/3 done" stays accurate even when a filter hides some rows.
  const planTotals = useMemo(() => {
    const totals = new Map<string, { total: number; completed: number }>();
    for (const session of sessions) {
      if (!session.batch_id) continue;
      const entry = totals.get(session.batch_id) ?? { total: 0, completed: 0 };
      entry.total += 1;
      if (session.status === "completed") entry.completed += 1;
      totals.set(session.batch_id, entry);
    }
    return totals;
  }, [sessions]);

  // Collapse the visible rows into render groups: a multi-session "plan" (when
  // its batch has more than one session) or a standalone single session.
  const sessionGroups = useMemo(() => {
    const groups: SessionGroup[] = [];
    const planAt = new Map<string, number>();
    for (const session of visibleSessions) {
      const isPlan = session.batch_id && (planTotals.get(session.batch_id)?.total ?? 0) > 1;
      if (isPlan && session.batch_id) {
        const existing = planAt.get(session.batch_id);
        if (existing != null) {
          (groups[existing] as Extract<SessionGroup, { type: "plan" }>).sessions.push(session);
        } else {
          planAt.set(session.batch_id, groups.length);
          groups.push({ type: "plan", key: `plan-${session.batch_id}`, sessions: [session] });
        }
      } else {
        groups.push({ type: "single", key: session.id, session });
      }
    }
    // Earliest first within a plan reads like a schedule.
    for (const group of groups) {
      if (group.type === "plan") {
        group.sessions.sort(
          (a, b) =>
            new Date(a.scheduled_at ?? a.created_at).getTime() -
            new Date(b.scheduled_at ?? b.created_at).getTime(),
        );
      }
    }
    return groups;
  }, [visibleSessions, planTotals]);

  const acceptSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const room = await createVideoRoom({
        sessionId: session.id,
        skillName: session.skills?.name,
      });
      const { error } = await supabase.rpc("accept_session", {
        p_session_id: session.id,
        p_meet_link: room.link,
      });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_accepted"]);
      toast.success(`Session accepted, ${session.credits} credits held in escrow`);
      void invalidateCreditBalance();
      await loadSessions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create Jitsi room");
    } finally {
      clearBusy(session.id);
    }
  };

  const rejectSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("reject_session", {
        p_session_id: session.id,
      });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_rejected"]);
      toast.success("Session rejected");
      void invalidateCreditBalance();
      await loadSessions();
    } finally {
      clearBusy(session.id);
    }
  };

  const completeSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("complete_session", { p_session_id: session.id });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_completed"]);
      // During pending_review the RPC routes through the attendance rule, so
      // the outcome can be a refund (no-show) rather than a transfer.
      toast.success(
        session.status === "pending_review"
          ? "Session settled. The outcome is based on attendance."
          : "Session completed and credits transferred",
      );
      void invalidateCreditBalance();
      await loadSessions();
    } finally {
      clearBusy(session.id);
    }
  };

  const bookAgain = (session: SessionRow) => {
    setRebookSession(session);
  };

  const confirmRebook = async (duration: SessionDuration, scheduledAt: string): Promise<void> => {
    if (!user || !rebookSession) return;
    markBusy(rebookSession.id);
    try {
      const previousHourly =
        (rebookSession.credits * 60) / Math.max(rebookSession.duration_minutes ?? 60, 1);
      const { error, created } = await getOrCreateSession({
        learnerId: rebookSession.learner_id,
        teacherId: rebookSession.teacher_id,
        initiatorId: user.id,
        skillId: rebookSession.skill_id,
        creditsPerHour: previousHourly,
        durationMinutes: duration,
        scheduledAt,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (created) playRequestSentChime();
      const isTeacherOffer = user.id === rebookSession.teacher_id;
      toast.success(
        created
          ? isTeacherOffer
            ? "Help offered again"
            : "Session requested again"
          : "You already have an open session",
      );
      setRebookSession(null);
      await loadSessions();
      setFilter("pending");
    } finally {
      clearBusy(rebookSession.id);
    }
  };

  if (authLoading) {
    return <PageLoading variant="hero-stats" />;
  }
  // Once authLoading flips false but the redirect effect hasn't fired yet,
  // an unauthenticated visitor would see the empty history shell for a
  // frame. Returning null here keeps the page blank until the navigate
  // call sends them to /login.
  if (!user) return null;

  const isInitialLoading = loading && sessions.length === 0;
  const summary = describeSessions(stats);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-[18px] sm:px-[18px] md:py-6">
      <section className="space-y-6">
        {/* The four stat tiles that used to live here repeated the exact counts
            on the filter chips below, so they were noise. One plain sentence
            says the same thing. */}
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          {/* Dark-only wash - see .hero-wash in styles.css */}
          <div className="hero-wash" />
          {/* Generous vertical padding: with the stat tiles gone the hero has
              little content, and at p-8 it read as a squat strip against its
              own corner radius. */}
          <div className="relative flex flex-col gap-5 px-6 py-10 md:flex-row md:items-center md:justify-between md:px-8 md:py-14">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                Your <span className="gradient-brand-text">sessions</span>
              </h1>
              <p className="mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
                {isInitialLoading ? "Getting your sessions…" : summary}
              </p>
            </div>
            <Button variant="hero" asChild className="self-start md:self-auto">
              <Link to="/explore" preload="intent">
                Find someone to learn from
              </Link>
            </Button>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => {
            const count =
              item.value === "all"
                ? stats.total
                : item.value === "pending"
                  ? stats.pending
                  : item.value === "accepted"
                    ? stats.accepted
                    : stats.completed;
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all",
                  active
                    ? "border-brand-purple/40 bg-brand-purple/15 text-brand-purple shadow-glow"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/20 hover:bg-white/10 hover:text-foreground",
                )}
              >
                {item.label}
                {!isInitialLoading && count > 0 && (
                  <span
                    className={cn(
                      "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                      active
                        ? "bg-brand-purple/30 text-brand-purple"
                        : "bg-white/10 text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          {isInitialLoading ? (
            <>
              <SessionCardSkeleton />
              <SessionCardSkeleton />
              <SessionCardSkeleton />
              <SessionCardSkeleton />
              <SessionCardSkeleton />
            </>
          ) : visibleSessions.length === 0 ? (
            <div className="animate-fade-up glass rounded-3xl border border-white/10 px-6 py-14 text-center">
              <h2 className="text-lg font-semibold">
                {filter === "all" ? "No sessions yet" : `Nothing ${FILTER_EMPTY[filter]}`}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                {filter === "all"
                  ? "Once you book a session, or someone books you, it shows up here."
                  : "Try another filter, or book something new."}
              </p>
              <Button variant="hero" className="mt-5" asChild>
                <Link to="/explore" preload="intent">
                  Browse people
                </Link>
              </Button>
            </div>
          ) : (
            sessionGroups.map((group) =>
              group.type === "plan" ? (
                <SessionPlanCard
                  key={group.key}
                  sessions={group.sessions}
                  progress={planTotals.get(group.sessions[0].batch_id ?? "")}
                  currentUserId={user?.id}
                  busyIds={busyIds}
                  onAccept={acceptSession}
                  onReject={rejectSession}
                />
              ) : (
                <SessionCard
                  key={group.key}
                  session={group.session}
                  currentUserId={user?.id}
                  notes={notesBySession.get(group.session.id) ?? null}
                  busy={busyIds.has(group.session.id)}
                  onAccept={() => acceptSession(group.session)}
                  onReject={() => rejectSession(group.session)}
                  onComplete={() => completeSession(group.session)}
                  onBookAgain={() => bookAgain(group.session)}
                  onReview={() => setReviewSession(group.session)}
                />
              ),
            )
          )}
        </div>
      </section>

      {rebookSession && (
        <Suspense fallback={null}>
          <SessionRequestDialog
            open={rebookSession !== null}
            onOpenChange={(open) => {
              if (!open) setRebookSession(null);
            }}
            title={user && rebookSession.teacher_id === user.id ? "Offer help again" : "Book again"}
            skillName={rebookSession.skills?.name ?? "skill"}
            creditsPerHour={
              (rebookSession.credits * 60) / Math.max(rebookSession.duration_minutes ?? 60, 1)
            }
            availableCredits={
              user && rebookSession.learner_id === user.id ? (profile?.credits ?? null) : null
            }
            busy={busyIds.has(rebookSession.id)}
            learnerId={rebookSession.learner_id}
            teacherId={rebookSession.teacher_id}
            onConfirm={confirmRebook}
          />
        </Suspense>
      )}
      {reviewSession && user && (
        <ReviewDialog
          open={reviewSession !== null}
          onOpenChange={(open) => {
            if (!open) setReviewSession(null);
          }}
          sessionId={reviewSession.id}
          revieweeId={
            reviewSession.teacher_id === user.id
              ? reviewSession.learner_id
              : reviewSession.teacher_id
          }
          revieweeName={
            reviewSession.teacher_id === user.id
              ? reviewSession.learnerName
              : reviewSession.teacherName
          }
        />
      )}
    </main>
  );
}

// Mirrors SessionCard's own markup (same padding, same flex switch at lg, same
// line heights) so the real cards drop straight in without any shift.
function SessionCardSkeleton() {
  return (
    <div className="rounded-3xl glass border border-white/10 px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <Skeleton className="h-12 w-12 shrink-0 rounded-2xl" />
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-40 rounded-md" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="h-4 w-36 rounded-full" />
            <Skeleton className="h-4 w-60 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2 lg:justify-end">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function SessionPlanCard({
  sessions,
  progress,
  currentUserId,
  busyIds,
  onAccept,
  onReject,
}: {
  sessions: SessionRow[];
  progress?: { total: number; completed: number };
  currentUserId?: string;
  busyIds: Set<string>;
  onAccept: (session: SessionRow) => void;
  onReject: (session: SessionRow) => void;
}) {
  const first = sessions[0];
  const isTeacher = first.teacher_id === currentUserId;
  const otherName = isTeacher ? first.learnerName : first.teacherName;
  const roleLabel = isTeacher ? "Teaching" : "Learning from";
  const total = progress?.total ?? sessions.length;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <article className="animate-fade-up group glass rounded-3xl border border-white/10 px-5 py-5 transition-all hover:-translate-y-0.5 hover:border-brand-purple/30 hover:shadow-glow sm:px-6">
      <div className="flex min-w-0 items-start gap-4">
        <AvatarInitial name={otherName} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold leading-tight sm:text-xl">
              {first.skills?.name ?? "Skill session"}
            </h2>
            <Badge className="rounded-full border-0 bg-brand-purple/15 px-2.5 py-0.5 text-xs font-medium text-brand-purple">
              {total} sessions
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {roleLabel} {otherName}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {first.duration_minutes} min each · {first.credits} credits each
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{completed === total ? "All done" : `${completed} of ${total} done`}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-purple to-brand-cyan transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <ul className="mt-4 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        {sessions.map((session, index) => (
          <PlanSessionRow
            key={session.id}
            session={session}
            index={index}
            currentUserId={currentUserId}
            busy={busyIds.has(session.id)}
            onAccept={() => onAccept(session)}
            onReject={() => onReject(session)}
          />
        ))}
      </ul>
    </article>
  );
}

function PlanSessionRow({
  session,
  index,
  currentUserId,
  busy,
  onAccept,
  onReject,
}: {
  session: SessionRow;
  index: number;
  currentUserId?: string;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const sessionInitiatorId = session.initiator_id ?? session.learner_id;
  const canRespondToPending =
    session.status === "pending" && Boolean(currentUserId && currentUserId !== sessionInitiatorId);
  const isAccepted = session.status === "accepted" || session.status === "active";
  const roomLink = getVideoRoomUrl({
    link: session.meet_link,
    sessionId: session.id,
    skillName: session.skills?.name,
  });
  const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
  const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
  const when = new Date(session.scheduled_at ?? session.created_at);

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        preload="intent"
        className="flex min-w-0 items-center gap-3 rounded-lg transition-colors hover:text-primary"
      >
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-muted-foreground">
          {index + 1}
        </span>
        <span className="truncate text-sm font-medium">
          {when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          <span className="mx-1 opacity-40">&bull;</span>
          {when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={session.status} />
        {canRespondToPending ? (
          <>
            <Button variant="hero" size="sm" onClick={onAccept} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Accept
            </Button>
            <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
              Decline
            </Button>
          </>
        ) : isAccepted && roomLink && joinAllowed ? (
          <Button variant="hero" size="sm" asChild>
            <Link to="/video/$sessionId" preload="intent" params={{ sessionId: session.id }}>
              <Video className="h-4 w-4" />
              Join
            </Link>
          </Button>
        ) : isAccepted && roomLink ? (
          <Button variant="outline" size="sm" disabled title={joinHint ?? "Not in session window"}>
            {joinHint ?? "Join"}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: session.id }}>
              Details
            </Link>
          </Button>
        )}
      </div>
    </li>
  );
}

function SessionCard({
  session,
  currentUserId,
  notes,
  busy,
  onAccept,
  onReject,
  onComplete,
  onBookAgain,
  onReview,
}: {
  session: SessionRow;
  currentUserId?: string;
  notes: SessionNotesRow | null;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onComplete: () => void;
  onBookAgain: () => void;
  onReview: () => void;
}) {
  const isTeacher = session.teacher_id === currentUserId;
  const sessionInitiatorId = session.initiator_id ?? session.learner_id;
  const otherName = isTeacher ? session.learnerName : session.teacherName;
  const roleLabel = isTeacher ? "Teaching" : "Learning from";
  const roomLink = getVideoRoomUrl({
    link: session.meet_link,
    sessionId: session.id,
    skillName: session.skills?.name,
  });
  const isAccepted = session.status === "accepted" || session.status === "active";
  // Early-release: learner-only, unlocks at the session's halfway point
  // (scheduled_at + duration/2). Server (private.complete_session) re-checks
  // the same time gate AND requires both parties to have attended ≥ 50%
  // of the planned duration in the Jitsi room.
  const earlyReleaseUnlockAt =
    session.scheduled_at && session.duration_minutes
      ? Date.parse(session.scheduled_at) + (session.duration_minutes * 60_000) / 2
      : null;
  const earlyReleaseAvailable =
    isAccepted && !isTeacher && earlyReleaseUnlockAt !== null && earlyReleaseUnlockAt <= Date.now();
  const canRespondToPending =
    session.status === "pending" && Boolean(currentUserId && currentUserId !== sessionInitiatorId);
  // Unscheduled sessions used to show their created_at as if it were the
  // meeting time, which quietly lied. Say what the date actually is instead.
  const whenLabel = session.scheduled_at
    ? `${new Date(session.scheduled_at).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })} at ${new Date(session.scheduled_at).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })}`
    : `Requested ${new Date(session.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })} · no time set yet`;
  const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
  const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
  const calendarDetails: SessionCalendarDetails | null = session.scheduled_at
    ? {
        sessionId: session.id,
        skillName: session.skills?.name ?? "Skill session",
        scheduledAt: session.scheduled_at,
        durationMinutes: session.duration_minutes,
        meetLink: roomLink || null,
        organizerName: session.teacherName,
        attendeeName: session.learnerName,
      }
    : null;
  const openCalendarLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const [downloadingNotes, setDownloadingNotes] = useState(false);
  const handleDownloadNotes = async () => {
    if (!notes?.notes) return;
    setDownloadingNotes(true);
    try {
      await downloadSessionNotesPdf(notes.notes, {
        skillName: session.skills?.name ?? null,
        teacherName: session.teacherName,
        learnerName: session.learnerName,
        scheduledAt: session.scheduled_at,
        generatedAt: notes.generated_at,
      });
    } catch {
      toast.error("Could not build the PDF.");
    } finally {
      setDownloadingNotes(false);
    }
  };

  const hoverAccent =
    session.status === "completed"
      ? "hover:border-blue-400/30 hover:shadow-glow-blue"
      : session.status === "pending"
        ? "hover:border-amber-400/30 hover:shadow-glow"
        : "hover:border-brand-purple/30 hover:shadow-glow";

  return (
    <article
      className={cn(
        "animate-fade-up group glass rounded-3xl border border-white/10 px-5 py-5 transition-all hover:-translate-y-0.5 sm:px-6",
        hoverAccent,
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <AvatarInitial name={otherName} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold leading-tight sm:text-xl">
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: session.id }}
                  className="rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label={`Open ${session.skills?.name ?? "skill"} session details`}
                >
                  {session.skills?.name ?? "Skill session"}
                </Link>
              </h2>
              <StatusBadge status={session.status} />
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {roleLabel} <span className="text-foreground/80">{otherName}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              {whenLabel} · {session.duration_minutes} min · {session.credits} credits
            </p>
          </div>
        </div>

        {/* One emphasised action per card (accept / join / book again); the
            rest stay quiet so the row doesn't read as a wall of buttons. */}
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {canRespondToPending && (
            <>
              <Button variant="hero" size="sm" onClick={onAccept} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Accept
              </Button>
              <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
                Decline
              </Button>
            </>
          )}

          {isAccepted && roomLink && (
            <>
              {joinAllowed ? (
                <Button variant="hero" size="sm" asChild>
                  <Link to="/video/$sessionId" preload="intent" params={{ sessionId: session.id }}>
                    <Video className="h-4 w-4" />
                    Join
                  </Link>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title={joinHint ?? "Not in session window"}
                >
                  {joinHint ?? "Join"}
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link to="/messages" preload="intent" search={{ s: session.id }}>
                  Message
                </Link>
              </Button>
              {calendarDetails && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      Add to calendar
                      <ChevronDown className="h-4 w-4 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => openCalendarLink(buildGoogleCalendarUrl(calendarDetails))}
                    >
                      Google Calendar
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => openCalendarLink(buildOutlookCalendarUrl(calendarDetails))}
                    >
                      Outlook
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}

          {earlyReleaseAvailable && (
            <ConfirmAction
              title="Release credits to your teacher now?"
              description={`This sends ${session.credits} credits to ${otherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room, otherwise the release will be blocked.`}
              confirmLabel="Release now"
              onConfirm={onComplete}
            >
              <Button
                size="sm"
                disabled={busy}
                className="bg-emerald-500 text-white hover:bg-emerald-600"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Mark as done
              </Button>
            </ConfirmAction>
          )}

          {session.status === "completed" && (
            <>
              <Button variant="hero" size="sm" onClick={onBookAgain} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {isTeacher ? "Offer help again" : "Book again"}
              </Button>
              <Button variant="outline" size="sm" onClick={onReview} disabled={busy}>
                Leave a review
              </Button>
            </>
          )}

          {notes?.notes && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDownloadNotes()}
              disabled={downloadingNotes}
            >
              {downloadingNotes && <Loader2 className="h-4 w-4 animate-spin" />}
              Notes (PDF)
            </Button>
          )}

          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: session.id }}>
              Details
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

function AvatarInitial({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "S";

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 text-base font-bold text-brand-purple ring-1 ring-white/10 transition-all group-hover:bg-brand-purple/25 group-hover:ring-brand-purple/30">
      {initial}
    </div>
  );
}

function StatusBadge({ status }: { status: SessionStatus }) {
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
  const labels: Partial<Record<SessionStatus, string>> = {
    active: "Accepted",
    pending_review: "Awaiting review",
    disputed: "Under review",
  };

  return (
    <Badge
      className={cn(
        "rounded-full border-0 px-2.5 py-0.5 text-xs font-medium capitalize",
        styles[status],
      )}
    >
      {labels[status] ?? status}
    </Badge>
  );
}
