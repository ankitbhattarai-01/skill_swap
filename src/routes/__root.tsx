import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth-context";
import { AuthGateProvider } from "@/lib/auth-gate";
import { ThemeProvider, themeInitScript } from "@/lib/theme-context";
import { SiteHeader } from "@/components/SiteHeader";
import { IncomingRequestBanner } from "@/components/IncomingRequestBanner";
import { MessageHeadsUp } from "@/components/MessageHeadsUp";
import { IncomingCallToast } from "@/components/IncomingCallToast";
import { SessionEventHeadsUp } from "@/components/SessionEventHeadsUp";
import { CreditBalanceRealtimeBridge } from "@/hooks/useMyCreditBalance";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/sonner";
import { installClientLogging } from "@/lib/client-logger";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center glass rounded-3xl p-10">
        <h1 className="text-7xl font-bold gradient-brand-text">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-xl gradient-brand px-5 py-2.5 text-sm font-medium text-white shadow-glow hover:opacity-95 transition-all"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5",
      },
      { name: "theme-color", content: "#7c3aed", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#050505", media: "(prefers-color-scheme: dark)" },
      { name: "color-scheme", content: "light dark" },
      { name: "format-detection", content: "telephone=no" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { title: "SkillSwap - Teach. Learn. Grow Together." },
      {
        name: "description",
        content:
          "SkillSwap is a student skill-exchange platform. Learn what you need and teach what you know using credits, not money.",
      },
      { name: "author", content: "SkillSwap" },
      { property: "og:title", content: "SkillSwap - Teach. Learn. Grow Together." },
      {
        property: "og:description",
        content:
          "Student skill-exchange platform powered by credits. Match, message, and learn from peers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/brand-mark.png", type: "image/png" },
      { rel: "icon", href: "/icon-light-32x32.png", media: "(prefers-color-scheme: light)" },
      { rel: "icon", href: "/icon-dark-32x32.png", media: "(prefers-color-scheme: dark)" },
      { rel: "apple-touch-icon", href: "/apple-icon.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning: themeInitScript sets <html style="color-scheme">
  // and the `dark` class before React hydrates, so the SSR'd markup
  // intentionally diverges from the hydrated DOM. React would otherwise log a
  // hydration mismatch for the <html> element on every load.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Single QueryClient for the whole app. Defaults keep network noise low:
// data is fresh for 30s before re-fetch, retries fail fast (1 retry), and
// we don't auto-refetch on every focus change — most SkillSwap data is
// authoritatively pushed through realtime channels.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function RootComponent() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    installClientLogging();
  }, []);

  // Stable identity so the memoized SiteHeader doesn't re-render every parent
  // tick just because of a fresh inline arrow.
  const toggleSidebar = useCallback(() => setSidebarCollapsed((current) => !current), []);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const usesStandaloneLayout =
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname === "/signup" ||
    pathname === "/onboarding" ||
    pathname === "/skills";

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthGateProvider>
            {/* These mount globally and subscribe to realtime channels.
                Wrapping each in its own boundary means a crash in one
                (e.g. a malformed realtime payload) can't blank the whole
                app — the boundary swallows it and the rest keeps working. */}
            <ErrorBoundary label="CreditBalanceRealtimeBridge">
              <CreditBalanceRealtimeBridge />
            </ErrorBoundary>
            {usesStandaloneLayout ? (
              <div className="min-h-screen w-full">
                <Outlet />
              </div>
            ) : (
              <div className="flex min-h-screen w-full flex-col">
                <SiteHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
                <div
                  className="min-h-screen pt-[calc(118px+env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8 md:pt-16 md:[padding-left:var(--sidebar-width)] md:transition-[padding-left] md:duration-500 md:ease-[cubic-bezier(0.32,0.72,0,1)]"
                  style={{ "--sidebar-width": `${sidebarCollapsed ? 72 : 192}px` } as CSSProperties}
                >
                  <ErrorBoundary label="IncomingRequestBanner">
                    <IncomingRequestBanner />
                  </ErrorBoundary>
                  <ErrorBoundary label="MessageHeadsUp">
                    <MessageHeadsUp />
                  </ErrorBoundary>
                  <ErrorBoundary label="IncomingCallToast">
                    <IncomingCallToast />
                  </ErrorBoundary>
                  <ErrorBoundary label="SessionEventHeadsUp">
                    <SessionEventHeadsUp />
                  </ErrorBoundary>
                  <Outlet />
                </div>
              </div>
            )}
            <Toaster richColors position="top-center" offset={80} />
          </AuthGateProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
