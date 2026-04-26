export type CaptchaProvider = "turnstile" | "hcaptcha";

export type CaptchaConfig = {
  provider: CaptchaProvider;
  siteKey: string;
};

export function getAuthCaptchaConfig(): CaptchaConfig | null {
  const turnstileKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
  const hcaptchaKey = import.meta.env.VITE_HCAPTCHA_SITE_KEY?.trim();

  if (turnstileKey) return { provider: "turnstile", siteKey: turnstileKey };
  if (hcaptchaKey) return { provider: "hcaptcha", siteKey: hcaptchaKey };
  return null;
}

export function isAuthCaptchaConfigured() {
  return getAuthCaptchaConfig() !== null;
}

// True when a CAPTCHA token must be supplied with auth submissions.
// Why: production builds without a configured provider were fail-open —
// the UI skipped the check entirely. In prod we now require it regardless,
// so a missing site key blocks submission instead of silently bypassing.
// Dev builds stay permissive so local sign-in works without provider keys.
export function isAuthCaptchaRequired() {
  return import.meta.env.PROD || isAuthCaptchaConfigured();
}
