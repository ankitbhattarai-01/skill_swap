import { supabase } from "@/integrations/supabase/client";

// The curated skills catalog, shared by every "add a skill" combobox.
//
// Only `is_active` rows are served. The catalog is curated and selection-only
// (see 20260724000000_curated_skill_catalog.sql) — retired skills stay in the
// table so existing profiles and session history still render, but they must
// never be offered as something new to teach or learn.
//
// It is public, read-mostly reference data, but the profile page used to
// re-download all of it on every single visit — as one of five queries in a
// Promise.all, so the slowest of them gated the verified ticks and the rest of
// the secondary UI too. Most visits never open the combobox at all.
//
// Serve it stale-while-revalidate instead: hand back the session snapshot
// synchronously (no await, no skeleton) and refresh in the background at most
// once per staleness window. Concurrent callers share one in-flight request.

export type CatalogSkill = { id: string; name: string; category: string | null };

// Bumped when the catalog became curated: the old key holds snapshots that
// still contain user-created skills, and a stale one would keep offering them
// in the combobox until it aged out.
const CACHE_KEY = "skillswap-skills-catalog-v2";
// Long enough that a normal browsing session pays for the catalog once, short
// enough that a skill an admin adds shows up the same day.
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

type CatalogCache = { savedAt: number; skills: CatalogSkill[] };

let memoryCache: CatalogCache | null = null;
let inflight: Promise<CatalogSkill[]> | null = null;

function readCache(): CatalogCache | null {
  if (memoryCache) return memoryCache;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    memoryCache = JSON.parse(raw) as CatalogCache;
    return memoryCache;
  } catch {
    return null;
  }
}

function writeCache(skills: CatalogSkill[]) {
  memoryCache = { savedAt: Date.now(), skills };
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache));
  } catch {
    // Private mode / quota — the in-memory copy still serves this tab.
  }
}

// Whatever we already hold, regardless of age. Callers use it to seed state at
// first render so the combobox is usable before any network call resolves.
export function getCachedSkillsCatalog(): CatalogSkill[] {
  return readCache()?.skills ?? [];
}

export function isSkillsCatalogFresh(): boolean {
  const cache = readCache();
  return Boolean(cache && Date.now() - cache.savedAt < CACHE_MAX_AGE_MS);
}

export async function loadSkillsCatalog(): Promise<CatalogSkill[]> {
  const cache = readCache();
  if (cache && Date.now() - cache.savedAt < CACHE_MAX_AGE_MS) return cache.skills;
  if (inflight) return inflight;

  inflight = (async () => {
    const { data, error } = await supabase
      .from("skills")
      .select("id, name, category")
      .eq("is_active", true)
      .order("name");
    // A failed refresh must not empty a combobox that was working a moment ago,
    // so fall back to the (stale) snapshot rather than an empty list.
    if (error) return cache?.skills ?? [];
    const skills = (data ?? []) as CatalogSkill[];
    writeCache(skills);
    return skills;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
