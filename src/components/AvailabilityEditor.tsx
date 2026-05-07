import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock,
  Copy,
  GraduationCap,
  Loader2,
  Plus,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Mode = "learn" | "teach";

type LocalWindow = {
  day: number; // 0=Sun..6=Sat in viewer's local TZ
  startMin: number; // minutes since local midnight
  endMin: number;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MODE_CONTENT = {
  teach: {
    label: "Teach",
    title: "Teaching hours",
    subtitle: "The times you are happy to teach others.",
    copyLabel: "Copy from learning",
    icon: BookOpen,
  },
  learn: {
    label: "Learn",
    title: "Learning hours",
    subtitle: "The times you are available to learn from others.",
    copyLabel: "Copy from teaching",
    icon: GraduationCap,
  },
} satisfies Record<
  Mode,
  {
    label: string;
    title: string;
    subtitle: string;
    copyLabel: string;
    icon: typeof BookOpen;
  }
>;

function makeTimeOptions(includeMidnightEnd = false) {
  const out: { value: number; label: string }[] = [];
  const max = includeMidnightEnd ? 24 : 23.5;
  for (let mins = includeMidnightEnd ? 30 : 0; mins <= max * 60; mins += 30) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const period = h < 12 ? "AM" : "PM";
    const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    out.push({
      value: mins,
      label: `${hh}:${String(m).padStart(2, "0")} ${period}`,
    });
  }
  return out;
}

const START_TIME_OPTIONS = makeTimeOptions(false);
const END_TIME_OPTIONS = makeTimeOptions(true);

const PRESETS: { label: string; windows: LocalWindow[] }[] = [
  {
    label: "Weekday evenings",
    windows: [1, 2, 3, 4, 5].map((d) => ({ day: d, startMin: 19 * 60, endMin: 22 * 60 })),
  },
  {
    label: "Weekend afternoons",
    windows: [0, 6].map((d) => ({ day: d, startMin: 14 * 60, endMin: 18 * 60 })),
  },
  {
    label: "Mornings before work",
    windows: [1, 2, 3, 4, 5].map((d) => ({ day: d, startMin: 6 * 60, endMin: 8 * 60 })),
  },
  {
    label: "Daily evenings",
    windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, startMin: 19 * 60, endMin: 21 * 60 })),
  },
];

function getBrowserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function localToUtc(localDay: number, localMinutes: number) {
  const ref = new Date(
    2024,
    0,
    7 + localDay,
    Math.floor(localMinutes / 60),
    localMinutes % 60,
    0,
    0,
  );
  return {
    day: ref.getUTCDay(),
    minute: ref.getUTCHours() * 60 + ref.getUTCMinutes(),
  };
}

function utcToLocal(utcDay: number, utcMinutes: number) {
  const ref = new Date(Date.UTC(2024, 0, 7 + utcDay, Math.floor(utcMinutes / 60), utcMinutes % 60));
  return {
    day: ref.getDay(),
    minute: ref.getHours() * 60 + ref.getMinutes(),
  };
}

function formatTime(mins: number) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const period = h < 12 ? "AM" : "PM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh}:${String(m).padStart(2, "0")} ${period}`;
}

function formatHours(hours: number) {
  if (hours === 0) return "0h";
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${hours.toFixed(1)}h`;
}

function cloneWindows(windows: LocalWindow[]) {
  return windows.map((window) => ({ ...window }));
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "20" || e.code === "ABORT_ERR") return true;
  if (typeof e.message === "string" && /aborted|abort/i.test(e.message)) return true;
  return false;
}

async function loadMode(mode: Mode, signal?: AbortSignal): Promise<LocalWindow[]> {
  let q = supabase.rpc("get_my_availability", { p_mode: mode });
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) {
    if (signal?.aborted || isAbortError(error)) return [];
    toast.error(error.message);
    return [];
  }
  return (data ?? []).map((row) => {
    const start = utcToLocal(row.day_of_week, row.start_minute);
    const end = utcToLocal(row.day_of_week, row.end_minute);
    return { day: start.day, startMin: start.minute, endMin: end.minute };
  });
}

async function saveMode(mode: Mode, windows: LocalWindow[]) {
  const utcWindows = windows.map((w) => {
    const start = localToUtc(w.day, w.startMin);
    const end = localToUtc(w.day, w.endMin);
    return {
      day: start.day,
      start: start.minute,
      end: end.day === start.day ? end.minute : 1440,
    };
  });
  return supabase.rpc("set_my_availability", {
    p_mode: mode,
    p_windows: utcWindows,
    p_tz: getBrowserTz(),
  });
}

type ModePanelProps = {
  mode: Mode;
  windows: LocalWindow[];
  setWindows: React.Dispatch<React.SetStateAction<LocalWindow[]>>;
  otherWindows: LocalWindow[];
  dirty: boolean;
  setDirty: (v: boolean) => void;
  saving: boolean;
  onSave: () => void;
  compact: boolean;
};

function ModePanel({
  mode,
  windows,
  setWindows,
  otherWindows,
  dirty,
  setDirty,
  saving,
  onSave,
  compact,
}: ModePanelProps) {
  const modeContent = MODE_CONTENT[mode];
  const ModeIcon = modeContent.icon;

  const groupedByDay = useMemo(() => {
    const map: LocalWindow[][] = [[], [], [], [], [], [], []];
    for (const w of windows) {
      map[w.day].push(w);
    }
    map.forEach((arr) => arr.sort((a, b) => a.startMin - b.startMin));
    return map;
  }, [windows]);

  const stats = useMemo(() => {
    const activeDays = groupedByDay.filter((day) => day.length > 0).length;
    const totalHours = windows.reduce(
      (sum, window) => sum + Math.max(0, window.endMin - window.startMin) / 60,
      0,
    );
    const invalidCount = windows.filter((window) => window.endMin <= window.startMin).length;
    return { activeDays, totalHours, invalidCount };
  }, [groupedByDay, windows]);

  const markDirty = () => setDirty(true);

  const addWindow = (day: number) => {
    const existing = groupedByDay[day];
    const last = existing.at(-1);
    const startMin = last ? Math.min(last.endMin + 30, 22 * 60) : 19 * 60;
    const endMin = Math.min(startMin + 2 * 60, 24 * 60);
    setWindows((prev) => [...prev, { day, startMin, endMin }]);
    markDirty();
  };

  const removeWindow = (day: number, index: number) => {
    setWindows((prev) => {
      let dayCount = -1;
      return prev.filter((w) => {
        if (w.day !== day) return true;
        dayCount += 1;
        return dayCount !== index;
      });
    });
    markDirty();
  };

  const updateWindow = (day: number, index: number, patch: Partial<LocalWindow>) => {
    setWindows((prev) => {
      let dayCount = -1;
      return prev.map((w) => {
        if (w.day !== day) return w;
        dayCount += 1;
        if (dayCount !== index) return w;

        const next = { ...w, ...patch };
        if (patch.startMin !== undefined && next.startMin >= next.endMin) {
          next.endMin = Math.min(next.startMin + 60, 24 * 60);
        }
        if (patch.endMin !== undefined && next.endMin <= next.startMin) {
          next.startMin = Math.max(0, next.endMin - 60);
        }
        return next;
      });
    });
    markDirty();
  };

  const applyPreset = (preset: LocalWindow[]) => {
    setWindows(cloneWindows(preset));
    markDirty();
  };

  const copyFromOther = () => {
    setWindows(cloneWindows(otherWindows));
    markDirty();
  };

  const canSave = dirty && !saving && stats.invalidCount === 0;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/70 bg-background/60 p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ModeIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">{modeContent.title}</h3>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium",
                    dirty
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-300"
                      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                  )}
                >
                  {dirty ? "Unsaved" : "Saved"}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{modeContent.subtitle}</p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {getBrowserTz()}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:min-w-[330px]">
            <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2">
              <p className="text-[11px] font-medium uppercase text-muted-foreground">Windows</p>
              <p className="mt-1 text-lg font-semibold">{windows.length}</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2">
              <p className="text-[11px] font-medium uppercase text-muted-foreground">Days</p>
              <p className="mt-1 text-lg font-semibold">{stats.activeDays}</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2">
              <p className="text-[11px] font-medium uppercase text-muted-foreground">Weekly</p>
              <p className="mt-1 text-lg font-semibold">{formatHours(stats.totalHours)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/25 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          Quick sets
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(p.windows)}
              className="h-9 rounded-full bg-background/70 px-3 text-xs"
            >
              {p.label}
            </Button>
          ))}
          {otherWindows.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyFromOther}
              className="h-9 rounded-full border-primary/30 bg-primary/10 px-3 text-xs text-primary hover:bg-primary/15 hover:text-primary"
            >
              <Copy className="h-3.5 w-3.5" />
              {modeContent.copyLabel}
            </Button>
          )}
        </div>
      </div>

      {stats.invalidCount > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Fix the highlighted time window before saving.</p>
        </div>
      )}

      <div
        className={cn(
          "grid gap-3",
          compact ? "sm:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4",
        )}
      >
        {DAY_NAMES.map((dayName, d) => {
          const dayWindows = groupedByDay[d];
          const isActive = dayWindows.length > 0;

          return (
            <section
              key={d}
              className={cn(
                "flex min-h-[164px] flex-col rounded-2xl border bg-card/80 p-3 shadow-sm transition-colors",
                isActive ? "border-primary/25" : "border-border/70",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-foreground">{dayName}</div>
                  <div className="text-[11px] font-medium uppercase text-muted-foreground">
                    {DAY_FULL[d]}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => addWindow(d)}
                  className="h-8 w-8 rounded-full"
                  title={`Add ${DAY_FULL[d]} time`}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <div className="mt-3 flex flex-1 flex-col gap-2">
                {dayWindows.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border/80 bg-background/45 px-3 py-5 text-sm text-muted-foreground">
                    Off
                  </div>
                ) : (
                  dayWindows.map((w, idx) => {
                    const invalid = w.endMin <= w.startMin;
                    return (
                      <div
                        key={idx}
                        className={cn(
                          "rounded-xl border bg-background/75 p-2",
                          invalid ? "border-destructive/50" : "border-border/70",
                        )}
                      >
                        <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                          <Select
                            value={String(w.startMin)}
                            onValueChange={(value) =>
                              updateWindow(d, idx, { startMin: Number(value) })
                            }
                          >
                            <SelectTrigger className="h-9 min-w-0 rounded-lg border-border/70 bg-card px-2 text-xs shadow-none">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-64 rounded-xl">
                              {START_TIME_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={String(opt.value)}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <span className="text-xs text-muted-foreground">to</span>

                          <Select
                            value={String(w.endMin)}
                            onValueChange={(value) =>
                              updateWindow(d, idx, { endMin: Number(value) })
                            }
                          >
                            <SelectTrigger className="h-9 min-w-0 rounded-lg border-border/70 bg-card px-2 text-xs shadow-none">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-64 rounded-xl">
                              {END_TIME_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={String(opt.value)}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeWindow(d, idx)}
                            className="h-8 w-8 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="Remove time"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {invalid && (
                          <p className="mt-1.5 text-xs text-destructive">End must be later.</p>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/60 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {windows.length > 0
            ? `${windows.length} window${windows.length === 1 ? "" : "s"} across ${
                stats.activeDays
              } day${stats.activeDays === 1 ? "" : "s"}.`
            : "No windows set yet."}
        </p>
        <Button
          variant="hero"
          onClick={onSave}
          disabled={!canSave}
          className="h-11 min-w-32 rounded-full"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : dirty ? (
            <Save className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {saving ? "Saving" : dirty ? "Save changes" : "Saved"}
        </Button>
      </div>

      {!compact && windows.length > 0 && (
        <details className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">View as text</summary>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {DAY_NAMES.map((d, idx) =>
              groupedByDay[idx].length === 0 ? null : (
                <li key={idx} className="rounded-xl bg-muted/40 px-3 py-2">
                  <span className="font-medium">{d}:</span>{" "}
                  {groupedByDay[idx].map((w, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      {formatTime(w.startMin)} to {formatTime(w.endMin)}
                    </span>
                  ))}
                </li>
              ),
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AvailabilityEditor({
  defaultMode = "teach",
  compact = false,
}: {
  defaultMode?: Mode;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [teachWindows, setTeachWindows] = useState<LocalWindow[]>([]);
  const [learnWindows, setLearnWindows] = useState<LocalWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState<Mode | null>(null);
  const [dirty, setDirty] = useState<{ teach: boolean; learn: boolean }>({
    teach: false,
    learn: false,
  });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      const [t, l] = await Promise.all([
        loadMode("teach", controller.signal),
        loadMode("learn", controller.signal),
      ]);
      if (!alive) return;
      setTeachWindows(t);
      setLearnWindows(l);
      setLoading(false);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  const saveFor = async (m: Mode) => {
    const ws = m === "teach" ? teachWindows : learnWindows;
    for (const w of ws) {
      if (w.endMin <= w.startMin) {
        toast.error("Each window's end must be after its start");
        return;
      }
    }
    setSavingMode(m);
    const { error } = await saveMode(m, ws);
    setSavingMode(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`${m === "teach" ? "Teaching" : "Learning"} availability saved`);
    setDirty((d) => ({ ...d, [m]: false }));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading availability...
      </div>
    );
  }

  const firstTimeHint = teachWindows.length === 0 && learnWindows.length === 0 && (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Start simple:</span> add one or two usual
      windows, then refine them later.
    </div>
  );

  return (
    <div className="space-y-5">
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="space-y-5">
        <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/55 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="grid h-11 w-full grid-cols-2 rounded-full bg-muted/70 p-1 sm:w-[320px]">
            <TabsTrigger value="teach" className="rounded-full">
              <BookOpen className="h-4 w-4" />
              Teach
            </TabsTrigger>
            <TabsTrigger value="learn" className="rounded-full">
              <GraduationCap className="h-4 w-4" />
              Learn
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground sm:justify-end">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              Local time
            </span>
            <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
              {getBrowserTz()}
            </span>
          </div>
        </div>

        <TabsContent value="teach" className="m-0">
          <ModePanel
            mode="teach"
            windows={teachWindows}
            setWindows={setTeachWindows}
            otherWindows={learnWindows}
            dirty={dirty.teach}
            setDirty={(v) => setDirty((d) => ({ ...d, teach: v }))}
            saving={savingMode === "teach"}
            onSave={() => saveFor("teach")}
            compact={compact}
          />
        </TabsContent>

        <TabsContent value="learn" className="m-0">
          <ModePanel
            mode="learn"
            windows={learnWindows}
            setWindows={setLearnWindows}
            otherWindows={teachWindows}
            dirty={dirty.learn}
            setDirty={(v) => setDirty((d) => ({ ...d, learn: v }))}
            saving={savingMode === "learn"}
            onSave={() => saveFor("learn")}
            compact={compact}
          />
        </TabsContent>
      </Tabs>

      {firstTimeHint}
    </div>
  );
}
