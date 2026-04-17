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

export async function exchangeAuthCodeFromUrl() {
  const url = getCurrentUrl();
  if (!url) return { handled: false, error: null as string | null };

  const redirectError = getAuthRedirectError();
  if (redirectError) {
    cleanAuthRedirectParams();
    return { handled: true, error: redirectError };
  }

  const code = url.searchParams.get("code");
  if (!code) return { handled: false, error: null as string | null };

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  cleanAuthRedirectParams();
  return { handled: true, error: error?.message ?? null };
}
