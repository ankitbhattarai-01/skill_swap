// Tiny registry of the page-level sessionStorage caches used to skip the
// first-paint skeleton on dashboard, explore, and credits. Each of those
// pages writes a snapshot of its server state on every successful load and
// re-reads it on next mount.
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

import { invalidateAvailabilityCache } from "@/lib/availability-cache";

const EXPLORE_CACHE_KEY = "skillswap-explore-cache";
const EXPLORE_LEARNERS_CACHE_KEY = "skillswap-explore-learners-cache";
const DASHBOARD_CACHE_PREFIX = "skillswap-dashboard-cache";
const CREDITS_CACHE_PREFIX = "skillswap-credits-cache";
// Keyed per session id (and per viewer), so there is no single key to remove —
// invalidation sweeps the prefix. Exported because sessions/$sessionId owns the
// read/write side and must not re-declare the string.
export const SESSION_DETAIL_CACHE_PREFIX = "skillswap-session-detail-cache";
// The profile page's own snapshot (name, bio, skills, badges). Deliberately NOT
// swept by invalidatePageCaches: session lifecycle and credit movement — the
// bulk of that function's callers — change nothing the profile renders, and
// dropping the snapshot there would put the skeleton back on the very visits
// this cache exists to speed up. The profile page rewrites its own snapshot
// after every local edit; use invalidateProfileCache for edits made elsewhere.
export const PROFILE_CACHE_PREFIX = "skillswap-profile-cache";

// Drops the profile snapshot for one user. Call from any page outside /profile
// that writes the user's name, bio, avatar, or teaching/learning skills.
export function invalidateProfileCache(userId?: string | null) {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.sessionStorage.removeItem(`${PROFILE_CACHE_PREFIX}-${userId}`);
  } catch {
    // Same reasoning as below — a failed invalidation costs one stale paint.
  }
}

export function invalidatePageCaches(userId?: string | null) {
  // Availability lives in memory, not sessionStorage, but it goes stale for
  // exactly the same reasons and every caller of this function is a session or
  // credit mutation — so it is swept here rather than needing its own call at
  // each site.
  invalidateAvailabilityCache();
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(EXPLORE_CACHE_KEY);
    window.sessionStorage.removeItem(EXPLORE_LEARNERS_CACHE_KEY);
    if (userId) {
      window.sessionStorage.removeItem(`${DASHBOARD_CACHE_PREFIX}-${userId}`);
      window.sessionStorage.removeItem(`${CREDITS_CACHE_PREFIX}-${userId}`);
    }
    const staleSessionDetails: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(SESSION_DETAIL_CACHE_PREFIX)) staleSessionDetails.push(key);
    }
    staleSessionDetails.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // sessionStorage can throw in private mode / when quota is exceeded.
    // Failure to invalidate just means the next page render uses the stale
    // snapshot until its TTL elapses — not a correctness issue worth
    // surfacing.
  }
}
