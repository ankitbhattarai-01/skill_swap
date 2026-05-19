import { supabase } from "@/integrations/supabase/client";
import type { Provider } from "@supabase/supabase-js";

type OAuthStartResult = {
  url: string | null;
  errorMessage: string | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

function unavailableMessage(provider: Provider): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return `${label} sign-in is not available right now.`;
}

function couldNotStartMessage(provider: Provider): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return `${label} sign-in could not be started.`;
}

async function readOAuthError(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as {
      msg?: string;
      message?: string;
    } | null;
    return body?.msg ?? body?.message ?? null;
  }

  return null;
}

async function prepareOAuth(
  provider: Provider,
  redirectTo: string,
): Promise<OAuthStartResult> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    return { url: null, errorMessage: error.message };
  }

  if (!data.url) {
    return { url: null, errorMessage: couldNotStartMessage(provider) };
  }

  const response = await fetch(data.url, {
    headers: { accept: "application/json" },
    redirect: "manual",
  }).catch(() => null);

  if (!response) {
    return { url: null, errorMessage: unavailableMessage(provider) };
  }

  // When the provider is enabled, Supabase replies with a 302 to the upstream
  // OAuth URL. With `redirect: "manual"` the browser surfaces that as an
  // opaqueredirect response (type === "opaqueredirect", status === 0, ok === false).
  // Treat it as success — we'll navigate to data.url ourselves.
  if (response.type === "opaqueredirect") {
    return { url: data.url, errorMessage: null };
  }

  if (!response.ok) {
    const message = await readOAuthError(response);
    return { url: null, errorMessage: message ?? unavailableMessage(provider) };
  }

  const body = (await response.json().catch(() => null)) as { url?: string } | null;

  return {
    url: body?.url ?? data.url,
    errorMessage: null,
  };
}

export function prepareGoogleOAuth(redirectTo: string): Promise<OAuthStartResult> {
  return prepareOAuth("google", redirectTo);
}

export function prepareGitHubOAuth(redirectTo: string): Promise<OAuthStartResult> {
  return prepareOAuth("github", redirectTo);
}
