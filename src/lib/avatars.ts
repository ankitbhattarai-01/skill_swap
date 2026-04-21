import { supabase } from "@/integrations/supabase/client";

const AVATAR_TTL_SECONDS = 60 * 60;
const AVATAR_CACHE_MAX_AGE_MS = 50 * 60 * 1000;
const AVATAR_SIGN_TIMEOUT_MS = 1800;
const AVATAR_CACHE_KEY = "skillswap-avatar-cache";
// Bound to prevent unbounded growth in long sessions. Explore + admin pages
// can scroll through thousands of distinct avatars over an hour; without a
// cap the in-memory Map grows until the tab is reloaded. 500 entries is
// well over a single page's working set but still bounded.
const AVATAR_MEMORY_CACHE_MAX = 500;
const AVATAR_STORAGE_CACHE_MAX = 500;

type AvatarCacheEntry = {
  signedUrl: string;
  savedAt: number;
};

// JS Map iteration is insertion-ordered, so the first key is the oldest insert.
// Re-inserting on read promotes the entry to "most recently used" — giving us
// a cheap LRU without an external dependency.
const memoryCache = new Map<string, AvatarCacheEntry>();

function readStoredCache() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(AVATAR_CACHE_KEY) ?? "{}") as Record<
      string,
      AvatarCacheEntry
    >;
  } catch {
    return {};
  }
}

// Prunes the stored cache to AVATAR_STORAGE_CACHE_MAX entries, keeping the
// newest by savedAt. Also drops entries past their TTL.
function pruneStoredCache(cache: Record<string, AvatarCacheEntry>) {
  const now = Date.now();
  const fresh = Object.entries(cache).filter(
    ([, entry]) => now - entry.savedAt < AVATAR_CACHE_MAX_AGE_MS,
  );
  if (fresh.length <= AVATAR_STORAGE_CACHE_MAX) return Object.fromEntries(fresh);
  fresh.sort((a, b) => b[1].savedAt - a[1].savedAt);
  return Object.fromEntries(fresh.slice(0, AVATAR_STORAGE_CACHE_MAX));
}

function writeStoredCache(cache: Record<string, AvatarCacheEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(pruneStoredCache(cache)));
  } catch {
    // Cache writes are only a speed boost.
  }
}

function touchMemoryEntry(path: string, entry: AvatarCacheEntry) {
  // Reinsert to mark as most-recently used in the Map's iteration order.
  memoryCache.delete(path);
  memoryCache.set(path, entry);
}

function evictMemoryIfNeeded() {
  while (memoryCache.size > AVATAR_MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function getCachedAvatar(path: string) {
  const now = Date.now();
  const memory = memoryCache.get(path);
  if (memory && now - memory.savedAt < AVATAR_CACHE_MAX_AGE_MS) {
    touchMemoryEntry(path, memory);
    return memory.signedUrl;
  }
  // Stale memory entry — drop it so we don't keep it pinned past TTL.
  if (memory) memoryCache.delete(path);

  const stored = readStoredCache();
  const entry = stored[path];
  if (!entry || now - entry.savedAt >= AVATAR_CACHE_MAX_AGE_MS) return null;

  memoryCache.set(path, entry);
  evictMemoryIfNeeded();
  return entry.signedUrl;
}

function cacheAvatar(path: string, signedUrl: string) {
  const entry = { signedUrl, savedAt: Date.now() };
  memoryCache.delete(path);
  memoryCache.set(path, entry);
  evictMemoryIfNeeded();
  const stored = readStoredCache();
  stored[path] = entry;
  writeStoredCache(stored);
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

// Returns a Map<path, signedUrl> for the given storage paths. Filters out
// nullish entries and de-duplicates so we make a single batched request.
export async function signAvatarUrls(paths: (string | null | undefined)[]) {
  const map = new Map<string, string>();
  const valid = Array.from(new Set(paths.filter((p): p is string => Boolean(p))));
  if (!valid.length) return map;

  const missing: string[] = [];
  for (const path of valid) {
    const cached = getCachedAvatar(path);
    if (cached) {
      map.set(path, cached);
    } else {
      missing.push(path);
    }
  }
  if (!missing.length) return map;

  try {
    const result = await withTimeout(
      supabase.storage.from("avatars").createSignedUrls(missing, AVATAR_TTL_SECONDS),
      AVATAR_SIGN_TIMEOUT_MS,
    );
    if (!result) return map;

    const { data } = result;
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        map.set(item.path, item.signedUrl);
        cacheAvatar(item.path, item.signedUrl);
      }
    }
  } catch {
    return map;
  }
  return map;
}

export async function signSingleAvatarUrl(path: string | null | undefined) {
  if (!path) return null;
  const map = await signAvatarUrls([path]);
  return map.get(path) ?? null;
}
