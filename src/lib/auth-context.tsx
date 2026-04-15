import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { exchangeAuthCodeFromUrl } from "@/lib/auth-redirect";

type AuthUserContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
};

type AuthActionsContextValue = {
  signOut: () => Promise<void>;
};

const AuthUserContext = createContext<AuthUserContextValue>({
  user: null,
  session: null,
  loading: true,
});

const AuthActionsContext = createContext<AuthActionsContextValue>({
  signOut: async () => {},
});

// Wipes any browser-side data this app stashed for the previous user. Stops
// avatar/credit/profile leaks on shared devices when a user signs out without
// closing the tab. Anything we cache under a "skillswap" prefix gets cleared.
function scrubLocalCaches() {
  if (typeof window === "undefined") return;
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && (key.startsWith("skillswap-") || key.startsWith("skillswap."))) {
          keys.push(key);
        }
      }
      keys.forEach((key) => store.removeItem(key));
    } catch {
      // private mode / quota errors — best-effort scrub.
    }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const bootstrappingRef = useRef(true);

  useEffect(() => {
    let active = true;
    bootstrappingRef.current = true;
    setLoading(true);

    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!active) return;
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (!bootstrappingRef.current || event === "SIGNED_OUT") {
        setLoading(false);
      }
      if (event === "SIGNED_OUT") {
        scrubLocalCaches();
        void router.invalidate();
      }
    });

    (async () => {
      try {
        const result = await exchangeAuthCodeFromUrl();
        if (result.error) {
          console.error("[skillswap] email verification redirect failed", result.error);
        }

        const {
          data: { session: s },
        } = await supabase.auth.getSession();
        if (active) {
          setSession(s);
          setUser(s?.user ?? null);
        }
      } finally {
        if (active) {
          bootstrappingRef.current = false;
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  // signOut never reads from state — its closure is stable, so consumers
  // that only need it don't re-render when user/session/loading change.
  const signOut = useCallback(async () => {
    try {
      await supabase.removeAllChannels();
    } catch {
      // Best-effort — channels die anyway when the JWT is dropped.
    }
    await supabase.auth.signOut();
    scrubLocalCaches();
  }, []);

  const userValue = useMemo<AuthUserContextValue>(
    () => ({ user, session, loading }),
    [user, session, loading],
  );
  const actionsValue = useMemo<AuthActionsContextValue>(() => ({ signOut }), [signOut]);

  return (
    <AuthActionsContext.Provider value={actionsValue}>
      <AuthUserContext.Provider value={userValue}>{children}</AuthUserContext.Provider>
    </AuthActionsContext.Provider>
  );
}

// Back-compat combined hook — most consumers read user + signOut together so
// keeping a single hook means we don't have to migrate every call site.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const { user, session, loading } = useContext(AuthUserContext);
  const { signOut } = useContext(AuthActionsContext);
  return { user, session, loading, signOut };
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuthUser() {
  return useContext(AuthUserContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuthActions() {
  return useContext(AuthActionsContext);
}
