import { createRouter, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { routeTree } from "./routeTree.gen";
import { PageLoading, type PageLoadingVariant } from "@/components/PageLoading";
import { logClientError } from "@/lib/client-logger";

// The pending fallback renders while a route's code-split chunk (and any
// loader) is still in flight — i.e. before the route file itself is available
// to say what its skeleton looks like. Mapping pathname → variant here keeps
// the pending frame identical to the loading gate the route renders next, so
// a cold navigation paints one continuous skeleton instead of a generic one
// that swaps for the real one mid-load. (Importing the route files to ask
// them directly would drag every route into the entry chunk.)
function pendingVariantFor(pathname: string): PageLoadingVariant {
  if (pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/profile") || pathname.startsWith("/users/")) return "profile";
  // Before the /credits check — the buy page is a different shell.
  if (pathname.startsWith("/credits/buy")) return "credits-buy";
  if (pathname.startsWith("/credits")) return "credits";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/sessions/")) return "detail";
  if (pathname.startsWith("/video/")) return "video";
  if (pathname.startsWith("/notifications")) return "list";
  if (pathname.startsWith("/explore")) return "list-wide";
  if (pathname.startsWith("/history")) return "hero-stats";
  if (pathname === "/admin" || pathname === "/admin/") return "admin";
  if (pathname.startsWith("/admin/")) return "list-wide";
  // Landing, auth, and onboarding pages have no skeleton shell — a neutral
  // spinner beats guessing a layout that won't match.
  return "simple";
}

function RoutePendingFallback() {
  // During a pending navigation `state.location` already points at the
  // destination, so the fallback matches the page being navigated TO.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <PageLoading variant={pendingVariantFor(pathname)} />;
}

function DefaultErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  useEffect(() => {
    logClientError(error, "router.defaultErrorComponent");
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Please try again.
        </p>
        {import.meta.env.DEV && error.message && (
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    scrollRestoration: true,
    // Match TanStack Query's defaultOptions.queries.staleTime (30s). At 0,
    // every hover-preload was treated as immediately stale, so the navigation
    // that followed a hover re-ran the loader and waited for the network
    // instead of reusing the just-prefetched data.
    defaultPreloadStaleTime: 30 * 1000,
    defaultErrorComponent: DefaultErrorComponent,
    defaultPendingComponent: RoutePendingFallback,
    defaultPendingMs: 0,
  });

  return router;
};
