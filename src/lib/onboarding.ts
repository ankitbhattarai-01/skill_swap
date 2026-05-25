import { supabase } from "@/integrations/supabase/client";

// Wraps the complete_onboarding() RPC with a fallback for environments
// where the lock_onboarded_flag migration hasn't been applied yet
// (PostgREST returns PGRST202 "Could not find the function … in the
// schema cache"). In that case the matching REVOKE on the onboarded
// column also isn't in place, so a direct UPDATE still works and the
// security posture stays consistent with the deployed schema.
export async function completeOnboarding(userId: string): Promise<{ error: Error | null }> {
  const { error: rpcError } = await supabase.rpc("complete_onboarding");
  if (!rpcError) return { error: null };

  const isMissingFunction =
    (rpcError as { code?: string }).code === "PGRST202" ||
    /Could not find the function/i.test(rpcError.message ?? "");

  if (!isMissingFunction) return { error: rpcError };

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ onboarded: true })
    .eq("id", userId);

  return { error: updateError };
}
