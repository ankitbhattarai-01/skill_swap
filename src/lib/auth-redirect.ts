import { supabase } from "@/integrations/supabase/client";

const AUTH_QUERY_PARAMS = ["code", "error", "error_code", "error_description", "type"];

function getCurrentUrl() {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href);
}

export function hasAuthRedirectParams() {
  const url = getCurrentUrl();
  if (!url) return false;
  return AUTH_QUERY_PARAMS.some((param) => url.searchParams.has(param));
}

export function getAuthRedirectError() {
  const url = getCurrentUrl();
  if (!url) return null;
  return (
    url.searchParams.get("error_description") ??
    url.searchParams.get("error_code") ??
    url.searchParams.get("error")
  );
}

export function cleanAuthRedirectParams() {
  const url = getCurrentUrl();
  if (!url) return;

  for (const param of AUTH_QUERY_PARAMS) {
    url.searchParams.delete(param);
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, document.title, next);
}

export type AuthRedirectResult = {
  handled: boolean;
  error: string | null;
};

// AuthProvider and the /auth/callback route both call this on mount. Without
// dedupe they race on `exchangeCodeForSession(code)` — the first call consumes
// the single-use PKCE verifier from localStorage and the second call surfaces
// the misleading "PKCE code verifier not found in storage" error. Cache the
// in-flight promise so concurrent callers share one exchange.
let inflight: Promise<AuthRedirectResult> | null = null;

function friendlyExchangeError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/code verifier/i.test(message)) {
    return "This verification link can only be opened in the same browser you signed up from. Please log in here to continue.";
  }
  if (/code.*(already used|invalid|expired)/i.test(message)) {
    return "This sign-in link has already been used or has expired. Please request a new one.";
  }
  return message;
}

async function runExchange(): Promise<AuthRedirectResult> {
  const url = getCurrentUrl();
  if (!url) return { handled: false, error: null };

  const redirectError = getAuthRedirectError();
  if (redirectError) {
    cleanAuthRedirectParams();
    return { handled: true, error: friendlyExchangeError(redirectError) };
  }

  const code = url.searchParams.get("code");
  if (!code) return { handled: false, error: null };

  // Strip the params from the URL up front so any re-entrant caller (e.g. a
  // remount) sees no code and short-circuits to handled=false instead of
  // racing on the same single-use code.
  cleanAuthRedirectParams();

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return { handled: true, error: friendlyExchangeError(error?.message ?? null) };
}

export function exchangeAuthCodeFromUrl(): Promise<AuthRedirectResult> {
  if (inflight) return inflight;
  inflight = runExchange().finally(() => {
    inflight = null;
  });
  return inflight;
}
