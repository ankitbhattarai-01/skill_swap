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

// In-memory mirror of the sessionStorage blob, plus the pending-flush handle.
//
// Every getCachedAvatar() miss used to JSON.parse the whole blob and every
// cacheAvatar() re-serialized it, so signing one page of avatars (the dashboard
// signs ~20 across its teacher and seeker tiles) meant ~40 parse/stringify
// passes over as many as 500 long signed URLs — all on the main thread, right
// when the match tiles were trying to paint. Parse once, keep the mirror
// authoritative, and write back on a single coalesced flush.
//
// sessionStorage is per-tab, so nothing outside this module can write behind
// the mirror's back.
let storedCache: Record<string, AvatarCacheEntry> | null = null;
let flushHandle: number | null = null;

function readStoredCache(): Record<string, AvatarCacheEntry> {
  if (storedCache) return storedCache;
  // No memo without a window: keep returning a throwaway so a later
  // (hydrated) call still reads the real blob.
  if (typeof window === "undefined") return {};
  try {
    storedCache = JSON.parse(window.sessionStorage.getItem(AVATAR_CACHE_KEY) ?? "{}") as Record<
      string,
      AvatarCacheEntry
    >;
  } catch {
    storedCache = {};
  }
  return storedCache;
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

// Persists the mirror once per burst rather than once per avatar. A page that
// signs 20 avatars now pays for one prune + one stringify instead of 20 of
// each. Losing the tail of a burst to a navigation just costs a cache miss.
function scheduleStoredCacheFlush() {
  if (typeof window === "undefined" || flushHandle !== null) return;
  flushHandle = window.setTimeout(() => {
    flushHandle = null;
    try {
      const pruned = pruneStoredCache(storedCache ?? {});
      // Adopt the pruned copy so expired entries leave the mirror too.
      storedCache = pruned;
      window.sessionStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(pruned));
    } catch {
      // Cache writes are only a speed boost.
    }
  }, 250);
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

  const entry = readStoredCache()[path];
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
  // Mirror updated synchronously so the next getCachedAvatar() hits even
  // before the batched flush below has run.
  readStoredCache()[path] = entry;
  scheduleStoredCacheFlush();
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

// Display-size transform spec for Supabase Storage's image renderer. Avatars
// in the database are uploaded at full resolution (typically 400–800px square);
// the header / sidebar display them at 32–48px, which is ~95% wasted bytes
// without server-side resizing. See AvatarTransform usage in signSingleAvatarUrl.
export type AvatarTransform = {
  width: number;
  height: number;
  // 75 keeps file size small without visible artifacts at avatar sizes. Bump
  // to 85+ for larger display contexts (profile page hero).
  quality?: number;
  // "cover" matches our circular-crop UX — fills the box and crops overflow.
  resize?: "cover" | "contain" | "fill";
};

// Internal cache key. Original-path-only when no transform so existing
// non-transform callers keep their cache entries. With a transform, the
// dimensions are embedded so multiple display sizes for the same avatar
// don't collide (header 96 vs dashboard tile 128 vs profile hero 400).
function transformCacheKey(path: string, transform?: AvatarTransform): string {
  if (!transform) return path;
  return `${path}::${transform.width}x${transform.height}@${transform.quality ?? 75}`;
}

// Returns a Map<originalPath, signedUrl> for the given storage paths.
//
// Without `transform`: uses Supabase's batched createSignedUrls (one HTTP
// roundtrip) and returns full-resolution signed URLs. Behavior unchanged
// from the original implementation - existing callers needing original-size
// avatars (e.g., the profile page hero) continue to work.
//
// With `transform`: fans out to parallel per-path createSignedUrl calls
// because the batched endpoint doesn't accept a transform option in SDK v2.
// The N extra sign roundtrips (each ~1 KB) are dwarfed by the per-image
// bytes saved when the renderer downscales (e.g., 200 KB original →
// ~5 KB at 128×128). Cache keys include the transform so a future caller
// with different dimensions doesn't overwrite this one's entries.
export async function signAvatarUrls(
  paths: (string | null | undefined)[],
  transform?: AvatarTransform,
) {
  const map = new Map<string, string>();
  const valid = Array.from(new Set(paths.filter((p): p is string => Boolean(p))));
  if (!valid.length) return map;

  const missing: string[] = [];
  for (const path of valid) {
    const cached = getCachedAvatar(transformCacheKey(path, transform));
    if (cached) {
      map.set(path, cached);
    } else {
      missing.push(path);
    }
  }
  if (!missing.length) return map;

  // Transform path: fan out to per-path createSignedUrl with the transform
  // option. Promise.allSettled so a single transient failure doesn't drop
  // the rest of the batch - missing entries simply don't appear in the map,
  // which existing call sites already handle via the `?? null` fallback.
  if (transform) {
    const results = await Promise.allSettled(
      missing.map((path) =>
        withTimeout(
          supabase.storage.from("avatars").createSignedUrl(path, AVATAR_TTL_SECONDS, {
            transform: {
              width: transform.width,
              height: transform.height,
              quality: transform.quality ?? 75,
              resize: transform.resize ?? "cover",
            },
          }),
          AVATAR_SIGN_TIMEOUT_MS,
        ).then((result) => ({ path, result })),
      ),
    );
    for (const settled of results) {
      if (settled.status !== "fulfilled") continue;
      const { path, result } = settled.value;
      const signedUrl = result?.data?.signedUrl;
      if (!signedUrl) continue;
      map.set(path, signedUrl);
      cacheAvatar(transformCacheKey(path, transform), signedUrl);
    }
    return map;
  }

  // Non-transform fast path: one batched request for the whole missing set.
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

// Cache-only lookup: the signed URLs already held in memory / sessionStorage
// for these paths, with no network call at all. List pages use it to decide
// whether they can paint avatars in their FIRST render instead of rendering
// initials and then repainting the whole grid once the async signer resolves.
export function cachedAvatarUrls(
  paths: (string | null | undefined)[],
  transform?: AvatarTransform,
) {
  const map = new Map<string, string>();
  for (const path of paths) {
    if (!path) continue;
    const cached = getCachedAvatar(transformCacheKey(path, transform));
    if (cached) map.set(path, cached);
  }
  return map;
}

export async function signSingleAvatarUrl(
  path: string | null | undefined,
  transform?: AvatarTransform,
) {
  if (!path) return null;
  if (!transform) {
    // Fast path: piggy-back on the batched cache. Used by full-size contexts
    // like the profile page hero where we want the original resolution.
    const map = await signAvatarUrls([path]);
    return map.get(path) ?? null;
  }

  // Transform path: createSignedUrls (batch) doesn't accept transforms in
  // SDK v2, so we route through the singular signer. Cache key includes the
  // pixel dimensions so different display sizes don't collide.
  const cacheKey = transformCacheKey(path, transform);
  const cached = getCachedAvatar(cacheKey);
  if (cached) return cached;

  try {
    const result = await withTimeout(
      supabase.storage.from("avatars").createSignedUrl(path, AVATAR_TTL_SECONDS, {
        transform: {
          width: transform.width,
          height: transform.height,
          quality: transform.quality ?? 75,
          resize: transform.resize ?? "cover",
        },
      }),
      AVATAR_SIGN_TIMEOUT_MS,
    );
    if (!result?.data?.signedUrl) return null;
    cacheAvatar(cacheKey, result.data.signedUrl);
    return result.data.signedUrl;
  } catch {
    return null;
  }
}
