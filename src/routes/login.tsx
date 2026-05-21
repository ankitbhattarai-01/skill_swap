import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/Logo";
import { CaptchaChallenge } from "@/components/CaptchaChallenge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, MailCheck } from "lucide-react";
import { safeRedirectPath } from "@/lib/redirect";
import { prepareGitHubOAuth, prepareGoogleOAuth } from "@/lib/oauth";
import { humanizeError, toastError } from "@/lib/errors";
import { hasAuthRedirectParams } from "@/lib/auth-redirect";
import { useAuth } from "@/lib/auth-context";
import { isAuthCaptchaConfigured } from "@/lib/captcha";

// `/onboarding` is a common `redirect` target (every "Sign Up" link carries it,
// and the signup page forwards it to "Already have an account? Log in"). For a
// user who has already finished onboarding, honoring it would flash the
// onboarding form before /onboarding itself bounces them to /dashboard. Resolve
// the destination against the profile first so the flash never happens.
async function resolvePostLoginRoute(userId: string, redirect: string) {
  if (redirect !== "/onboarding") return redirect;
  const { data } = await supabase
    .from("profiles")
    .select("onboarded")
    .eq("id", userId)
    .maybeSingle();
  return data?.onboarded ? "/dashboard" : "/onboarding";
}

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>) => ({
    redirect: safeRedirectPath(s.redirect, "/dashboard"),
  }),
  head: () => ({ meta: [{ title: "Log In - SkillSwap" }] }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [emailRedirectPending] = useState(() => hasAuthRedirectParams());
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetSignal, setCaptchaResetSignal] = useState(0);
  const captchaConfigured = isAuthCaptchaConfigured();

  const resetCaptcha = () => {
    setCaptchaToken(null);
    setCaptchaResetSignal((value) => value + 1);
  };

  const requireCaptchaToken = () => {
    if (!captchaConfigured || captchaToken) return true;
    toast.error("Complete the security check first.");
    return false;
  };

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = window.setTimeout(() => setResendCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (authLoading || !user) return;
    // Email-verification redirect path takes priority — these users are mid-
    // signup and belong in onboarding, not wherever `search.redirect` points.
    if (emailRedirectPending) {
      toast.success("Email verified. Let's finish your profile.");
      navigate({ to: "/onboarding" });
      return;
    }
    // Already signed in — don't show the login form. Send them through to the
    // post-login destination (defaults to /dashboard via safeRedirectPath).
    let cancelled = false;
    void resolvePostLoginRoute(user.id, search.redirect).then((to) => {
      if (!cancelled) navigate({ to });
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, emailRedirectPending, navigate, user, search.redirect]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!requireCaptchaToken()) return;

    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: captchaToken ? { captchaToken } : undefined,
    });
    setLoading(false);
    resetCaptcha();

    if (error) {
      // Supabase returns this specific message when the project requires email
      // confirmation and the user hasn't clicked the verification link yet.
      const message = error.message?.toLowerCase() ?? "";
      if (message.includes("email not confirmed") || message.includes("not confirmed")) {
        setNeedsConfirm(true);
        toast.error("Email not verified. Check your inbox or resend the link.");
        return;
      }
      return toastError(error);
    }

    toast.success("Welcome back!");
    const to = data.user
      ? await resolvePostLoginRoute(data.user.id, search.redirect)
      : search.redirect;
    navigate({ to });
  };

  const handleResend = async () => {
    if (!email || resendCooldown > 0) return;
    if (!requireCaptchaToken()) return;

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/onboarding`,
        ...(captchaToken ? { captchaToken } : {}),
      },
    });
    resetCaptcha();

    if (error) {
      if (error.message.toLowerCase().includes("rate limit")) setResendCooldown(120);
      return toastError(error);
    }
    toast.success("Verification email resent.");
    setResendCooldown(45);
  };

  const callbackRedirectUrl = () => {
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", search.redirect);
    return callback.toString();
  };

  const handleGoogle = async () => {
    setGoogleLoading(true);
    try {
      const { url, errorMessage } = await prepareGoogleOAuth(callbackRedirectUrl());

      if (errorMessage) {
        toast.error(
          errorMessage.includes("provider is not enabled")
            ? "Google sign-in is not enabled in Supabase. Enable the Google provider in Authentication > Providers."
            : humanizeError(errorMessage),
        );
        return;
      }

      if (url) window.location.assign(url);
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleGitHub = async () => {
    setGithubLoading(true);
    try {
      const { url, errorMessage } = await prepareGitHubOAuth(callbackRedirectUrl());

      if (errorMessage) {
        toast.error(
          errorMessage.includes("provider is not enabled")
            ? "GitHub sign-in is not enabled in Supabase. Enable the GitHub provider in Authentication > Providers."
            : humanizeError(errorMessage),
        );
        return;
      }

      if (url) window.location.assign(url);
    } finally {
      setGithubLoading(false);
    }
  };

  // If we already have a user, don't paint the login form — the useEffect
  // above will navigate them away on the next tick. Showing a loader prevents
  // the "form flashes then disappears" jank.
  if (!authLoading && user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
        <div className="absolute inset-0 gradient-hero opacity-70 pointer-events-none" />
        <div className="relative">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (emailRedirectPending && authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
        <div className="absolute inset-0 gradient-hero opacity-70 pointer-events-none" />
        <div className="relative w-full max-w-md">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <div className="glass-strong rounded-3xl p-8 shadow-card text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            <h1 className="mt-4 text-2xl font-bold">Verifying email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Please wait while we finish signing you in.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
      <div className="absolute inset-0 gradient-hero opacity-70 pointer-events-none" />
      <div className="relative w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Link to="/">
            <Logo size="lg" />
          </Link>
        </div>
        <div className="glass-strong rounded-3xl p-8 shadow-card">
          <h1 className="text-2xl font-bold text-center">Welcome back</h1>
          <p className="text-sm text-muted-foreground text-center mt-1">
            Log in to continue swapping skills.
          </p>

          <Button
            variant="outline"
            size="lg"
            className="w-full mt-6"
            onClick={handleGoogle}
            type="button"
            disabled={googleLoading || githubLoading}
          >
            {googleLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleIcon />} Continue
            with Google
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full mt-3"
            onClick={handleGitHub}
            type="button"
            disabled={googleLoading || githubLoading}
          >
            {githubLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitHubIcon />} Continue
            with GitHub
          </Button>

          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-white/10" />
            OR
            <span className="h-px flex-1 bg-white/10" />
          </div>

          {needsConfirm && (
            <div className="mb-5 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-500">
              <div className="flex items-center gap-2 font-semibold">
                <MailCheck className="h-4 w-4" /> Verify your email first
              </div>
              <p className="text-xs">
                We sent a confirmation link to your inbox. Click it before logging in.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={resendCooldown > 0 || !email}
                onClick={() => void handleResend()}
              >
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend verification email"}
              </Button>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="glass border-white/10 mt-1.5 h-11"
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">Password</Label>
                <Link
                  to="/forgot-password"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="glass border-white/10 mt-1.5 h-11"
              />
            </div>
            <CaptchaChallenge
              onTokenChange={setCaptchaToken}
              resetSignal={captchaResetSignal}
              className="pt-1"
            />
            <Button type="submit" variant="hero" size="lg" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Log In
            </Button>
          </form>

          <p className="text-sm text-muted-foreground text-center mt-6">
            Don't have an account?{" "}
            <Link
              to="/signup"
              search={{ redirect: search.redirect }}
              className="text-foreground font-medium hover:underline"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path
        fill="#EA4335"
        d="M12 5c1.6 0 3 .6 4.1 1.6l3-3C17.2 1.7 14.8.5 12 .5 7.4.5 3.4 3.1 1.4 6.9l3.5 2.7C5.9 6.9 8.7 5 12 5z"
      />
      <path
        fill="#34A853"
        d="M23.5 12.3c0-.9-.1-1.7-.2-2.5H12v4.8h6.5c-.3 1.5-1.1 2.7-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.8z"
      />
      <path
        fill="#4A90E2"
        d="M5 14.4c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2L1.4 7.7C.5 9 0 10.4 0 12s.5 3 1.4 4.3L5 14.4z"
      />
      <path
        fill="#FBBC05"
        d="M12 23.5c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.1-4.2 1.1-3.3 0-6.1-1.9-7.1-4.6L1.4 16.3C3.4 20.4 7.4 23.5 12 23.5z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
      />
    </svg>
  );
}
