import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { PageLoading } from "@/components/PageLoading";
import { exchangeAuthCodeFromUrl } from "@/lib/auth-redirect";
import { resolvePostAuthRoute, safeRedirectPath } from "@/lib/redirect";
import { humanizeError } from "@/lib/errors";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/auth/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    next: safeRedirectPath(s.next, "/dashboard"),
  }),
  head: () => ({ meta: [{ title: "SkillSwap" }] }),
  component: AuthCallbackPage,
});

// The visible "Signing you in" card used to live here. We now hand off to
// AuthProvider's transparent exchange (deduped in [[auth-redirect]]) and just
// render the destination's loading skeleton, so users see one continuous load
// from Google's redirect into the dashboard with no intermediate card.
function AuthCallbackPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { user, loading } = useAuth();
  const navigatedRef = useRef(false);

  // Drive the exchange ourselves too - exchangeAuthCodeFromUrl dedupes with
  // AuthProvider's call so this is safe. Without this, hard refreshes that
  // land directly on /auth/callback (skipping the provider's first mount) get
  // stuck on the skeleton.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await exchangeAuthCodeFromUrl();
      if (cancelled || !result.error) return;
      toast.error(humanizeError(result.error));
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        navigate({ to: "/login", search: { redirect: search.next }, replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, search.next]);

  useEffect(() => {
    if (loading || navigatedRef.current || !user) return;
    // Reserve the slot synchronously so a re-render before the async resolve
    // finishes can't double-navigate.
    navigatedRef.current = true;
    let cancelled = false;
    void resolvePostAuthRoute(user.id, search.next).then((to) => {
      if (cancelled) return;
      navigate({ to, replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [loading, user, navigate, search.next]);

  return <PageLoading variant="simple" />;
}
