import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { AlertCircle, BookOpen, GraduationCap, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Mode = "learn" | "teach";

type LocalWindow = {
  day: number; // 0=Sun..6=Sat in viewer's local TZ
  startMin: number; // minutes since local midnight
  endMin: number;
};

const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_OPTIONS = DAY_FULL.map((label, value) => ({ value, label }));

const MODE_CONTENT = {
  teach: {
    label: "Teach",
    title: "Teaching hours",
    subtitle: "When learners can book you.",
    copyLabel: "Copy from learning",
    icon: BookOpen,
  },
  learn: {
    label: "Learn",
    title: "Learning hours",
    subtitle: "When you're free to learn.",
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
  {
    label: "Weekend mornings",
    windows: [0, 6].map((d) => ({ day: d, startMin: 8 * 60, endMin: 12 * 60 })),
  },
  {
    label: "Lunch breaks",
    windows: [1, 2, 3, 4, 5].map((d) => ({ day: d, startMin: 12 * 60, endMin: 13 * 60 })),
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
  dirty: boolean;
  setDirty: (v: boolean) => void;
};

function ModePanel({ mode, windows, setWindows, dirty, setDirty }: ModePanelProps) {
  const modeContent = MODE_CONTENT[mode];
  const ModeIcon = modeContent.icon;

  const stats = useMemo(() => {
    const invalidCount = windows.filter((window) => window.endMin <= window.startMin).length;
    return { invalidCount };
  }, [windows]);

  const markDirty = () => setDirty(true);

  // The week is shown as seven fixed rows (Sun–Sat). The model keeps one
  // window per day, so each row maps to at most one window — enabling a day
  // appends its window (default 6 AM–10 PM), disabling removes it. This keeps
  // the layout predictable: no day dropdown, no "add row" guesswork.
  const windowByDay = useMemo(() => {
    const map = new Map<number, LocalWindow>();
    for (const w of windows) map.set(w.day, w);
    return map;
  }, [windows]);

  const enableDay = (day: number) => {
    if (windowByDay.has(day)) return;
    setWindows((prev) => [...prev, { day, startMin: 6 * 60, endMin: 22 * 60 }]);
    markDirty();
  };

  const disableDay = (day: number) => {
    setWindows((prev) => prev.filter((w) => w.day !== day));
    markDirty();
  };

  const updateDay = (day: number, patch: Partial<LocalWindow>) => {
    setWindows((prev) =>
      prev.map((w) => {
        if (w.day !== day) return w;
        const next = { ...w, ...patch };
        if (patch.startMin !== undefined && next.startMin >= next.endMin) {
          next.endMin = Math.min(next.startMin + 60, 24 * 60);
        }
        if (patch.endMin !== undefined && next.endMin <= next.startMin) {
          next.startMin = Math.max(0, next.endMin - 60);
        }
        return next;
      }),
    );
    markDirty();
  };

  const applyPreset = (preset: LocalWindow[]) => {
    setWindows(cloneWindows(preset));
    markDirty();
  };

  // Days the learner sees as bookable — distinct days, since the model keeps
  // one window per day. Counting raw windows could overcount past seven.
  const activeDays = windowByDay.size;

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-card/60 p-4 shadow-sm">
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
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-muted/25 p-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          Quick sets
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(p.windows)}
              className="h-9 w-full rounded-full bg-background/70 px-3 text-xs"
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {stats.invalidCount > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Fix the highlighted time window before saving.</p>
        </div>
      )}

      <div className="flex flex-col">
        {DAY_OPTIONS.map((opt, rowIdx) => {
          const w = windowByDay.get(opt.value);
          const active = Boolean(w);
          const invalid = w ? w.endMin <= w.startMin : false;
          return (
            <div
              key={opt.value}
              className={cn(
                "flex items-center gap-3 py-2",
                rowIdx > 0 && "border-t border-border/50",
              )}
            >
              <button
                type="button"
                onClick={() => (active ? disableDay(opt.value) : enableDay(opt.value))}
                className={cn(
                  "flex w-14 shrink-0 items-center gap-1.5 text-sm font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                title={active ? `Turn off ${opt.label}` : `Turn on ${opt.label}`}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    active ? "bg-primary" : "bg-muted-foreground/30",
                  )}
                />
                {DAY_SHORT[opt.value]}
              </button>

              {active && w ? (
                <div className="flex flex-1 items-center gap-1.5">
                  <Select
                    value={String(w.startMin)}
                    onValueChange={(value) => updateDay(opt.value, { startMin: Number(value) })}
                  >
                    <SelectTrigger
                      className={cn(
                        "h-9 min-w-0 flex-1 rounded-lg bg-card px-2.5 text-sm shadow-none",
                        invalid ? "border-destructive/60" : "border-border/70",
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64 rounded-xl">
                      {START_TIME_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={String(o.value)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <span className="shrink-0 text-xs text-muted-foreground">to</span>

                  <Select
                    value={String(w.endMin)}
                    onValueChange={(value) => updateDay(opt.value, { endMin: Number(value) })}
                  >
                    <SelectTrigger
                      className={cn(
                        "h-9 min-w-0 flex-1 rounded-lg bg-card px-2.5 text-sm shadow-none",
                        invalid ? "border-destructive/60" : "border-border/70",
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64 rounded-xl">
                      {END_TIME_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={String(o.value)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => disableDay(opt.value)}
                    className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title={`Remove ${opt.label}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => enableDay(opt.value)}
                  className="flex flex-1 items-center gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add time
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-auto rounded-2xl border border-border/70 bg-background/60 p-3">
        <p className="text-sm text-muted-foreground">
          {activeDays > 0
            ? `Available ${activeDays} day${activeDays === 1 ? "" : "s"} a week.`
            : "No days turned on yet."}
        </p>
      </div>
    </section>
  );
}

export type AvailabilityEditorHandle = {
  /** Validate and persist both teaching and learning windows. Returns true on success. */
  save: () => Promise<boolean>;
};

export const AvailabilityEditor = forwardRef<
  AvailabilityEditorHandle,
  {
    defaultMode?: Mode;
    compact?: boolean;
    /** Hide the per-mode "Save changes" button (the parent drives saving via ref). */
    hideSaveButton?: boolean;
  }
>(function AvailabilityEditor({ compact = false, hideSaveButton = false }, ref) {
  const [teachWindows, setTeachWindows] = useState<LocalWindow[]>([]);
  const [learnWindows, setLearnWindows] = useState<LocalWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  // One button saves both teaching and learning windows together.
  const saveAll = async () => {
    for (const ws of [teachWindows, learnWindows]) {
      for (const w of ws) {
        if (w.endMin <= w.startMin) {
          toast.error("Fix the highlighted time window before saving.");
          return;
        }
      }
    }
    setSaving(true);
    const [teachRes, learnRes] = await Promise.all([
      saveMode("teach", teachWindows),
      saveMode("learn", learnWindows),
    ]);
    setSaving(false);
    const error = teachRes.error || learnRes.error;
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Availability saved");
    setDirty({ teach: false, learn: false });
  };

  useImperativeHandle(
    ref,
    () => ({
      async save() {
        for (const ws of [teachWindows, learnWindows]) {
          for (const w of ws) {
            if (w.endMin <= w.startMin) {
              toast.error("Each availability window's end must be after its start");
              return false;
            }
          }
        }
        const [teachRes, learnRes] = await Promise.all([
          saveMode("teach", teachWindows),
          saveMode("learn", learnWindows),
        ]);
        const error = teachRes.error || learnRes.error;
        if (error) {
          toast.error(error.message);
          return false;
        }
        setDirty({ teach: false, learn: false });
        return true;
      },
    }),
    [teachWindows, learnWindows],
  );

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

  const anyDirty = dirty.teach || dirty.learn;
  const hasInvalid = [...teachWindows, ...learnWindows].some((w) => w.endMin <= w.startMin);

  return (
    <div className="space-y-5">
      {firstTimeHint}

      <div className={cn("grid items-stretch gap-5", compact ? "" : "lg:grid-cols-2")}>
        <ModePanel
          mode="teach"
          windows={teachWindows}
          setWindows={setTeachWindows}
          dirty={dirty.teach}
          setDirty={(v) => setDirty((d) => ({ ...d, teach: v }))}
        />
        <ModePanel
          mode="learn"
          windows={learnWindows}
          setWindows={setLearnWindows}
          dirty={dirty.learn}
          setDirty={(v) => setDirty((d) => ({ ...d, learn: v }))}
        />
      </div>

      {!hideSaveButton && (
        <div className="flex justify-end">
          <Button
            variant="hero"
            onClick={saveAll}
            disabled={!anyDirty || saving || hasInvalid}
            className="h-11 min-w-32 rounded-full"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving" : anyDirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      )}
    </div>
  );
});
