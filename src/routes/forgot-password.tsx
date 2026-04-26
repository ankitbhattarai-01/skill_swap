import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { CaptchaChallenge } from "@/components/CaptchaChallenge";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isAuthCaptchaConfigured, isAuthCaptchaRequired } from "@/lib/captcha";
import { toastError } from "@/lib/errors";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Reset Password - SkillSwap" }] }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetSignal, setCaptchaResetSignal] = useState(0);
  const captchaConfigured = isAuthCaptchaConfigured();

  const resetCaptcha = () => {
    setCaptchaToken(null);
    setCaptchaResetSignal((value) => value + 1);
  };

  const requireCaptchaToken = () => {
    if (captchaToken) return true;
    if (!isAuthCaptchaRequired()) return true;
    toast.error(
      captchaConfigured
        ? "Complete the security check first."
        : "Password reset is temporarily unavailable. Please contact support.",
    );
    return false;
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || cooldown > 0) return;
    if (!requireCaptchaToken()) return;

    setLoading(true);
    const requestedEmail = email.trim();
    const { error } = await supabase.auth.resetPasswordForEmail(requestedEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
      captchaToken: captchaToken ?? undefined,
    });
    setLoading(false);
    resetCaptcha();

    if (error) {
      if (error.message.toLowerCase().includes("rate limit")) setCooldown(120);
      return toastError(error);
    }

    setSentEmail(requestedEmail);
    setCooldown(45);
    toast.success("Password reset email sent.");
  };

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
          {sentEmail ? (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Check your email</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  If an account exists for{" "}
                  <span className="font-medium text-foreground">{sentEmail}</span>, you'll get a
                  password reset link shortly.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={cooldown > 0 || loading}
                onClick={() => void handleSubmit(new Event("submit") as unknown as FormEvent)}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend reset email"}
              </Button>
              <CaptchaChallenge onTokenChange={setCaptchaToken} resetSignal={captchaResetSignal} />
              <button
                type="button"
                onClick={() => {
                  setSentEmail(null);
                  resetCaptcha();
                }}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Mail className="h-6 w-6" />
              </div>
              <h1 className="text-2xl font-bold text-center">Reset your password</h1>
              <p className="text-sm text-muted-foreground text-center mt-1">
                Enter your email and we'll send a secure reset link.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
                <CaptchaChallenge
                  onTokenChange={setCaptchaToken}
                  resetSignal={captchaResetSignal}
                  className="pt-1"
                />
                <Button
                  type="submit"
                  variant="hero"
                  size="lg"
                  className="w-full"
                  disabled={loading || cooldown > 0}
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {cooldown > 0 ? `Try again in ${cooldown}s` : "Send reset link"}
                </Button>
              </form>
            </>
          )}

          <p className="text-sm text-muted-foreground text-center mt-6">
            Remembered it?{" "}
            <Link to="/login" className="text-foreground font-medium hover:underline">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
