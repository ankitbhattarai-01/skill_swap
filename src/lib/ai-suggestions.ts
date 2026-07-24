import { supabase } from "@/integrations/supabase/client";

// `action` makes the dashboard tile clickable and deep-links into the rest of
// the app. Resolved server-side from the LLM's `ref` field (with a type-based
// fallback) so every tile is guaranteed to have a destination.
export type AiSuggestionAction =
  // `skillName` is the skill the message is about (teacher's skill for a match,
  // skill to learn for a swap). `swapMySkillName` only applies to a reciprocal
  // swap: the skill the current user teaches back, so the swap dialog can
  // pre-select BOTH legs to match the skills the message named.
  //
  // The `*SkillId` twins are what let a tile open the booking / swap dialog on
  // the spot instead of dropping the user on a profile to re-pick the skill by
  // hand. They're optional because cache rows written before the engine started
  // sending them still exist; the client falls back to a name lookup then.
  | {
      kind: "user";
      userId: string;
      skillName?: string;
      skillId?: string;
      swapMySkillName?: string;
      swapMySkillId?: string;
    }
  | { kind: "explore"; q?: string; mode?: "teachers" | "learners" }
  | { kind: "profile" }
  | { kind: "skills" };

export type AiSuggestion = {
  message: string;
  // `demand` = people waiting to learn something you teach; `trending` = a
  // skill rising platform-wide. Kept apart so the two never render with the
  // same icon when both land in one batch.
  type:
    | "trending"
    | "demand"
    | "match"
    | "progression"
    | "profile"
    | "swap"
    | "momentum"
    | "general";
  action?: AiSuggestionAction | null;
};

type AiSuggestionsResponse = {
  suggestions: AiSuggestion[];
  cached: boolean;
  generatedAt: string;
};

// ── Manual-refresh rotation ─────────────────────────────────────────────────
// The suggestions engine is deterministic: same user + same day + same
// rotation = same four tiles. That's what keeps a normal page load from
// reshuffling the card under the user. It also means the ⟳ button has to hand
// the server a NEW rotation, or it would recompute an identical answer.
//
// Persisted in localStorage so a reload keeps showing the hand the user last
// refreshed to — the dashboard's own cache replays those same tiles, and a
// counter that reset to 0 on every mount would make the two disagree.
const ROTATION_KEY = "skillswap:suggestions:rotation";
// Fallback when localStorage is unavailable (Safari private mode, storage
// disabled). Rotation still advances for the life of the tab.
let rotationMemory = 0;

export function readSuggestionsRotation(): number {
  try {
    const raw = window.localStorage.getItem(ROTATION_KEY);
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : rotationMemory;
  } catch {
    return rotationMemory;
  }
}

// Advances and persists the counter, returning the value to send. Call once
// per press of ⟳.
export function nextSuggestionsRotation(): number {
  // Wraps well below Number.MAX_SAFE_INTEGER; the server takes it modulo the
  // candidate count anyway, so the absolute value carries no meaning.
  const next = (readSuggestionsRotation() + 1) % 10_000;
  rotationMemory = next;
  try {
    window.localStorage.setItem(ROTATION_KEY, String(next));
  } catch {
    // Non-fatal: rotationMemory still advances for this tab.
  }
  return next;
}

// ── Last-known-good tiles ───────────────────────────────────────────────────
// The dashboard's own snapshot lives in sessionStorage, which is empty in a
// freshly opened tab — precisely the load where the Edge Function round trip
// is most visible, because it re-authenticates and reads its cache row before
// it can answer even a warm request. Mirroring the tiles into localStorage
// lets that first paint replay the hand the user last saw while the live call
// settles behind it, instead of parking a skeleton there.
//
// The TTL matches the server's own cache window: inside 30 minutes the
// function would hand back this very payload, so replaying it shows nothing
// staler than an ordinary cache hit would.
const LAST_SUGGESTIONS_PREFIX = "skillswap:suggestions:last";
const LAST_SUGGESTIONS_TTL_MS = 30 * 60 * 1000;

const lastSuggestionsKey = (userId: string) => `${LAST_SUGGESTIONS_PREFIX}:${userId}`;

export function readCachedSuggestions(userId: string | undefined): AiSuggestion[] | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(lastSuggestionsKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; suggestions?: AiSuggestion[] };
    if (!Array.isArray(parsed?.suggestions) || parsed.suggestions.length === 0) return null;
    if (Date.now() - (parsed.savedAt ?? 0) > LAST_SUGGESTIONS_TTL_MS) return null;
    return parsed.suggestions;
  } catch {
    return null;
  }
}

export function writeCachedSuggestions(
  userId: string | undefined,
  suggestions: AiSuggestion[],
): void {
  // An empty batch means "hide the card" — never persist that, or one failed
  // load would suppress the tiles on every subsequent cold start too.
  if (!userId || suggestions.length === 0) return;
  try {
    window.localStorage.setItem(
      lastSuggestionsKey(userId),
      JSON.stringify({ savedAt: Date.now(), suggestions }),
    );
  } catch {
    // Quota / private mode. The card just falls back to its skeleton.
  }
}

function clearCachedSuggestions(userId: string): void {
  try {
    window.localStorage.removeItem(lastSuggestionsKey(userId));
  } catch {
    // Non-fatal: the copy expires on its own within the TTL.
  }
}

// Calls the generate-suggestions Edge Function. The server runs a local,
// deterministic rules engine (no LLM) over real platform data and caches the
// result server-side for 30 minutes. Pass force=true to bypass the cache.
// The client's timezone offset rides along so streak / "days since" math on
// the server uses the user's local calendar days, matching the dashboard's
// streak chip.
//
// `rotation` is the manual-refresh counter (see nextSuggestionsRotation). The
// engine is deterministic for a given (user, day, rotation), so passing a new
// value is what makes ⟳ deal a different set of tiles instead of recomputing
// the same four.
export async function fetchAiSuggestions(
  options: { force?: boolean; rotation?: number } = {},
): Promise<AiSuggestionsResponse> {
  const { data, error } = await supabase.functions.invoke<AiSuggestionsResponse>(
    "generate-suggestions",
    {
      body: {
        force: options.force === true,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        rotation: options.rotation ?? readSuggestionsRotation(),
      },
    },
  );
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError and stashes the
    // Response on `context`. Read the body so the user sees our friendly
    // "Please wait a moment…" message instead of the generic "Edge Function
    // returned a non-2xx status code".
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === "function") {
      try {
        const raw = await ctx.text();
        const parsed = raw ? (JSON.parse(raw) as { error?: string }) : null;
        if (parsed?.error) throw new Error(parsed.error);
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message) throw parseError;
        // fall through to generic
      }
    }
    throw new Error(error.message);
  }
  if (!data?.suggestions) throw new Error("No suggestions returned");
  return data;
}

// Deletes the current user's cached suggestions row so the next
// fetchAiSuggestions() call regenerates fresh. Call this after any mutation
// that changes an engine signal (teaching/learning skills, bio, availability,
// session completion, verification) — otherwise users see stale advice
// ("1 learner wants Python") for up to 30 minutes after the change.
//
// Best-effort: errors are swallowed because a stale cache is recoverable
// (manual ↻ on the dashboard) and we never want to block a profile edit.
export async function invalidateAiSuggestionsCache(): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const userId = data?.user?.id;
  if (!userId) return;
  // Drop the local replay copy too. Leaving it behind would let the next cold
  // start paint the exact tiles this call just invalidated server-side, which
  // is the stale-advice bug the invalidation exists to prevent.
  clearCachedSuggestions(userId);
  await supabase.from("ai_suggestions").delete().eq("user_id", userId);
}

// Generic "explore" tips don't carry a skill, and the Explore page defaults to
// teacher mode ("Find a teacher"). But a tip whose intent is to TEACH ("you
// might spot something to teach", "offer a session") should land the user on
// learner mode ("Find a learner") instead — that's where people seeking skills
// are. Infer that direction from the message so a teach-oriented tip doesn't
// dump the user on Find-a-teacher. Returns undefined to leave the default.
//
// The server's engine always sets an explicit mode on explore actions now;
// this fallback only fires for cache rows generated before the rewrite.
// `\bteach\b` matches "teach" but not "teacher"/"teaches", so learn-oriented
// tips ("find a teacher") are left alone.
export function inferExploreMode(message: string): "learners" | undefined {
  return /\b(teach|offer)\b/i.test(message) ? "learners" : undefined;
}
