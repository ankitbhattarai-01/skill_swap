import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

// `useSyncExternalStore` gives us a deterministic server snapshot (`false` =
// desktop) that React uses during hydration, so SSR and client first paint
// match. After hydration React swaps to the live client snapshot via
// `matchMedia`. This eliminates the "render desktop, useEffect runs, flip to
// mobile" two-frame flash the old `useState<undefined>` + `useEffect` pattern
// produced — the client snapshot is correct on the very first non-hydration
// render.
function subscribe(notify: () => void) {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(MEDIA_QUERY);
  mql.addEventListener("change", notify);
  return () => mql.removeEventListener("change", notify);
}

function getSnapshot() {
  // Some headless browsers and the rare WebView don't expose matchMedia;
  // fall back to innerWidth so we still return a sensible value.
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(MEDIA_QUERY).matches;
  }
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
