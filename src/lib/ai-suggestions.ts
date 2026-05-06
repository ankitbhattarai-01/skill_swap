import { supabase } from "@/integrations/supabase/client";

// `action` makes the dashboard tile clickable and deep-links into the rest of
// the app. Resolved server-side from the LLM's `ref` field (with a type-based
// fallback) so every tile is guaranteed to have a destination.
export type AiSuggestionAction =
  | { kind: "user"; userId: string; skillName?: string }
  | { kind: "explore"; q?: string; mode?: "teachers" | "learners" }
  | { kind: "profile" }
  | { kind: "skills" };

export type AiSuggestion = {
  message: string;
  type: "trending" | "match" | "progression" | "profile" | "swap" | "momentum" | "general";
  action?: AiSuggestionAction | null;
};

type AiSuggestionsResponse = {
  suggestions: AiSuggestion[];
  cached: boolean;
  generatedAt: string;
};

// Calls the generate-suggestions Edge Function. Returns Gemini-generated
// personalized suggestions for the current user, cached server-side for
// 6 hours. Pass force=true to bypass the cache.
export async function fetchAiSuggestions(
  options: { force?: boolean } = {},
): Promise<AiSuggestionsResponse> {
  const { data, error } = await supabase.functions.invoke<AiSuggestionsResponse>(
    "generate-suggestions",
    { body: { force: options.force === true } },
  );
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError and stashes the
    // Response on `context`. Read the body so the user sees our friendly
    // "Please wait a moment…" / "Gemini error 500" instead of the
    // generic "Edge Function returned a non-2xx status code".
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
  // Belt-and-suspenders: also tidy on the client so the existing 6-hour cache
  // displays cleanly without waiting for the server-side rewrite to refresh.
  return { ...data, suggestions: data.suggestions.map(tidySuggestion) };
}

// Deletes the current user's cached AI suggestions row so the next
// fetchAiSuggestions() call regenerates fresh. Call this after any mutation
// that changes a grounding signal Gemini sees (teaching/learning skills,
// bio, etc.) — otherwise users see stale advice ("1 learner wants Python")
// for up to 6 hours after deleting the relevant skill.
//
// Best-effort: errors are swallowed because a stale cache is recoverable
// (manual ↻ on the dashboard) and we never want to block a profile edit.
export async function invalidateAiSuggestionsCache(): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const userId = data?.user?.id;
  if (!userId) return;
  await supabase.from("ai_suggestions").delete().eq("user_id", userId);
}

function tidySuggestion(s: AiSuggestion): AiSuggestion {
  return { ...s, message: tidyMessage(s.message) };
}

// Mirror of the same fn in supabase/functions/generate-suggestions/index.ts.
// Converts em/en dashes used as sentence separators into periods, bare dashes
// into commas, and collapses the leftover whitespace. Also rewrites messages
// that lead with a digit (the prompt forbids it, but cached suggestions from
// before the prompt update can still slip through).
function tidyMessage(message: string): string {
  const cleaned = message
    .replace(/\s+[—–]\s+/g, ". ")
    .replace(/[—–]/g, ", ")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
  return rewriteLeadingNumber(cleaned);
}

function rewriteLeadingNumber(msg: string): string {
  // "1 learner wants X. ..."  /  "3 learners want X. ..."
  const m = msg.match(/^(\d+)\s+learners?\s+wants?\s+(.+?)\.\s*(.*)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const skill = m[2].trim();
    const rest = m[3].trim();
    const lead =
      n === 1 ? `Someone wants to learn ${skill}.` : `${skill} has ${n} learners waiting.`;
    return rest ? `${lead} ${rest}` : lead;
  }
  // "5 days since your last session. ..."
  if (/^\d+\s+days?\s+since\b/i.test(msg)) return `It's been ${msg}`;
  // "4 sessions this month, ..." / "4 sessions taught this month..."
  if (/^\d+\s+sessions?\b/i.test(msg)) return `You've had ${msg}`;
  return msg;
}
