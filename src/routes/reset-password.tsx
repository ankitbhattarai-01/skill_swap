import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, LockKeyhole } from "lucide-react";
import { toast } from "sonner";

import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError } from "@/lib/errors";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Create New Password - SkillSwap" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) return toastError(error);

    setUpdated(true);
    toast.success("Password updated.");
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
          {authLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">Checking your reset link...</p>
            </div>
          ) : updated ? (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Password updated</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  You can continue to your dashboard with your new password.
                </p>
              </div>
              <Button
                type="button"
                variant="hero"
                size="lg"
                className="w-full"
                onClick={() => navigate({ to: "/dashboard" })}
              >
                Go to dashboard
              </Button>
            </div>
          ) : user ? (
            <>
              <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <LockKeyhole className="h-6 w-6" />
              </div>
              <h1 className="text-2xl font-bold text-center">Create a new password</h1>
              <p className="text-sm text-muted-foreground text-center mt-1">
                Use at least 6 characters for your new password.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="glass border-white/10 mt-1.5 h-11"
                  />
                </div>
                <div>
                  <Label htmlFor="confirm-password">Confirm password</Label>
                  <Input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="glass border-white/10 mt-1.5 h-11"
                  />
                </div>
                <Button
                  type="submit"
                  variant="hero"
                  size="lg"
                  className="w-full"
                  disabled={loading}
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Update password
                </Button>
              </form>
            </>
          ) : (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <LockKeyhole className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Reset link needed</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your reset link is missing, expired, or has already been used. Request a fresh
                  password reset email to continue.
                </p>
              </div>
              <Button asChild variant="hero" size="lg" className="w-full">
                <Link to="/forgot-password">Request reset link</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
