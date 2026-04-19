import { useEffect, useMemo, useRef, useState } from "react";
import { getAuthCaptchaConfig, type CaptchaProvider } from "@/lib/captcha";

type CaptchaChallengeProps = {
  onTokenChange: (token: string | null) => void;
  resetSignal?: number;
  className?: string;
};

type WidgetId = string | number;

type CaptchaRenderer = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme?: "auto";
    },
  ) => WidgetId;
  reset: (widgetId?: WidgetId) => void;
  remove?: (widgetId: WidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: CaptchaRenderer;
    hcaptcha?: CaptchaRenderer;
  }
}

const PROVIDER_SCRIPTS: Record<CaptchaProvider, { id: string; src: string }> = {
  turnstile: {
    id: "turnstile-captcha-script",
    src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  },
  hcaptcha: {
    id: "hcaptcha-script",
    src: "https://js.hcaptcha.com/1/api.js?render=explicit",
  },
};

function getRenderer(provider: CaptchaProvider) {
  return provider === "turnstile" ? window.turnstile : window.hcaptcha;
}

function loadCaptchaScript(provider: CaptchaProvider) {
  const { id, src } = PROVIDER_SCRIPTS[provider];
  const existing = document.getElementById(id) as HTMLScriptElement | null;

  if (existing) {
    return new Promise<void>((resolve, reject) => {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("CAPTCHA failed to load.")), {
        once: true,
      });
    });
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error("CAPTCHA failed to load."));
    document.head.appendChild(script);
  });
}

export function CaptchaChallenge({
  onTokenChange,
  resetSignal = 0,
  className,
}: CaptchaChallengeProps) {
  const config = useMemo(() => getAuthCaptchaConfig(), []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<WidgetId | null>(null);
  // Stash the latest callback in a ref so the render effect doesn't depend on
  // `onTokenChange`'s identity. Parents that re-create the handler each
  // render would otherwise tear the captcha widget down and re-mount it,
  // causing a visible flicker and losing any in-progress challenge.
  const onTokenChangeRef = useRef(onTokenChange);
  onTokenChangeRef.current = onTokenChange;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      onTokenChangeRef.current(null);
      return;
    }

    let cancelled = false;

    loadCaptchaScript(config.provider)
      .then(() => {
        if (cancelled || !containerRef.current) return;

        const renderer = getRenderer(config.provider);
        if (!renderer) {
          setError("Security check could not start. Refresh and try again.");
          return;
        }

        widgetIdRef.current = renderer.render(containerRef.current, {
          sitekey: config.siteKey,
          theme: "auto",
          callback: (token) => {
            setError(null);
            onTokenChangeRef.current(token);
          },
          "expired-callback": () => onTokenChangeRef.current(null),
          "error-callback": () => {
            onTokenChangeRef.current(null);
            setError("Security check failed. Please try again.");
          },
        });
      })
      .catch(() => {
        if (!cancelled) setError("Security check could not load. Refresh and try again.");
      });

    return () => {
      cancelled = true;
      onTokenChangeRef.current(null);

      const renderer = getRenderer(config.provider);
      if (renderer && widgetIdRef.current !== null) {
        renderer.remove?.(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [config]);

  useEffect(() => {
    if (!config || widgetIdRef.current === null) return;
    getRenderer(config.provider)?.reset(widgetIdRef.current);
    onTokenChangeRef.current(null);
  }, [config, resetSignal]);

  if (!config) return null;

  return (
    <div className={className}>
      <div ref={containerRef} className="flex min-h-[65px] justify-center" />
      {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
