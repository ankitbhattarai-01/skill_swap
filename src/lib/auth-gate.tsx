import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

type AuthGateContextValue = {
  requireAuth: (callback?: () => void, message?: string) => boolean;
};

const AuthGateContext = createContext<AuthGateContextValue>({
  requireAuth: () => false,
});

import { useAuth } from "./auth-context";

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>("Please log in or sign up to continue.");

  const requireAuth = useCallback(
    (callback?: () => void, customMessage?: string) => {
      if (user) {
        callback?.();
        return true;
      }
      setMessage(customMessage ?? "Please log in or sign up to continue.");
      setOpen(true);
      return false;
    },
    [user],
  );

  const goToAuth = useCallback(
    (mode: "login" | "signup") => {
      const redirect = window.location.pathname + window.location.search;
      setOpen(false);
      navigate({
        to: mode === "login" ? "/login" : "/signup",
        search: { redirect },
      });
    },
    [navigate],
  );

  const value = useMemo<AuthGateContextValue>(() => ({ requireAuth }), [requireAuth]);

  return (
    <AuthGateContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl gradient-brand shadow-glow">
              <Lock className="h-6 w-6 text-white" />
            </div>
            <DialogTitle className="text-center text-xl">Authentication required</DialogTitle>
            <DialogDescription className="text-center">{message}</DialogDescription>
          </DialogHeader>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Button variant="outline" size="lg" onClick={() => goToAuth("login")}>
              Log In
            </Button>
            <Button variant="hero" size="lg" onClick={() => goToAuth("signup")}>
              Sign Up
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AuthGateContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuthGate() {
  return useContext(AuthGateContext);
}
