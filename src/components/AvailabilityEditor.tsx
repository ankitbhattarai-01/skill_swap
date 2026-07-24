import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { AlertCircle, BookOpen, GraduationCap, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { invalidateAiSuggestionsCache } from "@/lib/ai-suggestions";
import { useAuth } from "@/lib/auth-context";
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
    label: "Every day",
    windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      day: d,
      startMin: 6 * 60,
      endMin: 23 * 60 + 30,
    })),
  },
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

// Both modes come back in a single round-trip: get_my_availability(NULL)
// returns every window for the caller, which we partition by mode here. This
// is deliberately one call, not one per mode — the editor always needs both,
// and two sequential-feeling RPCs made the "Loading your schedule…" spinner
// linger for the sum of two network round-trips instead of one.
type Availability = { teach: LocalWindow[]; learn: LocalWindow[] };

// Raw fetch. Throws on a real error (and on abort, whose name/code lets the
// caller tell it apart); the caller decides how to surface it.
async function fetchAvailability(signal?: AbortSignal): Promise<Availability> {
  let q = supabase.rpc("get_my_availability", { p_mode: null });
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) throw error;
  const result: Availability = { teach: [], learn: [] };
  for (const row of data ?? []) {
    const start = utcToLocal(row.day_of_week, row.start_minute);
    const end = utcToLocal(row.day_of_week, row.end_minute);
    const window = { day: start.day, startMin: start.minute, endMin: end.minute };
    if (row.mode === "teach") result.teach.push(window);
    else if (row.mode === "learn") result.learn.push(window);
  }
  return result;
}

// Warm cache that bridges a parent page's prefetch to this editor's mount.
// The Profile page sits above a tall layout, so without prefetching the editor
// couldn't even start its RPC until the whole page had painted — the schedule
// then arrived a full round-trip late. `prefetchAvailability(userId)` lets the
// page kick the fetch off in parallel with its own data; by the time the editor
// mounts the result is already cached (or in flight and shared). Keyed by user
// so a different account never reads a previous one's schedule; best-effort and
// per-session — a successful save refreshes it, failures leave it cold.
let availabilityCache: { userId: string; data: Availability } | null = null;
let availabilityInflight: { userId: string; promise: Promise<Availability> } | null = null;

function rememberAvailability(userId: string, data: Availability) {
  availabilityCache = {
    userId,
    data: { teach: cloneWindows(data.teach), learn: cloneWindows(data.learn) },
  };
}

// Starts — or joins — the single fetch for this user. Both entry points below
// route through here, so whichever fires first owns the request and the other
// shares it. That matters now that the profile page paints from a snapshot:
// the editor mounts in the same frame as the page, and child effects run before
// parent effects, so the editor's own load would otherwise beat the page's
// prefetch to the punch and the two would issue duplicate RPCs.
//
// Deliberately not tied to any caller's AbortSignal. The payload is tiny, a
// result landing after unmount still warms the cache for the next visit, and a
// shared request carrying one mount's abort would strand every other sharer.
function startAvailabilityFetch(userId: string): Promise<Availability> {
  if (availabilityInflight?.userId === userId) return availabilityInflight.promise;
  const promise = fetchAvailability()
    .then((res) => {
      rememberAvailability(userId, res);
      return res;
    })
    .finally(() => {
      if (availabilityInflight?.userId === userId) availabilityInflight = null;
    });
  // Handle rejection here too so a warmer whose editor never mounts can't
  // surface as an unhandled promise rejection.
  promise.catch(() => {});
  availabilityInflight = { userId, promise };
  return promise;
}

// Fire-and-forget warmer. A warmed result is reused; failures/aborts are
// swallowed and leave the cache cold so the editor's own load retries.
export function prefetchAvailability(userId: string | null | undefined): void {
  if (!userId) return;
  if (availabilityCache?.userId === userId) return;
  void startAvailabilityFetch(userId);
}

// Used by the editor on mount. Prefers the warm cache, then the shared
// in-flight request, and only issues its own when there is no user id to key
// either on.
async function loadAvailability(
  userId: string | undefined,
  signal?: AbortSignal,
): Promise<Availability | "aborted"> {
  if (userId && availabilityCache?.userId === userId) return availabilityCache.data;
  try {
    return userId ? await startAvailabilityFetch(userId) : await fetchAvailability(signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return "aborted";
    toast.error(error instanceof Error ? error.message : "Could not load your schedule");
    return { teach: [], learn: [] };
  }
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
          Quick picks
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
          <p>Check the highlighted day. The end time needs to come after the start time.</p>
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
            ? `You're available ${activeDays} day${activeDays === 1 ? "" : "s"} a week.`
            : "No days added yet. Tap a day above to get started."}
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
    /** Notifies the parent of the current teaching/learning window counts so it can gate progress. */
    onWindowsChange?: (counts: { teach: number; learn: number }) => void;
  }
>(function AvailabilityEditor({ compact = false, hideSaveButton = false, onWindowsChange }, ref) {
  const { user } = useAuth();
  const userId = user?.id;
  // Seed straight from the warm cache when it's already this user's schedule
  // (a same-session revisit, or a parent prefetch that finished before paint)
  // so there's no "Loading your schedule…" flash at all.
  const cached = userId && availabilityCache?.userId === userId ? availabilityCache.data : null;
  const [teachWindows, setTeachWindows] = useState<LocalWindow[]>(() =>
    cloneWindows(cached?.teach ?? []),
  );
  const [learnWindows, setLearnWindows] = useState<LocalWindow[]>(() =>
    cloneWindows(cached?.learn ?? []),
  );
  const [loading, setLoading] = useState(!cached);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState<{ teach: boolean; learn: boolean }>({
    teach: false,
    learn: false,
  });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const res = await loadAvailability(userId, controller.signal);
      if (!alive || res === "aborted") return;
      setTeachWindows(cloneWindows(res.teach));
      setLearnWindows(cloneWindows(res.learn));
      setLoading(false);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [userId]);

  useEffect(() => {
    onWindowsChange?.({ teach: teachWindows.length, learn: learnWindows.length });
  }, [teachWindows.length, learnWindows.length, onWindowsChange]);

  // One button saves both teaching and learning windows together.
  const saveAll = async () => {
    for (const ws of [teachWindows, learnWindows]) {
      for (const w of ws) {
        if (w.endMin <= w.startMin) {
          toast.error(
            "Check the highlighted day. The end time needs to come after the start time.",
          );
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
    // Keep the warm cache in step with what was just persisted so a revisit
    // this session shows the new schedule without another round-trip.
    if (userId) rememberAvailability(userId, { teach: teachWindows, learn: learnWindows });
    // Availability is a suggestions-engine signal (completion checklist +
    // teach-hours nudge) — drop the cached tiles so they regenerate.
    void invalidateAiSuggestionsCache();
  };

  useImperativeHandle(
    ref,
    () => ({
      async save() {
        for (const ws of [teachWindows, learnWindows]) {
          for (const w of ws) {
            if (w.endMin <= w.startMin) {
              toast.error(
                "Check the highlighted day. The end time needs to come after the start time.",
              );
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
        if (userId) rememberAvailability(userId, { teach: teachWindows, learn: learnWindows });
        void invalidateAiSuggestionsCache();
        return true;
      },
    }),
    [teachWindows, learnWindows, userId],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your schedule…
      </div>
    );
  }

  const firstTimeHint = teachWindows.length === 0 && learnWindows.length === 0 && (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Start simple:</span> add a day or two when
      you're usually free. You can always change it later.
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
