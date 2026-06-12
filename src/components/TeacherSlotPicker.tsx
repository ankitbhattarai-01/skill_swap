import { useEffect, useMemo, useState } from "react";
import { CalendarIcon, Clock, Loader2, Sparkles } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  TIME_STEP_MIN,
  type TeacherWindow,
  computeValidStartsForDay,
  formatPretty,
  timeLabel,
} from "@/lib/availability";

const HORIZON_DAYS = 14;
const SUGGESTED_COUNT = 3;

type Props = {
  // When supplied, the picker fetches the teacher's free `teach` windows
  // (minus their existing bookings) and constrains the date/time choices to
  // those windows. Without it, the picker is unconstrained (any future time).
  teacherId?: string;
  durationMinutes: number;
  // Currently-selected start (local Date), or null when nothing is chosen yet.
  value: Date | null;
  onChange: (next: Date) => void;
  // Fires whenever the selected value's validity changes, so the parent can
  // enable/disable its confirm button.
  onValidityChange?: (valid: boolean) => void;
  // Re-fetch trigger: pass the dialog's `open` so windows reload each time it
  // opens. Defaults to true (always fetch) for always-mounted usage.
  active?: boolean;
  // Local-timestamps (Date.getTime()) to hide from the choices — used when
  // building a multi-session plan so the same slot can't be picked twice.
  excludeTimes?: number[];
};

export function TeacherSlotPicker({
  teacherId,
  durationMinutes,
  value,
  onChange,
  onValidityChange,
  active = true,
  excludeTimes,
}: Props) {
  const [teacherWindows, setTeacherWindows] = useState<TeacherWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  // Distinguishes "the fetch failed" from "the teacher genuinely has no free
  // times" so we don't tell the learner the teacher is unavailable when it was
  // really a network/RPC error.
  const [windowsError, setWindowsError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const constrainPicker = Boolean(teacherId);

  // Slots already claimed by a picked slot. All sessions in a plan share the
  // same duration, so a candidate start is blocked when its
  // [start, start + duration) interval overlaps any picked slot's interval —
  // other times on the same day stay available.
  const excludeKey = (excludeTimes ?? []).join(",");
  const isSlotBlocked = useMemo(() => {
    const blockedStarts = excludeKey ? excludeKey.split(",").map(Number) : [];
    const durMs = durationMinutes * 60 * 1000;
    return (timeMs: number) => blockedStarts.some((t) => timeMs < t + durMs && timeMs + durMs > t);
  }, [excludeKey, durationMinutes]);

  // Fetch the teacher's free windows for the next horizon. One fetch per
  // (teacher, active) — duration filtering happens per-render on the client.
  useEffect(() => {
    if (!active || !teacherId) {
      setTeacherWindows([]);
      setWindowsError(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      setWindowsLoading(true);
      setWindowsError(false);
      const { data, error } = await supabase
        .rpc("get_teacher_windows", {
          p_teacher_id: teacherId,
          p_horizon_days: HORIZON_DAYS,
        })
        .abortSignal(controller.signal);
      if (!alive) return;
      if (error || !data) {
        setTeacherWindows([]);
        setWindowsError(true);
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
  }, [active, teacherId, retryNonce]);

  // Earliest N free starts across the whole horizon — surfaced as quick
  // "Best times" chips. Recomputed when duration changes since shorter
  // sessions fit in more places.
  const suggestedSlots = useMemo<Date[]>(() => {
    if (!constrainPicker) return [];
    const out: Date[] = [];
    const horizonEnd = new Date();
    horizonEnd.setDate(horizonEnd.getDate() + HORIZON_DAYS);
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= horizonEnd && out.length < SUGGESTED_COUNT) {
      const starts = computeValidStartsForDay(teacherWindows, cursor, durationMinutes);
      for (const s of starts) {
        if (isSlotBlocked(s.getTime())) continue;
        out.push(s);
        if (out.length >= SUGGESTED_COUNT) break;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [constrainPicker, teacherWindows, durationMinutes, isSlotBlocked]);

  const scheduleDate = value;
  const scheduleInPast =
    scheduleDate != null &&
    !Number.isNaN(scheduleDate.getTime()) &&
    scheduleDate.getTime() < Date.now();

  // Valid 10-min-aligned start times for the currently-selected date.
  const validStarts = useMemo<Date[]>(() => {
    if (!constrainPicker) return [];
    if (!scheduleDate || Number.isNaN(scheduleDate.getTime())) return [];
    return computeValidStartsForDay(teacherWindows, scheduleDate, durationMinutes).filter(
      (s) => !isSlotBlocked(s.getTime()),
    );
  }, [constrainPicker, teacherWindows, scheduleDate, durationMinutes, isSlotBlocked]);

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
      const starts = computeValidStartsForDay(teacherWindows, cursor, durationMinutes);
      if (starts.some((s) => !isSlotBlocked(s.getTime()))) keys.add(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
    }
    return keys;
  }, [constrainPicker, teacherWindows, durationMinutes, isSlotBlocked]);

  const selectedStartMatchesValid =
    !constrainPicker ||
    (scheduleDate != null && validStarts.some((s) => s.getTime() === scheduleDate.getTime()));

  const valid =
    scheduleDate != null &&
    !Number.isNaN(scheduleDate.getTime()) &&
    !scheduleInPast &&
    selectedStartMatchesValid;

  // Auto-fill the first suggested slot whenever the current value isn't a
  // valid teacher start (on first load, or after a duration change pushed the
  // old pick out of range). A valid manual pick is left untouched.
  useEffect(() => {
    if (!constrainPicker || windowsLoading) return;
    if (valid) return;
    if (suggestedSlots.length === 0) return;
    onChange(new Date(suggestedSlots[0]));
    // onChange is stable from the parent; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constrainPicker, windowsLoading, valid, suggestedSlots]);

  // Report validity upward.
  useEffect(() => {
    onValidityChange?.(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid]);

  const applyTime = (hh: number, mm: number) => {
    const base = scheduleDate ?? new Date();
    const merged = new Date(base);
    merged.setHours(hh, mm, 0, 0);
    onChange(merged);
  };

  return (
    <div className="space-y-2">
      {teacherId && (
        <div>
          {windowsLoading ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading teacher's free times…
            </p>
          ) : suggestedSlots.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Sparkles className="h-3 w-3 text-brand-purple" />
                Best times:
              </span>
              {suggestedSlots.map((d) => (
                <button
                  key={d.getTime()}
                  type="button"
                  onClick={() => onChange(new Date(d))}
                  className="rounded-full border border-brand-purple/30 bg-brand-purple/10 px-2.5 py-1 text-xs font-medium text-brand-purple transition-colors hover:bg-brand-purple/20"
                >
                  {d.toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </button>
              ))}
            </div>
          ) : windowsError ? (
            <p className="text-xs text-destructive">
              Couldn't load this teacher's free times.{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => setRetryNonce((n) => n + 1)}
              >
                Try again
              </button>
            </p>
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
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-sm outline-none transition-colors hover:border-brand-purple/40 hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-brand-purple/40"
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
            className="w-auto overflow-hidden rounded-2xl border border-white/10 bg-popover/95 p-0 shadow-glow backdrop-blur-xl"
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
                  // Snap time to the first valid start on the chosen day so the
                  // time field never holds an invalid value.
                  const starts = computeValidStartsForDay(
                    teacherWindows,
                    merged,
                    durationMinutes,
                  ).filter((s) => !isSlotBlocked(s.getTime()));
                  if (starts.length > 0) {
                    merged.setHours(starts[0].getHours(), starts[0].getMinutes(), 0, 0);
                  } else {
                    merged.setHours(0, 0, 0, 0);
                  }
                } else {
                  const base = scheduleDate ?? new Date();
                  merged.setHours(base.getHours(), base.getMinutes(), 0, 0);
                }
                onChange(merged);
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
            applyTime(hh, mm);
          }}
          disabled={constrainPicker && validStarts.length === 0}
        >
          <SelectTrigger className="h-auto min-w-[120px] rounded-xl border-white/10 bg-white/5 px-3 py-2.5 text-sm hover:border-brand-purple/40 hover:bg-white/[0.08]">
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <SelectValue placeholder="Time" />
            </span>
          </SelectTrigger>
          <SelectContent className="max-h-64 rounded-xl border-white/10">
            {constrainPicker
              ? validStarts.map((t) => {
                  const v = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
                  return (
                    <SelectItem key={v} value={v}>
                      {timeLabel(t)}
                    </SelectItem>
                  );
                })
              : // Fallback: 10-min options across the day when we have no
                // teacher-availability constraint to apply.
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

      {scheduleDate && selectedStartMatchesValid && !scheduleInPast && (
        <p className="text-xs text-muted-foreground">{formatPretty(scheduleDate)}</p>
      )}
      {scheduleInPast && <p className="text-xs text-destructive">Pick a time in the future.</p>}
      {constrainPicker &&
        !windowsLoading &&
        !windowsError &&
        scheduleDate != null &&
        validStarts.length === 0 && (
          <p className="text-xs text-destructive">
            Teacher isn't free for a {durationMinutes}-min session on{" "}
            {scheduleDate.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
            . Pick another day.
          </p>
        )}
    </div>
  );
}
