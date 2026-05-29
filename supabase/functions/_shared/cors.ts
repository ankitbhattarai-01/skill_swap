// Shared CORS helper for SkillSwap Edge Functions.
//
// Reflects the request's Origin only when it appears in the allowlist;
// otherwise returns a deny header so the browser blocks cross-origin reads
// from arbitrary attacker sites. JWT auth on the function is the actual
// security boundary - this just stops drive-by abuse from logged-in users
// being silently called by other tabs.
//
// Allowlist: dev defaults + anything passed via the CORS_ALLOWED_ORIGINS
// secret. Set it as a comma-separated list in the Supabase dashboard:
//   CORS_ALLOWED_ORIGINS=https://skillswap.example.com,https://staging.example.com

// Vite is configured for port 8080 but does NOT use strictPort, so when 8080 is
// already taken it silently falls back to 8081, 8082, ... Allow that small range
// (plus the usual 5173/3000) so a port bump doesn't break CORS — which surfaced
// as the dashboard's AI Suggestions card silently vanishing on :8081.
const DEFAULT_ALLOWED = [
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8081",
  "http://127.0.0.1:8082",
  "http://127.0.0.1:8083",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:8082",
  "http://localhost:8083",
  "http://localhost:5173",
  "http://localhost:3000",
];

function readAllowedOrigins(): Set<string> {
  const envValue = Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "";
  const fromEnv = envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return new Set([...DEFAULT_ALLOWED, ...fromEnv]);
}

const ALLOWED_HEADERS = "authorization, x-client-info, apikey, content-type";
const ALLOWED_METHODS = "POST, OPTIONS";

// Build the response headers for a given request origin. Exposing "null" for
// disallowed origins makes browsers fail the CORS check while still letting
// us return a real status code (helpful when debugging).
export function corsHeadersFor(req: Request): Record<string, string> {
  const allowed = readAllowedOrigins();
  const origin = req.headers.get("Origin") ?? "";
  const isAllowed = origin.length > 0 && allowed.has(origin);
  // Log denials so a misconfigured `CORS_ALLOWED_ORIGINS` (or a real cross-
  // origin probe) is visible in Edge Function logs. Without this, the only
  // visible symptom was a silent browser-side CORS error and no server trace.
  // Includes the request path so we can tell which function got hit.
  if (origin && !isAllowed) {
    let path = "";
    try {
      path = new URL(req.url).pathname;
    } catch {
      // Some runtimes pass relative URLs to Request — best-effort only.
    }
    console.warn(
      `[cors] denied origin=${origin}${path ? ` path=${path}` : ""}; ` +
        `allowed set has ${allowed.size} entr${allowed.size === 1 ? "y" : "ies"}.`,
    );
  }
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "null",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    Vary: "Origin",
  };
}

// Convenience helper for the common "JSON response with CORS" pattern.
export function corsJson(
  req: Request,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersFor(req),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

// OPTIONS preflight handler.
export function corsPreflight(req: Request) {
  return new Response("ok", { headers: corsHeadersFor(req) });
}
