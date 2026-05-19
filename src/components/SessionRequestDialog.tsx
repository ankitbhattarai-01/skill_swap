import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, CalendarIcon, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SESSION_DURATIONS, computeSessionCredits, type SessionDuration } from "@/lib/sessions";
import { supabase } from "@/integrations/supabase/client";

const TIME_STEP_MIN = 10;
const HORIZON_DAYS = 14;
const SUGGESTED_COUNT = 3;

type TeacherWindow = { start: Date; end: Date };

function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPretty(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Walks every teacher window and emits 10-min-aligned start times where
// [t, t + duration] fits inside the window, t is on `day` (local), and t is
// in the future. Aligned to the wall clock (:00, :10, :20…).
function computeValidStartsForDay(
  windows: TeacherWindow[],
  day: Date,
  durationMinutes: number,
): Date[] {
  const out: Date[] = [];
  const now = new Date();
  const seen = new Set<number>();
  for (const w of windows) {
    if (!sameLocalDay(w.start, day) && !sameLocalDay(w.end, day)) {
      const dayStart = new Date(day);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      if (w.end <= dayStart || w.start >= dayEnd) continue;
    }
    const first = new Date(w.start);
    const m = first.getMinutes();
    const bump = (TIME_STEP_MIN - (m % TIME_STEP_MIN)) % TIME_STEP_MIN;
    first.setMinutes(m + bump, 0, 0);
    for (let t = new Date(first); ; t = new Date(t.getTime() + TIME_STEP_MIN * 60_000)) {
      const end = new Date(t.getTime() + durationMinutes * 60_000);
      if (end > w.end) break;
      if (t < now) continue;
      if (!sameLocalDay(t, day)) continue;
      const key = t.getTime();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  out.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  skillName: string;
  creditsPerHour: number;
  availableCredits?: number | null;
  busy?: boolean;
  confirmLabel?: string;
  onConfirm: (duration: SessionDuration, scheduledAt: string) => void | Promise<void>;
  // When supplied, the dialog fetches the teacher's free `teach` windows
  // (minus their existing bookings) and constrains the date/time picker
  // to those windows. Without it, the picker is unconstrained.
  // learnerId is kept in the signature for callsite compatibility but is
  // no longer used — bookings only check teacher-side availability.
  learnerId?: string;
  teacherId?: string;
};

function defaultScheduleLocal() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SessionRequestDialog({
  open,
  onOpenChange,
  title,
  skillName,
  creditsPerHour,
  availableCredits,
  busy = false,
  confirmLabel = "Send request",
  onConfirm,
  teacherId,
}: Props) {
  const [duration, setDuration] = useState<SessionDuration>(60);
  const [scheduledAt, setScheduledAt] = useState<string>("");
  const [teacherWindows, setTeacherWindows] = useState<TeacherWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  // When the user picks a date/time manually, we stop auto-applying the
  // top suggestion. Reset on open and when duration changes (since a new
  // duration produces a fresh suggestion list).
  const [userTouched, setUserTouched] = useState(false);

  const constrainPicker = Boolean(teacherId);

  useEffect(() => {
    if (open) {
      setDuration(60);
      setScheduledAt(defaultScheduleLocal());
      setUserTouched(false);
    }
  }, [open]);

  // Fetch teacher's free windows (their `teach` availability minus their
  // existing bookings) for the next horizon. One fetch per open — duration
  // filtering is per-render on the client.
  useEffect(() => {
    if (!open || !teacherId) {
      setTeacherWindows([]);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      setWindowsLoading(true);
      const { data, error } = await supabase
        .rpc("get_teacher_windows", {
          p_teacher_id: teacherId,
          p_horizon_days: HORIZON_DAYS,
        })
        .abortSignal(controller.signal);
      if (!alive) return;
      if (error || !data) {
        setTeacherWindows([]);
      } else {
        setTeacherWindows(
          data.map((row) => ({
            start: new Date(row.window_start),
            end: new Date(row.window_end),
          })),
        );
      }
      setWindowsLoading(false);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, teacherId]);

  // Earliest N free starts across the whole horizon — surfaced as quick
  // "Suggested:" chips. Recomputed when duration changes since shorter
  // sessions fit in more places.
  const suggestedSlots = useMemo<Date[]>(() => {
    if (!constrainPicker) return [];
    const out: Date[] = [];
    const horizonEnd = new Date();
    horizonEnd.setDate(horizonEnd.getDate() + HORIZON_DAYS);
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= horizonEnd && out.length < SUGGESTED_COUNT) {
      const starts = computeValidStartsForDay(teacherWindows, cursor, duration);
      for (const s of starts) {
        out.push(s);
        if (out.length >= SUGGESTED_COUNT) break;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [constrainPicker, teacherWindows, duration]);

  // Auto-fill schedule with the top suggestion so the common case needs
  // zero clicks. Held back once the user manually overrides.
  useEffect(() => {
    if (!open || userTouched || suggestedSlots.length === 0) return;
    const d = suggestedSlots[0];
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduledAt(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
  }, [open, userTouched, suggestedSlots]);

  const applySuggestedSlot = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduledAt(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
    setUserTouched(true);
  };

  const cost = computeSessionCredits(creditsPerHour, duration);
  const insufficient = availableCredits != null && availableCredits >= 0 && cost > availableCredits;
  const scheduleDate = scheduledAt ? new Date(scheduledAt) : null;
  const scheduleInPast =
    scheduleDate != null &&
    !Number.isNaN(scheduleDate.getTime()) &&
    scheduleDate.getTime() < Date.now();

  // Valid 10-min-aligned start times for the currently-selected date.
  const validStarts = useMemo<Date[]>(() => {
    if (!constrainPicker) return [];
    if (!scheduleDate || Number.isNaN(scheduleDate.getTime())) return [];
    return computeValidStartsForDay(teacherWindows, scheduleDate, duration);
  }, [constrainPicker, teacherWindows, scheduleDate, duration]);

  // Set of local-day timestamps within the horizon that have at least one
  // valid start. Used to gray out dead days in the calendar.
  const validDayKeys = useMemo<Set<number>>(() => {
    if (!constrainPicker) return new Set();
    const keys = new Set<number>();
    const horizonEnd = new Date();
    horizonEnd.setDate(horizonEnd.getDate() + HORIZON_DAYS);
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= horizonEnd) {
      const starts = computeValidStartsForDay(teacherWindows, cursor, duration);
      if (starts.length > 0) keys.add(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
    }
    return keys;
  }, [constrainPicker, teacherWindows, duration]);

  const selectedStartMatchesValid =
    !constrainPicker ||
    (scheduleDate != null && validStarts.some((s) => s.getTime() === scheduleDate.getTime()));

  const scheduleInvalid =
    !scheduledAt ||
    scheduleDate == null ||
    Number.isNaN(scheduleDate.getTime()) ||
    scheduleInPast ||
    (constrainPicker && !selectedStartMatchesValid);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pick a duration for your {skillName} session. Credits transfer when the session is
            completed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {SESSION_DURATIONS.map((value) => {
            const selected = value === duration;
            const optionCost = computeSessionCredits(creditsPerHour, value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setDuration(value);
                  setUserTouched(false);
                }}
                className={cn(
                  "rounded-xl border px-3 py-3 text-center transition-colors",
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card hover:border-primary/40",
                )}
              >
                <div className="text-base font-semibold">{value} min</div>
                <div className="text-xs text-muted-foreground">
                  {optionCost} {optionCost === 1 ? "credit" : "credits"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          <label htmlFor="session-schedule" className="text-sm font-medium">
            When?
          </label>
          {teacherId && (
            <div className="mb-1">
              {windowsLoading ? (
                <p className="text-xs text-muted-foreground">Loading teacher's free times…</p>
              ) : suggestedSlots.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Sparkles className="h-3 w-3" /> Suggested:
                  </span>
                  {suggestedSlots.map((d) => (
                    <button
                      key={d.getTime()}
                      type="button"
                      onClick={() => applySuggestedSlot(d)}
                      className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/20"
                    >
                      {d.toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This teacher hasn't posted any free times in the next two weeks.
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  id="session-schedule"
                  className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                  {scheduleDate && !Number.isNaN(scheduleDate.getTime()) ? (
                    <span>
                      {scheduleDate.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Pick a date</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto overflow-hidden rounded-2xl border border-border/60 bg-popover p-0 shadow-xl"
                align="start"
              >
                <Calendar
                  className="bg-transparent"
                  mode="single"
                  selected={scheduleDate ?? undefined}
                  onSelect={(day) => {
                    if (!day) return;
                    const merged = new Date(day);
                    if (constrainPicker) {
                      // Snap time to the first valid start on the chosen
                      // day so the time field never holds an invalid value.
                      const starts = computeValidStartsForDay(teacherWindows, merged, duration);
                      if (starts.length > 0) {
                        merged.setHours(starts[0].getHours(), starts[0].getMinutes(), 0, 0);
                      } else {
                        merged.setHours(0, 0, 0, 0);
                      }
                    } else {
                      const base = scheduleDate ?? new Date();
                      merged.setHours(base.getHours(), base.getMinutes(), 0, 0);
                    }
                    setScheduledAt(formatLocal(merged));
                    setUserTouched(true);
                  }}
                  disabled={(date) => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    if (date < today) return true;
                    if (constrainPicker) {
                      const key = new Date(date);
                      key.setHours(0, 0, 0, 0);
                      return !validDayKeys.has(key.getTime());
                    }
                    return false;
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Select
              value={
                scheduleDate && !Number.isNaN(scheduleDate.getTime())
                  ? `${String(scheduleDate.getHours()).padStart(2, "0")}:${String(scheduleDate.getMinutes()).padStart(2, "0")}`
                  : ""
              }
              onValueChange={(val) => {
                const [hh, mm] = val.split(":").map(Number);
                const base = scheduleDate ?? new Date();
                const merged = new Date(base);
                merged.setHours(hh, mm, 0, 0);
                setScheduledAt(formatLocal(merged));
                setUserTouched(true);
              }}
              disabled={constrainPicker && validStarts.length === 0}
            >
              <SelectTrigger className="h-auto min-w-[110px] rounded-xl border-border bg-card px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <SelectValue placeholder="Time" />
                </span>
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl">
                {constrainPicker
                  ? validStarts.map((t) => {
                      const v = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
                      return (
                        <SelectItem key={v} value={v}>
                          {timeLabel(t)}
                        </SelectItem>
                      );
                    })
                  : // Fallback: 10-min options across the day when we have
                    // no teacher-availability constraint to apply.
                    Array.from({ length: (24 * 60) / TIME_STEP_MIN }).map((_, i) => {
                      const total = i * TIME_STEP_MIN;
                      const h = Math.floor(total / 60);
                      const m = total % 60;
                      const v = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                      const period = h < 12 ? "AM" : "PM";
                      const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
                      return (
                        <SelectItem key={v} value={v}>
                          {`${hh}:${String(m).padStart(2, "0")} ${period}`}
                        </SelectItem>
                      );
                    })}
              </SelectContent>
            </Select>
          </div>
          {scheduleDate && selectedStartMatchesValid && (
            <p className="text-xs text-muted-foreground">{formatPretty(scheduleDate)}</p>
          )}
          {scheduleInPast && <p className="text-xs text-destructive">Pick a time in the future.</p>}
          {constrainPicker &&
            !windowsLoading &&
            scheduleDate != null &&
            validStarts.length === 0 && (
              <p className="text-xs text-destructive">
                Teacher isn't free for a {duration}-min session on{" "}
                {scheduleDate.toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
                . Pick another day.
              </p>
            )}
        </div>

        <div className="rounded-xl bg-secondary/60 px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Total cost</span>
            <span className="font-semibold">
              {cost} {cost === 1 ? "credit" : "credits"}
            </span>
          </div>
          {availableCredits != null && (
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Your balance</span>
              <span className={cn(insufficient ? "text-destructive" : "text-muted-foreground")}>
                {availableCredits} {availableCredits === 1 ? "credit" : "credits"}
              </span>
            </div>
          )}
          {insufficient && (
            <p className="mt-2 text-xs text-destructive">
              Not enough credits. Pick a shorter duration or earn more by teaching.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="hero"
            onClick={() => {
              if (scheduleInvalid || !scheduleDate) return;
              void onConfirm(duration, scheduleDate.toISOString());
            }}
            disabled={busy || insufficient || scheduleInvalid}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
