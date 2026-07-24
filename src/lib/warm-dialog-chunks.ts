// Booking dialogs are code-split, and rightly so — SessionRequestDialog drags
// in react-day-picker through the Calendar UI, which is far too much to ship to
// someone who is only browsing. The cost is paid at the worst possible moment
// though: the click. Between `setRequestRow(row)` and the panel appearing sits
// a chunk download plus parse, and the Suspense fallback for these is `null`,
// so the page just sits there doing nothing before the dialog snaps in
// mid-animation. That dead beat is most of what reads as "laggy".
//
// Warming the same dynamic imports once the page is idle moves that cost off
// the interaction. The module specifiers here must stay identical to the ones
// in the route-level `lazy()` calls — same specifier, same resolved module, so
// the route's import resolves against an already-populated module cache and
// the dialog mounts in the same frame as the click.
//
// This does not un-split the chunks: they are still separate files, still
// absent from the initial bundle, and still only fetched on pages that call
// this. It only changes *when* the fetch happens.

let warmed = false;

function whenIdle(task: () => void) {
  if (typeof window === "undefined") return;
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: 3000 });
  } else {
    window.setTimeout(task, 400);
  }
}

/** Preloads the dialogs reachable from the discovery/session surfaces. Safe to
 *  call from several routes and on every mount — it only ever runs once, and a
 *  failed prefetch is silently ignored because the real `lazy()` import will
 *  simply try again at open time. */
export function warmBookingDialogs() {
  if (warmed) return;
  warmed = true;
  whenIdle(() => {
    void import("@/components/SessionRequestDialog").catch(() => {});
    void import("@/components/SwapProposalDialog").catch(() => {});
    void import("@/components/TeacherSlotPicker").catch(() => {});
  });
}

/** Immediate (no idle wait) preload of just the slot picker, for hover/focus on
 *  a trigger that is about to be clicked. Used by the reschedule button, which
 *  lives on pages where a blanket prefetch would be wasted on the many visitors
 *  who never reschedule anything. */
export function preloadSlotPicker() {
  void import("@/components/TeacherSlotPicker").catch(() => {});
}
