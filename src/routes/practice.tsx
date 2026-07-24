import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { PracticeProblemCard } from "@/components/practice/PracticeProblemCard";
import { PracticeStatsBar } from "@/components/practice/PracticeStatsBar";
import { PracticeSkillPicker } from "@/components/practice/PracticeSkillPicker";
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_TONE,
  PRACTICE_LEVELS,
  generatePracticeSet,
  loadLearningSkills,
  loadPracticeProgress,
  loadSkillNames,
  PracticeError,
  recordPracticeAnswer,
  type PracticeLevel,
  type PracticeProblem,
  type PracticeProgress,
  type PracticeSkill,
} from "@/lib/practice";

export const Route = createFileRoute("/practice")({
  head: () => ({ meta: [{ title: "Practice - SkillSwap" }] }),
  component: PracticePage,
});

// Fetch this many problems per batch; prefetch the next batch once the queue
// runs low so "Next" is instant.
const BATCH_SIZE = 5;
const PREFETCH_AT = 2;

type Phase = "picker" | "loading" | "solving" | "error";

// Aggregate stat totals across every (skill, level) counter row.
function aggregate(progress: Map<string, PracticeProgress>) {
  let solved = 0;
  let attempted = 0;
  const skills = new Set<string>();
  for (const row of progress.values()) {
    solved += row.solved;
    attempted += row.attempted;
    skills.add(row.skillId);
  }
  return {
    solved,
    attempted,
    skills: skills.size,
    accuracy: attempted > 0 ? Math.round((solved / attempted) * 100) : 0,
  };
}

function PracticePage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [dataLoading, setDataLoading] = useState(true);
  const [learningSkills, setLearningSkills] = useState<PracticeSkill[]>([]);
  const [progress, setProgress] = useState<Map<string, PracticeProgress>>(new Map());
  const [skillNames, setSkillNames] = useState<Map<string, string>>(new Map());

  // Picker selection
  const [selected, setSelected] = useState<PracticeSkill | null>(null);
  const [level, setLevel] = useState<PracticeLevel>("basic");

  // Session state
  const [phase, setPhase] = useState<Phase>("picker");
  const [current, setCurrent] = useState<PracticeProblem | null>(null);
  const [queue, setQueue] = useState<PracticeProblem[]>([]);
  const [questionNumber, setQuestionNumber] = useState(0);
  const [sessionSolved, setSessionSolved] = useState(0);
  const [sessionAttempted, setSessionAttempted] = useState(0);
  const [streak, setStreak] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  // The skill + level the running session is locked to (the picker values can
  // drift while a session is live, but the session must not).
  const sessionRef = useRef<{ skill: PracticeSkill; level: PracticeLevel } | null>(null);
  // Prompts shown this session, so refills don't repeat them.
  const seenPromptsRef = useRef<string[]>([]);
  // Bumped on every start/exit so a late fetch from an old session is ignored.
  const runIdRef = useRef(0);
  const prefetchingRef = useRef(false);

  // Redirect unauthenticated users, same pattern as the other signed-in pages.
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/practice" } });
    }
  }, [authLoading, navigate, user]);

  // Load learning skills + progress once the user is known.
  const refreshData = useCallback(async () => {
    if (!user) return;
    const [skills, prog] = await Promise.all([loadLearningSkills(user.id), loadPracticeProgress()]);
    setLearningSkills(skills);
    setProgress(prog);
    // Resolve names for any skill that has progress but isn't in the learning
    // list (practiced via search), so the progress list can label every row.
    const known = new Set(skills.map((s) => s.id));
    const missing = Array.from(prog.values())
      .map((p) => p.skillId)
      .filter((id) => !known.has(id));
    const names = new Map(skills.map((s) => [s.id, s.name] as const));
    if (missing.length > 0) {
      const fetched = await loadSkillNames(missing);
      for (const [id, name] of fetched) names.set(id, name);
    }
    setSkillNames(names);
    // Default the picker to the first learning skill when nothing is chosen yet.
    setSelected((prev) => prev ?? skills[0] ?? null);
  }, [user]);

  useEffect(() => {
    let active = true;
    if (!user) return;
    setDataLoading(true);
    void refreshData().finally(() => {
      if (active) setDataLoading(false);
    });
    return () => {
      active = false;
    };
  }, [user, refreshData]);

  // Pull a fresh batch, skipping anything already seen this session.
  const fetchBatch = useCallback(
    async (skill: PracticeSkill, lvl: PracticeLevel): Promise<PracticeProblem[]> => {
      const set = await generatePracticeSet(skill.id, lvl, BATCH_SIZE, seenPromptsRef.current);
      const seen = new Set(seenPromptsRef.current.map((p) => p.toLowerCase()));
      return set.problems.filter((p) => !seen.has(p.prompt.trim().toLowerCase()));
    },
    [],
  );

  const start = useCallback(async () => {
    if (!selected) return;
    const runId = ++runIdRef.current;
    sessionRef.current = { skill: selected, level };
    seenPromptsRef.current = [];
    setPhase("loading");
    setErrorMessage("");
    setSessionSolved(0);
    setSessionAttempted(0);
    setStreak(0);
    setCurrent(null);
    setQueue([]);

    try {
      const problems = await fetchBatch(selected, level);
      if (runId !== runIdRef.current) return;
      if (problems.length === 0) {
        throw new PracticeError("Couldn't build problems for that skill. Try another difficulty.");
      }
      const [first, ...rest] = problems;
      seenPromptsRef.current.push(first.prompt);
      setCurrent(first);
      setQueue(rest);
      setQuestionNumber(1);
      setPhase("solving");
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setErrorMessage(
        error instanceof Error ? error.message : "Couldn't start practice. Please try again.",
      );
      setPhase("error");
    }
  }, [selected, level, fetchBatch]);

  // Top up the queue in the background so "Next" never waits.
  const prefetch = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || prefetchingRef.current) return;
    prefetchingRef.current = true;
    const runId = runIdRef.current;
    try {
      const more = await fetchBatch(session.skill, session.level);
      if (runId !== runIdRef.current || more.length === 0) return;
      setQueue((prev) => {
        const have = new Set(prev.map((p) => p.prompt.toLowerCase()));
        return [...prev, ...more.filter((p) => !have.has(p.prompt.toLowerCase()))];
      });
    } catch {
      // A failed prefetch is silent; the synchronous fetch in advance() will
      // surface any real problem if the queue actually empties.
    } finally {
      prefetchingRef.current = false;
    }
  }, [fetchBatch]);

  const resolveAnswer = useCallback((correct: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    setSessionAttempted((n) => n + 1);
    setSessionSolved((n) => (correct ? n + 1 : n));
    setStreak((s) => (correct ? s + 1 : 0));
    // Fire-and-forget: a failed write must never interrupt the run.
    void recordPracticeAnswer(session.skill.id, session.level, correct);
  }, []);

  const advance = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    if (queue.length > 0) {
      const [next, ...rest] = queue;
      seenPromptsRef.current.push(next.prompt);
      setCurrent(next);
      setQueue(rest);
      setQuestionNumber((n) => n + 1);
      if (rest.length <= PREFETCH_AT) void prefetch();
      return;
    }

    // Queue empty and no prefetch landed, so fetch synchronously.
    const runId = runIdRef.current;
    setAdvancing(true);
    try {
      const problems = await fetchBatch(session.skill, session.level);
      if (runId !== runIdRef.current) return;
      if (problems.length === 0) {
        throw new PracticeError("Ran out of fresh problems. Try another difficulty.");
      }
      const [next, ...rest] = problems;
      seenPromptsRef.current.push(next.prompt);
      setCurrent(next);
      setQueue(rest);
      setQuestionNumber((n) => n + 1);
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : "Couldn't load the next problem.");
      setPhase("error");
    } finally {
      setAdvancing(false);
    }
  }, [queue, prefetch, fetchBatch]);

  const exitSession = useCallback(() => {
    runIdRef.current++;
    sessionRef.current = null;
    seenPromptsRef.current = [];
    setPhase("picker");
    setCurrent(null);
    setQueue([]);
    // Reload counters so the picker's progress reflects what this session added.
    void refreshData();
  }, [refreshData]);

  const totals = useMemo(() => aggregate(progress), [progress]);

  // Progress rows grouped by skill for the "Your progress" list.
  const progressBySkill = useMemo(() => {
    const bySkill = new Map<
      string,
      { name: string; levels: Map<PracticeLevel, PracticeProgress> }
    >();
    for (const row of progress.values()) {
      if (row.solved === 0 && row.attempted === 0) continue;
      const name = skillNames.get(row.skillId) ?? "Unknown skill";
      const entry = bySkill.get(row.skillId) ?? { name, levels: new Map() };
      entry.levels.set(row.level, row);
      bySkill.set(row.skillId, entry);
    }
    return Array.from(bySkill.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [progress, skillNames]);

  if (authLoading || !user || dataLoading) {
    return <PageLoading variant="list" />;
  }

  const session = sessionRef.current;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6 animate-in fade-in duration-150">
        {phase === "solving" || phase === "loading" ? (
          <>
            {session && (
              <PracticeStatsBar
                skillName={session.skill.name}
                level={session.level}
                solved={sessionSolved}
                attempted={sessionAttempted}
                streak={streak}
                onExit={exitSession}
              />
            )}

            {phase === "loading" && (
              <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="h-7 w-7 animate-spin text-brand-cyan" />
                <p className="text-sm text-muted-foreground">Building your practice set…</p>
              </div>
            )}

            {phase === "solving" && current && (
              <div className="relative">
                <PracticeProblemCard
                  key={`${questionNumber}:${current.prompt}`}
                  problem={current}
                  questionNumber={questionNumber}
                  onResolved={resolveAnswer}
                  onNext={() => void advance()}
                />
                {advancing && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-3xl bg-background/60 backdrop-blur-sm">
                    <Loader2 className="h-6 w-6 animate-spin text-brand-cyan" />
                  </div>
                )}
              </div>
            )}
          </>
        ) : phase === "error" ? (
          <div className="rounded-3xl border border-border glass-strong p-8 text-center">
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            <div className="mt-5 flex justify-center gap-2">
              <Button variant="ghost" size="sm" onClick={exitSession}>
                Back
              </Button>
              <Button variant="hero" size="sm" onClick={() => void start()} disabled={!selected}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Hero + aggregate stats */}
            <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
              <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
              <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
              <div className="relative p-6 md:p-8">
                <div className="flex items-start gap-4">
                  <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 ring-1 ring-brand-purple/25">
                    <Target className="h-5 w-5 text-brand-purple" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                      <span className="gradient-brand-text">Practice</span>
                    </h1>
                    <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                      Pick a skill and a difficulty, then work through short questions with instant
                      feedback. Go at your own pace, there's no timer running.
                    </p>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-3 gap-3">
                  <HeroStat label="Solved" value={String(totals.solved)} accent />
                  <HeroStat label="Attempts" value={String(totals.attempted)} />
                  <HeroStat label="Accuracy" value={`${totals.accuracy}%`} />
                </div>
              </div>
            </section>

            {/* Picker */}
            <section className="rounded-3xl border border-border glass p-5 md:p-6">
              <PracticeSkillPicker
                learningSkills={learningSkills}
                selected={selected}
                onSelect={setSelected}
                level={level}
                onLevelChange={setLevel}
                onStart={() => void start()}
                starting={false}
              />
            </section>

            {/* Your progress */}
            {progressBySkill.length > 0 && (
              <section className="rounded-3xl border border-border glass p-5 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand-purple" />
                  <h2 className="text-sm font-semibold">Your progress</h2>
                </div>
                <div className="space-y-2.5">
                  {progressBySkill.map((entry) => (
                    <div
                      key={entry.name}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-border bg-muted/50 px-4 py-3"
                    >
                      <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
                      <div className="flex flex-wrap items-center gap-2">
                        {PRACTICE_LEVELS.map((lvl) => {
                          const row = entry.levels.get(lvl);
                          if (!row) return null;
                          const tone = DIFFICULTY_TONE[lvl];
                          return (
                            <span
                              key={lvl}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                                tone.chip,
                              )}
                            >
                              <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
                              {DIFFICULTY_LABEL[lvl]}
                              <span className="font-semibold tabular-nums">
                                {row.solved}/{row.attempted}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/60 px-3 py-3 text-center">
      <div
        className={cn(
          "text-xl font-bold leading-none tabular-nums md:text-2xl",
          accent && "text-brand-cyan",
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}
