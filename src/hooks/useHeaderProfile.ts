import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { PROFILE_UPDATED_EVENT } from "@/lib/profile-events";

// What the header / sidebar needs to render. Bundled in a single hook because
// the three fetches (profile row, is_admin RPC, signed avatar URL) always
// resolve together and gating Admin link on is_admin requires the bundle to
// be present before we render the final nav. Mirrors the useMyCreditBalance
// pattern: one canonical cache key shared across every consumer.
export type HeaderProfile = {
  full_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
};

// 5 minutes is the staleness window for both name/avatar AND admin status.
// Anything mutating these (profile save, avatar upload, admin promote) calls
// the invalidator below — staleTime is the worst-case bound if invalidation
// is missed, not the expected refresh cadence. RLS still enforces actual
// admin access server-side, so a stale is_admin only affects UI gating.
const STALE_TIME_MS = 5 * 60 * 1000;

const SESSION_CACHE_PREFIX = "skillswap-header-profile-";

export const HEADER_PROFILE_KEY = (userId: string | null | undefined) =>
  ["header-profile", userId] as const;

function readSessionCache(userId: string): HeaderProfile | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(`${SESSION_CACHE_PREFIX}${userId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as HeaderProfile;
  } catch {
    // Cache is a paint-speed boost only — corrupt JSON falls back to a fetch.
    return undefined;
  }
}

function writeSessionCache(userId: string, profile: HeaderProfile) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${SESSION_CACHE_PREFIX}${userId}`,
      JSON.stringify(profile),
    );
  } catch {
    // private mode / quota — best-effort.
  }
}

export function useHeaderProfile() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();

  const query = useQuery<HeaderProfile>({
    queryKey: HEADER_PROFILE_KEY(userId),
    enabled: Boolean(userId),
    staleTime: STALE_TIME_MS,
    // Hydrate from sessionStorage so returning visitors paint name + avatar
    // synchronously instead of flashing a skeleton. Without this we lose the
    // instant-paint behaviour the previous useState+sessionStorage block had.
    initialData: userId ? readSessionCache(userId) : undefined,
    queryFn: async () => {
      if (!userId) {
        return { full_name: null, avatar_url: null, is_admin: false };
      }
      const [profileRes, adminRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, avatar_url")
          .eq("id", userId)
          .maybeSingle(),
        supabase.rpc("is_admin", { p_user: userId }),
      ]);
      if (profileRes.error) throw profileRes.error;
      const row = profileRes.data;
      if (!row) {
        return { full_name: null, avatar_url: null, is_admin: false };
      }
      // 96x96 covers 2x DPR on the 36-48px header display. The transform path
      // routes through Supabase's image renderer and caches per dimension so
      // a future full-size profile page request doesn't share this URL.
      const signed = await signSingleAvatarUrl(row.avatar_url, {
        width: 96,
        height: 96,
        quality: 75,
        resize: "cover",
      });
      const next: HeaderProfile = {
        full_name: row.full_name,
        avatar_url: signed,
        is_admin: Boolean(adminRes.data),
      };
      writeSessionCache(userId, next);
      return next;
    },
  });

  // /profile dispatches PROFILE_UPDATED_EVENT after a successful save or
  // avatar upload. Translate it to a TanStack invalidation so any open
  // SiteHeader (and any other future consumer of this key) refetches.
  useEffect(() => {
    if (!userId) return;
    const onChange = () => {
      void queryClient.invalidateQueries({ queryKey: HEADER_PROFILE_KEY(userId) });
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, onChange);
    return () => window.removeEventListener(PROFILE_UPDATED_EVENT, onChange);
  }, [userId, queryClient]);

  return query;
}
