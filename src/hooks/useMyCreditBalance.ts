import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { invalidatePageCaches } from "@/lib/page-caches";

// First TanStack Query hook in the app — see __root.tsx for the provider.
// Credit balance is read on every page (header) and mutated from accept /
// complete / cancel / auto-settle paths. We layer two refresh signals:
//
//   1. Manual invalidation calls right after the local user triggers an
//      RPC (kept as a safety net — see invalidateMyCreditBalance below).
//   2. Realtime push: handled by the singleton <CreditBalanceRealtimeBridge>
//      mounted once in __root.tsx. The hook below stays read-only so any
//      number of consumers (header + dashboard + /credits + bridge) share
//      the same Query cache without duplicating channels.

export const MY_CREDIT_BALANCE_KEY = (userId: string | null | undefined) =>
  ["my-credit-balance", userId] as const;

export function useMyCreditBalance() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: MY_CREDIT_BALANCE_KEY(userId),
    enabled: Boolean(userId),
    // Realtime push via CreditBalanceRealtimeBridge invalidates this key on
    // every credit_transactions INSERT for the user — so the cached balance
    // is treated as fresh indefinitely. Without this, any consumer remount
    // past the 30s default re-issued my_credit_balance() redundantly.
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_credit_balance");
      if (error) throw error;
      return data ?? 0;
    },
  });
}

// Mounted exactly once near the QueryClient root so credit_transactions
// realtime is opened/closed at most once per app session, regardless of
// how many components also call useMyCreditBalance().
export function CreditBalanceRealtimeBridge() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`credit-balance-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "credit_transactions",
          filter: `from_user=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: MY_CREDIT_BALANCE_KEY(userId) });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "credit_transactions",
          filter: `to_user=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: MY_CREDIT_BALANCE_KEY(userId) });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  return null;
}

// Call this from anywhere that just mutated credits (accept / complete /
// cancel / etc.) so the header and any other consumers refetch on the next
// render rather than showing stale numbers.
//
// Also clears the dashboard/explore sessionStorage snapshots — those pages
// cache full-page snapshots that go stale the moment a session lifecycle or
// credit movement happens. Doing it here avoids touching every callsite.
export function invalidateMyCreditBalance(client: QueryClient, userId: string | null | undefined) {
  invalidatePageCaches(userId);
  return client.invalidateQueries({ queryKey: MY_CREDIT_BALANCE_KEY(userId) });
}

export function useInvalidateMyCreditBalance() {
  const client = useQueryClient();
  const { user } = useAuth();
  return () => invalidateMyCreditBalance(client, user?.id);
}
