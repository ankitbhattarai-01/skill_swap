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
