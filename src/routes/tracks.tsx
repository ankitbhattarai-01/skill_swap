import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  BookOpen,
  Check,
  X,
  ArrowRight,
  CalendarClock,
  GraduationCap,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmAction } from "@/components/ConfirmAction";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/tracks")({
  head: () => ({ meta: [{ title: "Learning Tracks | SkillSwap" }] }),
  component: TracksPage,
});

type TrackRow = {
  id: string;
  role: "learner" | "teacher";
  other_user_id: string;
  other_user_name: string | null;
  skill_id: string;
  skill_name: string | null;
  goal: string;
  pattern: string;
  planned_count: number;
  default_duration_minutes: number;
  cadence_days: number;
  status: string;
  first_start_at: string;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  sessions_materialized: number;
  sessions_completed: number;
  sessions_skipped: number;
};

const STATUS_STYLES: Record<string, string> = {
  proposed: "bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/20",
  active: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
  completed: "bg-blue-400/15 text-blue-400 ring-1 ring-blue-400/20",
  cancelled: "bg-slate-400/15 text-slate-400 ring-1 ring-slate-400/20",
  rejected: "bg-rose-400/15 text-rose-400 ring-1 ring-rose-400/20",
};

const STATUS_HOVER: Record<string, string> = {
  proposed: "hover:border-amber-400/30 hover:shadow-glow",
  active: "hover:border-brand-cyan/30 hover:shadow-glow-blue",
  completed: "hover:border-blue-400/30 hover:shadow-glow-blue",
  cancelled: "hover:border-white/20",
  rejected: "hover:border-rose-400/30",
};

function TracksPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/tracks" } });
    }
  }, [authLoading, user, navigate]);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_my_tracks");
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    setTracks((data ?? []) as TrackRow[]);
    setLoading(false);
  };

  useEffect(() => {
    if (user) void load();
  }, [user]);

  // try/finally so `busyId` is always cleared. Without it, a network throw
  // (offline, fetch aborted, etc.) before the `setBusyId(null)` line leaves
  // the action button disabled forever until the user reloads the page.
  const accept = async (id: string) => {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc("accept_track", { p_track_id: id });
      if (error) return toast.error(error.message);
      toast.success("Track accepted. Sessions scheduled.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not accept track");
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string) => {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc("reject_track", {
        p_track_id: id,
        p_reason: null,
      });
      if (error) return toast.error(error.message);
      toast.success("Track rejected");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reject track");
    } finally {
      setBusyId(null);
    }
  };

  const end = async (id: string) => {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc("end_track", {
        p_track_id: id,
        p_reason: null,
      });
      if (error) return toast.error(error.message);
      toast.success("Track ended");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not end track");
    } finally {
      setBusyId(null);
    }
  };

  const stats = useMemo(() => {
    return {
      total: tracks.length,
      proposed: tracks.filter((t) => t.status === "proposed").length,
      active: tracks.filter((t) => t.status === "active").length,
      completed: tracks.filter((t) => t.status === "completed").length,
    };
  }, [tracks]);

  if (authLoading || loading) return <PageLoading variant="hero-stats" />;
  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          <div className="relative flex flex-col gap-6 p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="flex items-start gap-4">
                <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 ring-1 ring-brand-purple/25">
                  <BookOpen className="h-5 w-5 text-brand-purple" />
                </div>
                <div>
                  <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                    Learning <span className="gradient-brand-text">Tracks</span>
                  </h1>
                  <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                    Multi-session learning arrangements. Each session inside still uses normal
                    credits.
                  </p>
                </div>
              </div>
              <Button variant="hero" asChild className="self-start md:self-auto">
                <Link to="/explore" preload="intent">
                  <Sparkles className="h-4 w-4" />
                  Find a teacher
                </Link>
              </Button>
            </div>

            {tracks.length > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                <StatPill
                  label="Tracks"
                  value={stats.total}
                  icon={<BookOpen className="h-4 w-4" />}
                  tone="purple"
                />
                <StatPill
                  label="Proposed"
                  value={stats.proposed}
                  icon={<CalendarClock className="h-4 w-4" />}
                  tone="amber"
                />
                <StatPill
                  label="Active"
                  value={stats.active}
                  icon={<Sparkles className="h-4 w-4" />}
                  tone="cyan"
                />
                <StatPill
                  label="Completed"
                  value={stats.completed}
                  icon={<Check className="h-4 w-4" />}
                  tone="blue"
                />
              </div>
            )}
          </div>
        </section>

        {tracks.length === 0 ? (
          <div className="animate-fade-up glass rounded-3xl border border-white/10 px-6 py-14 text-center">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-purple/15">
              <BookOpen className="h-5 w-5 text-brand-purple" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">No tracks yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Visit a teacher&apos;s profile and tap{" "}
              <span className="font-medium text-foreground/80">&ldquo;Propose track&rdquo;</span> to
              start a multi-session learning arrangement.
            </p>
            <Button variant="hero" className="mt-5" asChild>
              <Link to="/explore" preload="intent">
                <Sparkles className="h-4 w-4" />
                Browse teachers
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {tracks.map((t) => (
              <TrackCard
                key={t.id}
                track={t}
                busy={busyId === t.id}
                onAccept={() => void accept(t.id)}
                onReject={() => void reject(t.id)}
                onEnd={() => end(t.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function TrackCard({
  track: t,
  busy,
  onAccept,
  onReject,
  onEnd,
}: {
  track: TrackRow;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEnd: () => Promise<unknown>;
}) {
  const statusStyle = STATUS_STYLES[t.status] ?? "bg-white/5 text-muted-foreground ring-1 ring-white/10";
  const hoverAccent = STATUS_HOVER[t.status] ?? "hover:border-white/20";
  const isActive = t.status === "active";
  const progressPct = isActive
    ? Math.min(100, Math.round((t.sessions_completed / Math.max(t.planned_count, 1)) * 100))
    : 0;
  const cadenceLabel = t.cadence_days === 1 ? "day" : `${t.cadence_days} days`;
  const firstStart = new Date(t.first_start_at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <article
      className={cn(
        "animate-fade-up group glass rounded-3xl border border-white/10 p-5 transition-all hover:-translate-y-0.5 sm:p-6",
        hoverAccent,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={cn("rounded-full border-0 px-2.5 py-0.5 text-xs font-medium capitalize", statusStyle)}
            >
              {t.status}
            </Badge>
            <Badge
              variant="outline"
              className="rounded-full border-white/10 bg-white/5 text-xs font-normal text-muted-foreground"
            >
              {t.pattern}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "rounded-full border text-xs font-normal",
                t.role === "learner"
                  ? "border-brand-cyan/25 bg-brand-cyan/[0.08] text-brand-cyan"
                  : "border-brand-purple/25 bg-brand-purple/[0.08] text-brand-purple",
              )}
            >
              {t.role === "learner" ? (
                <>
                  <GraduationCap className="h-3 w-3" />
                  Learning
                </>
              ) : (
                <>
                  <Users className="h-3 w-3" />
                  Teaching
                </>
              )}
            </Badge>
          </div>
          <h2 className="mt-3 text-lg font-bold leading-tight sm:text-xl">
            <span className="gradient-brand-text">{t.skill_name ?? "Skill"}</span>
            <span className="text-muted-foreground"> · </span>
            {t.other_user_name ?? "Other"}
          </h2>
          {t.goal && (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted-foreground">
              <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-purple/80" />
              {t.goal}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              <Sparkles className="h-3.5 w-3.5 text-brand-purple" />
              {t.planned_count} sessions × {t.default_duration_minutes}min
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              <CalendarClock className="h-3.5 w-3.5 text-brand-cyan" />
              Every {cadenceLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              First: {firstStart}
            </span>
          </div>

          {isActive && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground/80">
                  Progress · {t.sessions_completed}/{t.planned_count}
                  {t.sessions_skipped > 0 && (
                    <span className="ml-1 text-muted-foreground">
                      ({t.sessions_skipped} skipped)
                    </span>
                  )}
                </span>
                <span className="font-semibold text-brand-cyan">{progressPct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-purple to-brand-cyan transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {t.end_reason && (
            <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs italic text-muted-foreground">
              Reason: {t.end_reason}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {t.status === "proposed" && t.role === "teacher" && (
            <>
              <Button size="sm" variant="hero" onClick={onAccept} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Accept
              </Button>
              <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>
                <X className="h-4 w-4" />
                Reject
              </Button>
            </>
          )}
          {t.status === "proposed" && t.role === "learner" && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-2.5 py-1 text-xs text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Awaiting {t.other_user_name ?? "teacher"}
            </span>
          )}
          {t.status === "active" && (
            <ConfirmAction
              title="End this track?"
              description="Any sessions still planned will be cancelled. Already-booked sessions continue normally."
              confirmLabel="End track"
              destructive
              onConfirm={onEnd}
            >
              <Button size="sm" variant="outline" disabled={busy}>
                End track
              </Button>
            </ConfirmAction>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link to="/users/$userId" preload="intent" params={{ userId: t.other_user_id }}>
              Profile <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

function StatPill({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "purple" | "amber" | "cyan" | "blue";
}) {
  const badge = {
    purple: "bg-brand-purple/15 text-brand-purple",
    amber: "bg-amber-400/15 text-amber-400",
    cyan: "bg-brand-cyan/15 text-brand-cyan",
    blue: "bg-blue-400/15 text-blue-400",
  }[tone];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 transition-colors hover:bg-white/[0.07] sm:rounded-3xl sm:px-5 sm:py-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            badge,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-bold leading-none sm:text-3xl">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground sm:text-sm">{label}</div>
        </div>
      </div>
    </div>
  );
}
