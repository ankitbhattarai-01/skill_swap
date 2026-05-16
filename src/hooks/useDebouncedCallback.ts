import { useCallback, useEffect, useRef } from "react";

// Trailing-edge debounce. Useful for batching Supabase realtime
// `postgres_changes` events: a single user action (RPC + trigger + cascading
// inserts) commonly fires 5+ change rows in <100ms. Calling the heavy reload
// once per event causes a thundering-herd refetch storm; this hook collapses
// any burst within `delayMs` into a single call after things go quiet.
//
// Use cases:
//   - Dashboard / history realtime listeners that call `loadAll()` per event.
//   - Credits page realtime listeners refetching the full transaction list.
//
// The returned function is stable across renders so it's safe to pass into
// channel `.on()` handlers without re-subscribing.
export function useDebouncedCallback<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgsRef = useRef<TArgs | null>(null);

  // Clear any pending invocation when the component unmounts so we don't
  // call into a stale closure after teardown.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (...args: TArgs) => {
      lastArgsRef.current = args;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const latest = lastArgsRef.current;
        lastArgsRef.current = null;
        if (latest) fnRef.current(...latest);
      }, delayMs);
    },
    [delayMs],
  );
}
