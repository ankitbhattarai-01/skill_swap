import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { exchangeAuthCodeFromUrl } from "@/lib/auth-redirect";
import { safeRedirectPath } from "@/lib/redirect";
import { humanizeError } from "@/lib/errors";

export const Route = createFileRoute("/auth/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    next: safeRedirectPath(s.next, "/dashboard"),
  }),
  head: () => ({ meta: [{ title: "Signing you in - SkillSwap" }] }),
  component: AuthCallbackPage,
});

type CallbackStatus =
  | { kind: "pending" }
  | { kind: "error"; message: string };

function AuthCallbackPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [status, setStatus] = useState<CallbackStatus>({ kind: "pending" });
  // The Supabase OAuth code is single-use — guard against React 18 strict-mode
  // double effects so we don't try to exchange the same code twice and get
  // back a confusing "invalid grant" toast on the second run.
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    let cancelled = false;
    void (async () => {
      const result = await exchangeAuthCodeFromUrl();
      if (cancelled) return;

      if (!result.handled) {
        // Landed here without a code or error in the URL — most likely a stale
        // tab refresh after the exchange already happened. Send the user to
        // their requested destination; if they aren't signed in the route
        // guard there will bounce them back to /login.
        navigate({ to: search.next, replace: true });
        return;
      }

      if (result.error) {
        setStatus({ kind: "error", message: humanizeError(result.error) });
        return;
      }

      navigate({ to: search.next, replace: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, search.next]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
      <div className="absolute inset-0 gradient-hero opacity-70 pointer-events-none" />
      <div className="relative w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <div className="glass-strong rounded-3xl p-8 shadow-card text-center">
          {status.kind === "pending" ? (
            <>
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <h1 className="mt-4 text-2xl font-bold">Signing you in</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Hang tight — we're finishing your sign-in.
              </p>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/15 text-destructive">
                <ShieldAlert className="h-6 w-6" />
              </div>
              <h1 className="mt-4 text-2xl font-bold">Sign-in didn't complete</h1>
              <p className="mt-2 text-sm text-muted-foreground">{status.message}</p>
              <Button asChild variant="outline" className="mt-6 w-full">
                <Link to="/login" search={{ redirect: search.next }}>
                  Back to log in
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
