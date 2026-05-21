import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  buildSessionIcsFile,
  downloadSessionIcs,
  type SessionDuration,
} from "@/lib/sessions";
import { playRequestSentChime } from "@/lib/sounds";
import { markSelfAction } from "@/lib/self-action";
import { SessionRequestDialog } from "@/components/SessionRequestDialog";
import { ReviewDialog } from "@/components/ReviewDialog";
import { Star } from "lucide-react";
import { useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";
import {
  queryUserSessions,
  type RawSessionRow as SharedRawSessionRow,
} from "@/lib/session-queries";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import type { Enums } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import {
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  MessageSquare,
  Sparkles,
  Users,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";

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
  skills: { id: string; name: string } | null;
  learnerName: string;
  teacherName: string;
};

type RawSessionRow = Omit<SessionRow, "learnerName" | "teacherName"> & SharedRawSessionRow;

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

function SessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
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

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/history" } });
    }
  }, [authLoading, navigate, user]);

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

  const loadSessions = useCallback(async () => {
    if (!user) return;
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
        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", participantIds);
        for (const person of people ?? []) {
          names.set(person.id, person.full_name ?? "Student");
        }
      }

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
          learnerName: names.get(session.learner_id) ?? "Student",
          teacherName: names.get(session.teacher_id) ?? "Student",
        };
      });
      setSessions(sessionRows);
    } catch (error) {
      toastError(error, "Could not load sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

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
      toast.success("Session completed and credits transferred");
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
    return <PageLoading />;
  }

  const isInitialLoading = loading && sessions.length === 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6">
      <section className="space-y-6">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none" />
          <div className="relative flex flex-col gap-6 p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                  Your <span className="gradient-brand-text">Sessions</span>
                </h1>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                  Track every booking in one place — accept, join, and review.
                </p>
              </div>
              <Button variant="hero" asChild className="self-start md:self-auto">
                <Link to="/explore" preload="intent">
                  <Sparkles className="h-4 w-4" />
                  Find more matches
                </Link>
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              {isInitialLoading ? (
                <>
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                  <StatCardSkeleton />
                </>
              ) : (
                <>
                  <StatCard label="Recent" value={stats.total} tone="default" icon={<Video className="h-4 w-4" />} />
                  <StatCard label="Pending" value={stats.pending} tone="pending" icon={<Clock className="h-4 w-4" />} />
                  <StatCard label="Accepted" value={stats.accepted} tone="accepted" icon={<Check className="h-4 w-4" />} />
                  <StatCard label="Completed" value={stats.completed} tone="completed" icon={<CheckCircle2 className="h-4 w-4" />} />
                </>
              )}
            </div>
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
              <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-purple/15">
                <CalendarClock className="h-5 w-5 text-brand-purple" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">No sessions here yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Explore matches to request a session, or switch filters to see more.
              </p>
              <Button variant="hero" className="mt-5" asChild>
                <Link to="/explore" preload="intent">
                  <Sparkles className="h-4 w-4" />
                  Explore Matches
                </Link>
              </Button>
            </div>
          ) : (
            visibleSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                currentUserId={user?.id}
                busy={busyIds.has(session.id)}
                onAccept={() => acceptSession(session)}
                onReject={() => rejectSession(session)}
                onComplete={() => completeSession(session)}
                onBookAgain={() => bookAgain(session)}
                onReview={() => setReviewSession(session)}
              />
            ))
          )}
        </div>
      </section>

      {rebookSession && (
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

function StatCardSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 sm:rounded-3xl sm:px-5 sm:py-5">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-6 w-10" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

function SessionCardSkeleton() {
  return (
    <div className="h-[156px] rounded-3xl glass border border-white/10 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-1 gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "default",
  icon,
}: {
  label: string;
  value: number;
  tone?: "default" | "pending" | "accepted" | "completed";
  icon?: React.ReactNode;
}) {
  const tones = {
    default: { value: "text-foreground", badge: "bg-brand-purple/15 text-brand-purple" },
    pending: { value: "text-amber-500", badge: "bg-amber-400/15 text-amber-400" },
    accepted: { value: "text-emerald-500", badge: "bg-brand-cyan/15 text-brand-cyan" },
    completed: { value: "text-blue-500", badge: "bg-blue-400/15 text-blue-400" },
  }[tone];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 transition-colors hover:bg-white/[0.07] sm:rounded-3xl sm:px-5 sm:py-5">
      <div className="flex items-center gap-3">
        {icon && (
          <div
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
              tones.badge,
            )}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className={cn("text-2xl font-bold leading-none sm:text-3xl", tones.value)}>
            {value}
          </div>
          <div className="mt-1 text-xs text-muted-foreground sm:text-sm">{label}</div>
        </div>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  currentUserId,
  busy,
  onAccept,
  onReject,
  onComplete,
  onBookAgain,
  onReview,
}: {
  session: SessionRow;
  currentUserId?: string;
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
  const roleLabel = isTeacher ? "Learner" : "Teacher";
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
    isAccepted &&
    !isTeacher &&
    earlyReleaseUnlockAt !== null &&
    earlyReleaseUnlockAt <= Date.now();
  const canRespondToPending =
    session.status === "pending" && Boolean(currentUserId && currentUserId !== sessionInitiatorId);
  const displayDate = new Date(session.scheduled_at ?? session.created_at);
  const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
  const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
  const handleAddToCalendar = () => {
    if (!session.scheduled_at) return;
    const ics = buildSessionIcsFile({
      sessionId: session.id,
      skillName: session.skills?.name ?? "Skill session",
      scheduledAt: session.scheduled_at,
      durationMinutes: session.duration_minutes,
      meetLink: roomLink || null,
      organizerName: session.teacherName,
      attendeeName: session.learnerName,
    });
    downloadSessionIcs(`skillswap-${session.id}.ics`, ics);
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
              <h2 className="text-lg font-bold leading-tight sm:text-xl">
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
            <div className="mt-1.5 text-sm text-muted-foreground">
              <span className="text-foreground/80">{roleLabel}:</span> {otherName}{" "}
              <span className="mx-1 opacity-40">&bull;</span> {session.duration_minutes} min{" "}
              <span className="mx-1 opacity-40">&bull;</span>{" "}
              <span className="text-foreground/80">{session.credits} credits</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1.5 text-xs text-muted-foreground sm:text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                <Calendar className="h-3.5 w-3.5" />
                {displayDate.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                <Clock className="h-3.5 w-3.5" />
                {displayDate.toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          {canRespondToPending && (
            <>
              <Button variant="hero" size="sm" onClick={onAccept} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Accept
              </Button>
              <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
                <X className="h-4 w-4" />
                Reject
              </Button>
            </>
          )}

          {isAccepted && roomLink && (
            <>
              {joinAllowed ? (
                <Button variant="outline" size="sm" asChild>
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
                  <Video className="h-4 w-4" />
                  {joinHint ?? "Join"}
                </Button>
              )}
              {session.scheduled_at && (
                <Button variant="outline" size="sm" onClick={handleAddToCalendar}>
                  <Calendar className="h-4 w-4" />
                  Add to Calendar
                </Button>
              )}
            </>
          )}

          <Button variant="outline" size="sm" asChild>
            <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: session.id }}>
              <Eye className="h-4 w-4" />
              {session.status === "completed" ? "View Details" : "Details"}
            </Link>
          </Button>

          {isAccepted && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/messages" preload="intent" search={{ s: session.id }}>
                <MessageSquare className="h-4 w-4" />
                Chat
              </Link>
            </Button>
          )}
          {earlyReleaseAvailable && (
            <ConfirmAction
              title="Release credits to your teacher now?"
              description={`This sends ${session.credits} credits to ${otherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room — otherwise the release will be blocked.`}
              confirmLabel="Release now"
              onConfirm={onComplete}
            >
              <Button
                size="sm"
                disabled={busy}
                className="bg-emerald-500 text-white hover:bg-emerald-600"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Complete Session
              </Button>
            </ConfirmAction>
          )}

          {session.status === "completed" && (
            <>
              <Button variant="outline" size="sm" onClick={onReview} disabled={busy}>
                <Star className="h-4 w-4" />
                Review
              </Button>
              <Button variant="outline" size="sm" onClick={onBookAgain} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Users className="h-4 w-4" />
                )}
                {isTeacher ? "Offer help again" : "Book Again"}
              </Button>
            </>
          )}
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
