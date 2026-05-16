// Tiny registry of the page-level sessionStorage caches used to skip the
// first-paint skeleton on dashboard and explore. Each of those pages writes
// a snapshot of its server state on every successful load and re-reads it on
// next mount.
//
// Without invalidation the cached snapshot is reused for up to 5 minutes
// (its TTL) even after the user has mutated the underlying data — e.g.
// accept a session on dashboard then bounce to explore: the explore card
// would still claim "No accepted session yet" because its cache was frozen
// from before the accept.
//
// Call `invalidatePageCaches(userId)` from any code path that meaningfully
// changes the data those pages render (session lifecycle RPCs, credit
// mutations). Cheap — just a couple of sessionStorage removes.

const EXPLORE_CACHE_KEY = "skillswap-explore-cache";
const DASHBOARD_CACHE_PREFIX = "skillswap-dashboard-cache";

export function invalidatePageCaches(userId?: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(EXPLORE_CACHE_KEY);
    if (userId) {
      window.sessionStorage.removeItem(`${DASHBOARD_CACHE_PREFIX}-${userId}`);
    }
  } catch {
    // sessionStorage can throw in private mode / when quota is exceeded.
    // Failure to invalidate just means the next page render uses the stale
    // snapshot until its TTL elapses — not a correctness issue worth
    // surfacing.
  }
}
