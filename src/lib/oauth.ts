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

function couldNotStartMessage(provider: Provider): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return `${label} sign-in could not be started.`;
}

async function prepareOAuth(provider: Provider, redirectTo: string): Promise<OAuthStartResult> {
  // skipBrowserRedirect lets us own the navigation — important because we want
  // the PKCE verifier (written to localStorage by signInWithOAuth) to be in
  // place BEFORE we leave the page. We then navigate ourselves so any failure
  // in the pre-flight surfaces as a normal error before the user is teleported
  // to a half-broken Supabase URL.
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

  return { url: data.url, errorMessage: null };
}

export function prepareGoogleOAuth(redirectTo: string): Promise<OAuthStartResult> {
  return prepareOAuth("google", redirectTo);
}

export function prepareGitHubOAuth(redirectTo: string): Promise<OAuthStartResult> {
  return prepareOAuth("github", redirectTo);
}
