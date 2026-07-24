// Shared, short-lived cache for the two availability RPCs every slot picker
// needs. It exists for how the pickers are actually used, which is bursty:
//
//   * SwapProposalDialog mounts TWO TeacherSlotPickers at once. Uncached that
//     is four round trips on open, two of them (`get_my_busy_intervals`) byte
//     for byte identical — fired within a millisecond of each other.
//   * Reopening the same booking dialog, or flipping "Just one / Multiple",
//     re-ran the whole fetch and left the panel showing a spinner again even
//     though nothing about the teacher's calendar could have changed.
//
// So: results are memoised for CACHE_TTL_MS, and concurrent callers asking for
// the same key share one in-flight promise instead of racing. A cached read is
// synchronous, which is the point — a reopened dialog paints its real content
// on the first frame rather than animating in as a spinner and then resizing.
//
// The TTL is deliberately short, and `invalidateAvailabilityCache()` is called
// from invalidatePageCaches() — i.e. from every session/swap mutation — so a
// booking someone just made never lingers as a bookable slot. The server-side
// double-booking trigger is still the real guard; this is only about what the
// picker offers.

import { supabase } from "@/integrations/supabase/client";
import type { TeacherWindow } from "@/lib/availability";

const CACHE_TTL_MS = 45_000;

// The horizon every picker asks for. Shared rather than re-declared per caller
// because the horizon is part of the cache key: a prefetch that used a
// different number would warm an entry nobody ever reads.
export const AVAILABILITY_HORIZON_DAYS = 14;

export type BusyInterval = { start: number; end: number };

type Entry<T> = { at: number; value: T };

// Only successful reads land in the cache, so a cached value is always a real
// window list — never the `null` a failed fetch resolves to.
const teacherWindowsCache = new Map<string, Entry<TeacherWindow[]>>();
const teacherWindowsInFlight = new Map<string, Promise<TeacherWindow[] | null>>();

const myBusyCache = new Map<string, Entry<BusyInterval[]>>();
const myBusyInFlight = new Map<string, Promise<BusyInterval[]>>();

function fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
  return entry != null && Date.now() - entry.at < CACHE_TTL_MS;
}

/** Cached windows for this key if they are still fresh, else undefined. Lets a
 *  picker render real slots on its very first frame instead of a spinner. */
export function peekTeacherWindows(
  teacherId: string,
  horizonDays: number,
): TeacherWindow[] | undefined {
  const entry = teacherWindowsCache.get(`${teacherId}:${horizonDays}`);
  return fresh(entry) ? entry.value : undefined;
}

export function peekMyBusyIntervals(horizonDays: number): BusyInterval[] | undefined {
  const entry = myBusyCache.get(String(horizonDays));
  return fresh(entry) ? entry.value : undefined;
}

/** The teacher's free `teach` windows over the horizon. `null` means the fetch
 *  failed — distinct from `[]`, which means they genuinely have no free time.
 *  Failures are not cached, so a retry actually retries. */
export function fetchTeacherWindows(
  teacherId: string,
  horizonDays: number,
): Promise<TeacherWindow[] | null> {
  const key = `${teacherId}:${horizonDays}`;
  const cached = teacherWindowsCache.get(key);
  if (fresh(cached)) return Promise.resolve(cached.value);

  const existing = teacherWindowsInFlight.get(key);
  if (existing) return existing;

  // supabase's builder is a thenable, not a real Promise, so it is wrapped
  // before .catch/.finally are chained onto it.
  const request = Promise.resolve(
    supabase.rpc("get_teacher_windows", {
      p_teacher_id: teacherId,
      p_horizon_days: horizonDays,
    }),
  )
    .then(({ data, error }) => {
      if (error || !data) return null;
      const windows = data.map((row) => ({
        start: new Date(row.window_start),
        end: new Date(row.window_end),
      }));
      teacherWindowsCache.set(key, { at: Date.now(), value: windows });
      return windows;
    })
    .catch(() => null)
    .finally(() => {
      teacherWindowsInFlight.delete(key);
    });

  teacherWindowsInFlight.set(key, request);
  return request;
}

/** The caller's own committed sessions (as teacher or learner). Best-effort:
 *  an error yields an empty list, matching the previous inline behaviour. */
export function fetchMyBusyIntervals(horizonDays: number): Promise<BusyInterval[]> {
  const key = String(horizonDays);
  const cached = myBusyCache.get(key);
  if (fresh(cached)) return Promise.resolve(cached.value);

  const existing = myBusyInFlight.get(key);
  if (existing) return existing;

  const request = Promise.resolve(
    supabase.rpc("get_my_busy_intervals", { p_horizon_days: horizonDays }),
  )
    .then(({ data, error }) => {
      if (error || !data) return [];
      const intervals = data.map((row) => ({
        start: new Date(row.busy_start).getTime(),
        end: new Date(row.busy_end).getTime(),
      }));
      myBusyCache.set(key, { at: Date.now(), value: intervals });
      return intervals;
    })
    .catch((): BusyInterval[] => [])
    .finally(() => {
      myBusyInFlight.delete(key);
    });

  myBusyInFlight.set(key, request);
  return request;
}

/** Warms both RPCs a slot picker needs before that picker exists.
 *
 *  A dialog that fetches something else first (the swap match, a profile) does
 *  not mount its pickers until that first fetch resolves — so without this the
 *  calendar round trip cannot even *begin* until the unrelated one has
 *  finished, and the panel pays the two latencies end to end. Called at open
 *  time the two overlap instead, and the picker's synchronous `peek` usually
 *  hits, so it paints real slots on its first frame.
 *
 *  Falsy ids are skipped so callers can pass `user?.id` straight in, and
 *  duplicates are collapsed (proposing a swap with yourself is not a thing, but
 *  the caller shouldn't have to prove it). The returned promise resolves once
 *  every warm-up has settled; ignoring it is fine — nothing here throws. */
export function prefetchAvailability(teacherIds: (string | null | undefined)[]): Promise<unknown> {
  const jobs: Promise<unknown>[] = [fetchMyBusyIntervals(AVAILABILITY_HORIZON_DAYS)];
  const seen = new Set<string>();
  for (const id of teacherIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    jobs.push(fetchTeacherWindows(id, AVAILABILITY_HORIZON_DAYS));
  }
  return Promise.all(jobs);
}

/** Drop everything. Called whenever a session is booked, accepted, cancelled,
 *  rescheduled, or swapped — any of which changes who is free when. */
export function invalidateAvailabilityCache() {
  teacherWindowsCache.clear();
  myBusyCache.clear();
}
