// Shared availability/slot helpers used by the booking dialog
// (SessionRequestDialog) and the reschedule picker (RescheduleSection via
// TeacherSlotPicker). Both constrain the user to the teacher's free `teach`
// windows (returned by the get_teacher_windows RPC, already minus the
// teacher's existing bookings), so the logic lives in one place.

export const TIME_STEP_MIN = 10;

export type TeacherWindow = { start: Date; end: Date };

/** `YYYY-MM-DDTHH:mm` in local wall-clock time — the value shape a native
 *  datetime-local input and our pickers round-trip through. */
export function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPretty(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Walks every teacher window and emits 10-min-aligned start times where
// [t, t + duration] fits inside the window, t is on `day` (local), and t is
// in the future. Aligned to the wall clock (:00, :10, :20…).
export function computeValidStartsForDay(
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
