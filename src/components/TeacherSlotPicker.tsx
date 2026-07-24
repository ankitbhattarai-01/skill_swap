import { useEffect, useMemo, useState } from "react";
import { CalendarIcon, Clock } from "lucide-react";
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
import { SuggestionChipsSkeleton } from "@/components/SlotPickerSkeleton";
import {
  AVAILABILITY_HORIZON_DAYS,
  type BusyInterval,
  fetchMyBusyIntervals,
  fetchTeacherWindows,
  peekMyBusyIntervals,
  peekTeacherWindows,
} from "@/lib/availability-cache";
import {
  TIME_STEP_MIN,
  type TeacherWindow,
  computeValidStartsForDay,
  formatPretty,
  sameLocalDay,
  timeLabel,
} from "@/lib/availability";

// Owned by the cache module, not by this file: a caller that prefetches on
// behalf of a picker has to ask for the same horizon or it warms the wrong key.
const HORIZON_DAYS = AVAILABILITY_HORIZON_DAYS;
const SUGGESTED_COUNT = 3;

/** Local midnight of `d`, as a timestamp. The key every per-day lookup uses. */
function dayKeyOf(d: Date): number {
  const key = new Date(d);
  key.setHours(0, 0, 0, 0);
  return key.getTime();
}

// Day half of a suggestion chip. "Today"/"Tomorrow" read faster than a date and
// keep the chip narrow enough that all SUGGESTED_COUNT chips fit on one row.
function dayLabel(d: Date): string {
  const today = new Date();
  if (sameLocalDay(d, today)) return "Today";
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameLocalDay(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

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
  // Each blocked slot is assumed to span this picker's own duration.
  excludeTimes?: number[];
  // Blocked [start, end) ranges in ms with their own explicit lengths — used by
  // swaps, where the other leg's session may have a different duration.
  excludeIntervals?: { start: number; end: number }[];
  // Timestamp (ms) of the latest slot already picked in a multi-session plan.
  // When the current value needs auto-filling, the picker prefers the first
  // free start on a day after this one, so consecutive adds step across days
  // instead of stacking later times onto the same day.
  preferAfter?: number | null;
  // Compact mode: the suggested-time chips become the primary selectable
  // choices and the full date/time picker hides behind a "Custom…" toggle.
  compact?: boolean;
};

export function TeacherSlotPicker({
  teacherId,
  durationMinutes,
  value,
  onChange,
  onValidityChange,
  active = true,
  excludeTimes,
  excludeIntervals,
  preferAfter,
  compact = false,
}: Props) {
  // Seeded straight from the availability cache so a reopened dialog paints its
  // real slots on the first frame. Without this the panel animated in as a
  // spinner, then grew by the height of the suggestion chips a moment later —
  // and because a dialog is centred, growing means re-centring, which is the
  // jump the user sees.
  const [teacherWindows, setTeacherWindows] = useState<TeacherWindow[]>(
    () => (active && teacherId ? peekTeacherWindows(teacherId, HORIZON_DAYS) : undefined) ?? [],
  );
  // The current user's own committed sessions (as teacher or learner). Blocked
  // from selection so you can't book a slot you're already busy in — the
  // teacher-window fetch only knows the OTHER person's calendar.
  const [myBusy, setMyBusy] = useState<BusyInterval[]>(
    () => (active ? peekMyBusyIntervals(HORIZON_DAYS) : undefined) ?? [],
  );
  const [showCustom, setShowCustom] = useState(false);
  const [windowsLoading, setWindowsLoading] = useState(() =>
    Boolean(active && teacherId && !peekTeacherWindows(teacherId, HORIZON_DAYS)),
  );
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
  const intervalKey = (excludeIntervals ?? []).map((i) => `${i.start}:${i.end}`).join(",");
  const myBusyKey = myBusy.map((i) => `${i.start}:${i.end}`).join(",");
  const isSlotBlocked = useMemo(() => {
    const blockedStarts = excludeKey ? excludeKey.split(",").map(Number) : [];
    const parseIntervals = (key: string) =>
      key ? key.split(",").map((pair) => pair.split(":").map(Number)) : [];
    // The caller's own bookings block the same way explicit excludeIntervals do.
    const intervals = [...parseIntervals(intervalKey), ...parseIntervals(myBusyKey)];
    const durMs = durationMinutes * 60 * 1000;
    return (timeMs: number) =>
      blockedStarts.some((t) => timeMs < t + durMs && timeMs + durMs > t) ||
      intervals.some(([s, e]) => timeMs < e && timeMs + durMs > s);
  }, [excludeKey, intervalKey, myBusyKey, durationMinutes]);

  // Fetch the teacher's free windows for the next horizon. One fetch per
  // (teacher, active) — duration filtering happens per-render on the client.
  // Goes through the shared cache, which both de-duplicates the two pickers a
  // swap dialog mounts side by side and skips the request entirely on a reopen.
  useEffect(() => {
    if (!active || !teacherId) {
      setTeacherWindows([]);
      setWindowsError(false);
      setWindowsLoading(false);
      return;
    }
    const cached = peekTeacherWindows(teacherId, HORIZON_DAYS);
    if (cached) {
      // Same array identity as the seed above, so React bails out of this
      // render rather than kicking off another pass mid-animation.
      setTeacherWindows(cached);
      setWindowsError(false);
      setWindowsLoading(false);
      return;
    }
    let alive = true;
    setWindowsLoading(true);
    setWindowsError(false);
    void fetchTeacherWindows(teacherId, HORIZON_DAYS).then((windows) => {
      if (!alive) return;
      setTeacherWindows(windows ?? []);
      setWindowsError(windows == null);
      setWindowsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [active, teacherId, retryNonce]);

  // Fetch the caller's own committed sessions so their busy times are blocked in
  // every mode (constrained or not). Best-effort: on error we just don't add
  // any extra blocks — the server-side double-booking trigger still backstops.
  useEffect(() => {
    if (!active) {
      setMyBusy([]);
      return;
    }
    const cached = peekMyBusyIntervals(HORIZON_DAYS);
    if (cached) {
      setMyBusy(cached);
      return;
    }
    let alive = true;
    void fetchMyBusyIntervals(HORIZON_DAYS).then((intervals) => {
      if (alive) setMyBusy(intervals);
    });
    return () => {
      alive = false;
    };
  }, [active, retryNonce]);

  // Every day in the horizon walked exactly once, with the starts that fit this
  // duration. Previously "best times", "which calendar days are dead" and "what
  // times can I pick today" each ran their own day loop over the same windows —
  // three passes, thousands of throwaway Date objects, re-run on every render
  // caused by the auto-fill below. Now the walk is one memo keyed only on the
  // windows and the duration, and the three views are cheap filters over it.
  const dayPlan = useMemo<{ key: number; starts: Date[] }[]>(() => {
    if (!constrainPicker) return [];
    const out: { key: number; starts: Date[] }[] = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    for (let i = 0; i <= HORIZON_DAYS; i++) {
      out.push({
        key: cursor.getTime(),
        starts: computeValidStartsForDay(teacherWindows, cursor, durationMinutes),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [constrainPicker, teacherWindows, durationMinutes]);

  // First free start on each of the next N distinct days — surfaced as quick
  // "Best times" chips, so the suggestions spread across different days
  // instead of clustering 10 minutes apart on the same one.
  const suggestedSlots = useMemo<Date[]>(() => {
    const out: Date[] = [];
    for (const day of dayPlan) {
      if (out.length >= SUGGESTED_COUNT) break;
      const first = day.starts.find((s) => !isSlotBlocked(s.getTime()));
      if (first) out.push(first);
    }
    return out;
  }, [dayPlan, isSlotBlocked]);

  const scheduleDate = value;
  const scheduleInPast =
    scheduleDate != null &&
    !Number.isNaN(scheduleDate.getTime()) &&
    scheduleDate.getTime() < Date.now();

  // Valid 10-min-aligned start times for the currently-selected date.
  const validStarts = useMemo<Date[]>(() => {
    if (!constrainPicker) return [];
    if (!scheduleDate || Number.isNaN(scheduleDate.getTime())) return [];
    const day = dayPlan.find((d) => d.key === dayKeyOf(scheduleDate));
    return (day?.starts ?? []).filter((s) => !isSlotBlocked(s.getTime()));
  }, [constrainPicker, dayPlan, scheduleDate, isSlotBlocked]);

  // Set of local-day timestamps within the horizon that have at least one
  // valid start. Used to gray out dead days in the calendar.
  const validDayKeys = useMemo<Set<number>>(() => {
    const keys = new Set<number>();
    for (const day of dayPlan) {
      if (day.starts.some((s) => !isSlotBlocked(s.getTime()))) keys.add(day.key);
    }
    return keys;
  }, [dayPlan, isSlotBlocked]);

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
    // Multi-session plans: after a slot is added the old draft turns invalid,
    // so step to the first free start on a day after the latest picked slot —
    // consecutive adds then walk across available days instead of stacking
    // later times onto the same day.
    if (preferAfter != null) {
      const after = new Date(preferAfter);
      after.setHours(0, 0, 0, 0);
      const cutoff = after.getTime();
      for (const day of dayPlan) {
        if (day.key <= cutoff) continue;
        const first = day.starts.find((s) => !isSlotBlocked(s.getTime()));
        if (first) {
          onChange(first);
          return;
        }
      }
      // No free day left after the latest slot — fall through to the earliest
      // suggestion so the picker never strands on an invalid value.
    }
    if (suggestedSlots.length === 0) return;
    onChange(new Date(suggestedSlots[0]));
    // onChange is stable from the parent; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constrainPicker, windowsLoading, valid, suggestedSlots, preferAfter]);

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

  // The full date/time controls only show in non-compact mode, or once the
  // compact picker's "Custom…" toggle is on.
  const showFullPicker = !compact || showCustom;
  // Height is only worth holding open where a message is actually expected:
  // with a teacher constraining the picker, the echoed date always lands.
  const reserveStatusLine = constrainPicker && showFullPicker;
  const statusLine = scheduleInPast ? (
    <p className="text-destructive">Pick a time in the future.</p>
  ) : showFullPicker &&
    constrainPicker &&
    !windowsLoading &&
    !windowsError &&
    scheduleDate != null &&
    validStarts.length === 0 ? (
    <p className="text-destructive">
      Teacher isn't free for a {durationMinutes}-min session on{" "}
      {scheduleDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })}
      . Pick another day.
    </p>
  ) : showFullPicker && scheduleDate && selectedStartMatchesValid ? (
    <p className="text-muted-foreground">{formatPretty(scheduleDate)}</p>
  ) : null;

  return (
    <div className="space-y-2">
      {teacherId && (
        <div>
          {windowsLoading ? (
            <SuggestionChipsSkeleton withCustomToggle={compact} />
          ) : suggestedSlots.length > 0 ? (
            // Label drops above the chips on narrow screens so the 3-up row
            // keeps the full width there too.
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="shrink-0 text-[11px] text-muted-foreground">Best times:</span>
              {/* Fixed 3-up row rather than wrapping chips: every suggestion stays
                  on one line, so the third never drops below the others. */}
              <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
                {suggestedSlots.map((d) => {
                  const isSel = scheduleDate != null && d.getTime() === scheduleDate.getTime();
                  return (
                    <button
                      key={d.getTime()}
                      type="button"
                      onClick={() => onChange(new Date(d))}
                      className={cn(
                        "min-w-0 rounded-xl border px-1.5 py-1 text-center leading-tight transition-colors",
                        isSel
                          ? "border-brand-purple bg-brand-purple text-white shadow-sm"
                          : "border-brand-purple/30 bg-brand-purple/10 text-brand-purple hover:bg-brand-purple/20",
                      )}
                    >
                      <span className="block truncate text-[11px] font-semibold">
                        {dayLabel(d)}
                      </span>
                      <span
                        className={cn(
                          "block truncate text-[10px]",
                          isSel ? "text-white/80" : "opacity-80",
                        )}
                      >
                        {timeLabel(d)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {compact && (
                <button
                  type="button"
                  onClick={() => setShowCustom((v) => !v)}
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    showCustom
                      ? "border-brand-purple/40 bg-brand-purple/10 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
                  )}
                >
                  Custom…
                </button>
              )}
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

      {showFullPicker && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2.5 text-left text-sm outline-none transition-colors hover:border-brand-purple/40 hover:bg-brand-purple/[0.07] focus-visible:ring-2 focus-visible:ring-brand-purple/40"
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
            {/* No backdrop-blur here: --popover is 95%+ opaque, so the blur was
              invisible but still forced the browser to re-read and re-filter
              everything behind the panel on every frame of its open animation. */}
            <PopoverContent
              className="w-auto overflow-hidden rounded-2xl border border-border bg-popover p-0 shadow-glow"
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
                    const starts = (
                      dayPlan.find((d) => d.key === dayKeyOf(merged))?.starts ?? []
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
                  if (constrainPicker) return !validDayKeys.has(dayKeyOf(date));
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
            <SelectTrigger className="h-auto min-w-[120px] rounded-xl border-border bg-muted px-3 py-2.5 text-sm hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]">
              <span className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder="Time" />
              </span>
            </SelectTrigger>
            <SelectContent className="max-h-64 rounded-xl border-border">
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
      )}

      {/* One status region instead of three sibling paragraphs, and — whenever
          the full picker is on screen — one line of height held open for it
          from the start. The echoed date lands here a beat after the windows
          load and the auto-fill runs; as a conditional paragraph, its arrival
          grew the panel and re-centred it, which is the second bump you felt
          after opening a booking dialog. Reserved, the text just fades in. */}
      {(reserveStatusLine || statusLine) && (
        <div className={cn("text-xs", reserveStatusLine && "min-h-4")} aria-live="polite">
          {statusLine}
        </div>
      )}
    </div>
  );
}
