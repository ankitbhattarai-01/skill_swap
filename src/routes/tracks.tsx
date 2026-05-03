import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, BookOpen, Check, X, ArrowRight } from "lucide-react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmAction } from "@/components/ConfirmAction";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/tracks")({
  head: () => ({ meta: [{ title: "Learning Tracks — SkillSwap" }] }),
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
  proposed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  completed: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  cancelled: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  rejected: "bg-rose-500/15 text-rose-300 border-rose-500/30",
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
      toast.success("Track accepted — sessions scheduled");
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

  if (authLoading || loading) return <PageLoading variant="messages" />;
  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4">
        <header className="glass rounded-3xl p-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Learning Tracks</h1>
            <p className="text-xs text-muted-foreground">
              Multi-session learning arrangements. Each session inside still uses normal credits.
            </p>
          </div>
        </header>

        {tracks.length === 0 ? (
          <div className="glass rounded-3xl px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No tracks yet. Visit a teacher&apos;s profile and click &ldquo;Propose track&rdquo; to
              start a multi-session learning arrangement.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tracks.map((t) => (
              <article key={t.id} className="glass rounded-2xl p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`border ${STATUS_STYLES[t.status] ?? "bg-muted"}`}
                      >
                        {t.status}
                      </Badge>
                      <Badge variant="outline" className="bg-white/5 border-white/10">
                        {t.pattern}
                      </Badge>
                      <Badge variant="outline" className="bg-white/5 border-white/10">
                        {t.role === "learner" ? "I'm learning" : "I'm teaching"}
                      </Badge>
                    </div>
                    <h2 className="mt-2 text-lg font-semibold">
                      {t.skill_name ?? "Skill"} — {t.other_user_name ?? "Other"}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t.goal}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t.planned_count} sessions × {t.default_duration_minutes}min, every{" "}
                      {t.cadence_days === 1 ? "day" : `${t.cadence_days} days`}. First:{" "}
                      {new Date(t.first_start_at).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                    {t.status === "active" && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Progress: {t.sessions_completed}/{t.planned_count} completed
                        {t.sessions_skipped > 0 && ` (${t.sessions_skipped} skipped)`}
                      </p>
                    )}
                    {t.end_reason && (
                      <p className="mt-2 text-xs italic text-muted-foreground">
                        Reason: {t.end_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {t.status === "proposed" && t.role === "teacher" && (
                      <>
                        <Button
                          size="sm"
                          variant="hero"
                          onClick={() => void accept(t.id)}
                          disabled={busyId === t.id}
                        >
                          {busyId === t.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void reject(t.id)}
                          disabled={busyId === t.id}
                        >
                          <X className="h-4 w-4" />
                          Reject
                        </Button>
                      </>
                    )}
                    {t.status === "proposed" && t.role === "learner" && (
                      <span className="text-xs text-muted-foreground">
                        Waiting for {t.other_user_name ?? "teacher"} to accept
                      </span>
                    )}
                    {t.status === "active" && (
                      <ConfirmAction
                        title="End this track?"
                        description="Any sessions still planned will be cancelled. Already-booked sessions continue normally."
                        confirmLabel="End track"
                        destructive
                        onConfirm={() => end(t.id)}
                      >
                        <Button size="sm" variant="outline" disabled={busyId === t.id}>
                          End track
                        </Button>
                      </ConfirmAction>
                    )}
                    <Button size="sm" variant="ghost" asChild>
                      <Link
                        to="/users/$userId"
                        preload="intent"
                        params={{ userId: t.other_user_id }}
                      >
                        Profile <ArrowRight className="h-4 w-4" />
                      </Link>
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
