import { supabase } from "@/integrations/supabase/client";

export type AiSuggestion = {
  message: string;
  type: "trending" | "match" | "progression" | "profile" | "swap" | "momentum" | "general";
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
  return data;
}
