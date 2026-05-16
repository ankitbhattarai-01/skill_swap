import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type FeatureFlags = {
  "features.ai_suggestions.enabled"?: { enabled?: boolean };
  "features.video_calls.enabled"?: { enabled?: boolean };
  "features.public_explore.enabled"?: { enabled?: boolean };
  "signup.starting_credits"?: { value?: number };
  "sessions.default_credits_per_hour"?: { value?: number };
};

const FEATURE_FLAGS_KEY = ["admin-feature-flags"] as const;

export function useFeatureFlags() {
  return useQuery({
    queryKey: FEATURE_FLAGS_KEY,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_feature_flags");
      // Fail-soft: feature flags are optional. If the RPC is unavailable
      // (e.g. RLS/grant misconfiguration) the app should keep working with
      // every flag returning its default value, not blow up with a query
      // error. Migration 20260513150000 restores DB-side access.
      if (error) return {} as FeatureFlags;
      return (data ?? {}) as FeatureFlags;
    },
  });
}

export function useFeatureEnabled(key: keyof FeatureFlags, defaultValue = true) {
  const { data } = useFeatureFlags();
  const flag = data?.[key];
  if (!flag || typeof flag !== "object") return defaultValue;
  if ("enabled" in flag && typeof flag.enabled === "boolean") return flag.enabled;
  return defaultValue;
}
