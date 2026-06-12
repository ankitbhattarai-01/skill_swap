// Custom Cloudflare Worker entry that wraps TanStack Start's default handler
// and injects security headers on every response.
//
// Why this exists: out of the box `@tanstack/react-start/server-entry` ships
// without CSP, X-Frame-Options, HSTS, etc. With our auth tokens stored in
// localStorage (Supabase default), an XSS bug — even one we don't know about
// today — would mean account takeover. CSP defangs most of that.
//
// To use, set `"main": "./server.ts"` in wrangler.jsonc.
//
// Tightening the CSP later: every directive below is documented with the
// origins the app actually needs. If you remove a feature (e.g. swap Gemini
// for a different LLM, drop n8n), prune the corresponding origin.

import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const baseFetch = createStartHandler(defaultStreamHandler);

type LogLevel = "info" | "warn" | "error";

type LogEvent = {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  message?: string;
  [key: string]: unknown;
};

type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

type FileSink = {
  logDir: string;
  append: (fileName: LogFileName, line: string) => Promise<void>;
};

type LogFileName = "app.log" | "error.log" | "access.log";

const LOG_ENDPOINT_PATH = "/api/logs/client";
const MAX_CLIENT_LOG_BYTES = 16 * 1024;
// Rate limit for /api/logs/client. The endpoint stays unauthenticated because
// the client logger fires on pre-login errors (window.onerror on /login etc.),
// so we throttle by IP instead. Per-isolate in-memory state — a distributed
// attacker across many CF isolates can sidestep this, but it raises the cost
// of a single-host flood from "free" to "30/min".
const CLIENT_LOG_WINDOW_MS = 60_000;
const CLIENT_LOG_PER_IP_LIMIT = 30;
const CLIENT_LOG_GLOBAL_LIMIT = 600;
const CLIENT_LOG_BUCKETS_MAX = 5_000;
const LOG_FILES: readonly LogFileName[] = ["app.log", "error.log", "access.log"];
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passcode|apikey|api_key|key|credential|session|refresh|access)/i;

let fileSinkPromise: Promise<FileSink | null> | null = null;
let fileLoggingFallbackNotified = false;
let loggerBootLogged = false;

// CSP is per-request: every HTML response gets a fresh nonce and the
// script-src directive only trusts scripts that carry it (plus anything
// those scripts go on to load, via 'strict-dynamic'). The nonce is
// stamped onto every <script> tag in the response body by Cloudflare's
// HTMLRewriter just before we hand the response back to the client.
//
// 'unsafe-inline' is intentionally absent from script-src. In browsers
// that honour 'strict-dynamic' it would be ignored anyway; in older
// browsers the host whitelist remains as a fallback. Inline scripts
// without a nonce — i.e. anything XSS injects into the rendered HTML —
// will be blocked outright.
function buildCsp(scriptNonce: string): string {
  return [
    // No iframing of this site at all (replaces X-Frame-Options: DENY).
    "frame-ancestors 'none'",

    // Default for everything not explicitly listed below.
    "default-src 'self'",

    // Scripts: self + the request-scoped nonce + strict-dynamic (so any
    // script our nonced bootstrap loads — Jitsi External API, hCaptcha
    // widget, Turnstile — inherits trust transitively). Host entries are
    // kept for older browsers that ignore strict-dynamic.
    `script-src 'self' 'nonce-${scriptNonce}' 'strict-dynamic' https://8x8.vc https://meet.jit.si https://challenges.cloudflare.com https://js.hcaptcha.com https://hcaptcha.com https://*.hcaptcha.com`,

    // Styles: Tailwind injects many inline styles; chart.tsx writes a <style>
    // block via dangerouslySetInnerHTML. CAPTCHA providers also inject styles.
    // Tightening style-src to a nonce requires more refactoring (style attrs
    // can't be nonced) and is out of scope for the auth-token-theft surface.
    "style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",

    // Fonts: bundled or data: URI (Tailwind sometimes inlines).
    "font-src 'self' data:",

    // Images: signed Supabase storage URLs + Google profile photos for OAuth +
    // data:/blob: for inline placeholders and createObjectURL.
    "img-src 'self' data: blob: https://*.supabase.co https://lh3.googleusercontent.com https://*.googleusercontent.com https://hcaptcha.com https://*.hcaptcha.com",

    // XHR / fetch / WebSocket: Supabase REST + Realtime + Edge Functions, Gemini
    // (called from Edge Function but shows up here when the function streams),
    // Google OAuth handshake, CAPTCHA challenge verification assets, and the
    // same-origin client log endpoint.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://generativelanguage.googleapis.com https://accounts.google.com https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com",

    // Iframes the app embeds: Jitsi room iframe + CAPTCHA challenge iframes.
    "frame-src 'self' https://8x8.vc https://meet.jit.si https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com",

    // Web workers / module workers from same origin or blob.
    "worker-src 'self' blob:",

    // Disallow legacy plugin embeds.
    "object-src 'none'",

    // Pin <base href> so an injected <base> can't redirect every relative URL.
    "base-uri 'self'",

    // Form posts only to self + Google OAuth.
    "form-action 'self' https://accounts.google.com",

    // Force HTTPS upgrades for any embedded http: URL we might miss.
    "upgrade-insecure-requests",
  ].join("; ");
}

// Legacy CSP fallback for non-HTML responses or runtimes without
// HTMLRewriter. Keeps 'unsafe-inline' because we can't apply nonces here.
// In practice this path is exercised by JSON/asset responses, which don't
// execute scripts in the first place — but we still send a CSP for
// defense in depth.
function buildLegacyCsp(): string {
  return [
    "frame-ancestors 'none'",
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://8x8.vc https://meet.jit.si https://challenges.cloudflare.com https://js.hcaptcha.com https://hcaptcha.com https://*.hcaptcha.com",
    "style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://*.supabase.co https://lh3.googleusercontent.com https://*.googleusercontent.com https://hcaptcha.com https://*.hcaptcha.com",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://generativelanguage.googleapis.com https://accounts.google.com https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com",
    "frame-src 'self' https://8x8.vc https://meet.jit.si https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "upgrade-insecure-requests",
  ].join("; ");
}

// Headers that don't depend on the CSP — same on every response.
const STATIC_SECURITY_HEADERS: Array<[string, string]> = [
  // X-Frame-Options is superseded by CSP frame-ancestors but still respected
  // by older browsers.
  ["X-Frame-Options", "DENY"],
  // No MIME sniffing — important when serving user-uploaded content.
  ["X-Content-Type-Options", "nosniff"],
  // 1 year HSTS, includes subdomains. Don't add `preload` until you're sure.
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  // Don't leak full URLs to other origins; send only the origin on cross-site
  // navigation.
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  // Lock down APIs we don't use; allow camera/mic on self + Jitsi for video
  // calls. Note: the iframe inherits this via `Permissions-Policy: ...; camera=(self "https://8x8.vc")`.
  [
    "Permissions-Policy",
    'camera=(self "https://8x8.vc" "https://meet.jit.si"), microphone=(self "https://8x8.vc" "https://meet.jit.si"), display-capture=(self "https://8x8.vc" "https://meet.jit.si"), geolocation=(), payment=(), usb=(), bluetooth=(), midi=()',
  ],
  // Cross-origin isolation defaults — safe for an SPA that doesn't share state
  // with embedders.
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-site"],
];

function generateScriptNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  // btoa is available in CF Workers and modern Node — base64-encoded nonce
  // is the canonical form expected by CSP.
  return btoa(raw);
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

// Minimal HTMLRewriter shape — Cloudflare's full DTS isn't in scope here
// and we only use setAttribute. Anything else is opaque.
type RewriterElement = { setAttribute: (name: string, value: string) => void };
type RewriterHandlers = { element?: (el: RewriterElement) => void };
interface RewriterInstance {
  on(selector: string, handlers: RewriterHandlers): RewriterInstance;
  transform(response: Response): Response;
}
type RewriterCtor = new () => RewriterInstance;

// Stamp nonce="..." on every <script> tag in the response stream so the
// nonce-based script-src above can match. We add the attribute to BOTH
// inline scripts (where it gates execution) and external <script src="...">
// tags (so strict-dynamic propagates trust into anything they load).
function injectScriptNonce(response: Response, nonce: string): Response {
  const Rewriter = (globalThis as unknown as { HTMLRewriter?: RewriterCtor }).HTMLRewriter;
  if (!Rewriter || !isHtmlResponse(response)) return response;
  return new Rewriter()
    .on("script", {
      element(el: RewriterElement) {
        el.setAttribute("nonce", nonce);
      },
    })
    .transform(response);
}

function applySecurityHeaders(response: Response, csp: string, requestId?: string): Response {
  // Use a fresh Headers object so we don't mutate a possibly-shared one.
  const headers = new Headers(response.headers);
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", csp);
  }
  for (const [name, value] of STATIC_SECURITY_HEADERS) {
    // Don't clobber a header an inner handler explicitly set (e.g. an edge
    // function might want a different CORP for an asset).
    if (!headers.has(name)) headers.set(name, value);
  }
  if (requestId && !headers.has("X-Request-Id")) {
    headers.set("X-Request-Id", requestId);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function scheduleLog(context: ExecutionContextLike | undefined, task: Promise<unknown>) {
  const guardedTask = task.catch((error) => {
    fallbackConsoleLog("error.log", {
      timestamp: nowIso(),
      level: "error",
      event: "logger.write_failed",
      error: serializeError(error),
    });
  });

  if (context?.waitUntil) {
    context.waitUntil(guardedTask);
    return;
  }

  void guardedTask;
}

function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "http://localhost");
    const params = new URLSearchParams();

    url.searchParams.forEach((value, key) => {
      params.set(key, SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : truncate(value, 256));
    });

    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return truncate(rawUrl, 1024);
  }
}

function getClientIp(request: Request): string | undefined {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}

function getRuntimeName(): string {
  const processLike = globalThis as typeof globalThis & {
    process?: { versions?: { node?: string }; release?: { name?: string } };
  };

  if (processLike.process?.versions?.node) {
    return processLike.process.release?.name ?? "node";
  }

  return "edge";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MaxDepth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value, 8_000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);

  if (value instanceof Error) return serializeError(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(
      0,
      80,
    )) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeForLog(nestedValue, depth + 1);
    }

    return result;
  }

  return String(value);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? truncate(error.stack, 8_000) : undefined,
    };
  }

  return {
    message: typeof error === "string" ? truncate(error, 8_000) : "Non-Error thrown",
    value: sanitizeForLog(error),
  };
}

function toLogLine(event: LogEvent): string {
  return JSON.stringify(sanitizeForLog(event));
}

function fallbackConsoleLog(fileName: LogFileName, event: LogEvent) {
  const line = toLogLine(event);
  const prefix = `[${fileName}]`;

  if (fileName === "error.log" || event.level === "error") {
    console.error(prefix, line);
    return;
  }

  if (event.level === "warn") {
    console.warn(prefix, line);
    return;
  }

  console.info(prefix, line);
}

async function getFileSink(): Promise<FileSink | null> {
  if (fileSinkPromise) return fileSinkPromise;

  fileSinkPromise = (async () => {
    try {
      const processLike = globalThis as typeof globalThis & {
        process?: {
          cwd?: () => string;
          env?: Record<string, string | undefined>;
          versions?: { node?: string };
        };
      };

      if (!processLike.process?.versions?.node || typeof processLike.process.cwd !== "function") {
        return null;
      }

      const [{ appendFile, mkdir }, path] = await Promise.all([
        import("node:fs/promises"),
        import("node:path"),
      ]);
      const configuredLogDir = processLike.process.env?.LOG_DIR || "logs";
      const logDir = path.isAbsolute(configuredLogDir)
        ? configuredLogDir
        : path.join(processLike.process.cwd(), configuredLogDir);

      await mkdir(logDir, { recursive: true });

      await Promise.all(
        LOG_FILES.map((fileName) =>
          appendFile(path.join(logDir, fileName), "", { encoding: "utf8", flag: "a" }),
        ),
      );

      return {
        logDir,
        append: (fileName, line) =>
          appendFile(path.join(logDir, fileName), `${line}\n`, {
            encoding: "utf8",
            flag: "a",
          }),
      };
    } catch (error) {
      if (!fileLoggingFallbackNotified) {
        fileLoggingFallbackNotified = true;
        console.warn(
          "[logger] File logging is unavailable in this runtime; using structured console logs instead.",
          error,
        );
      }

      return null;
    }
  })();

  return fileSinkPromise;
}

async function appendLog(fileName: LogFileName, event: LogEvent) {
  const sink = await getFileSink();

  if (!sink) {
    fallbackConsoleLog(fileName, event);
    return;
  }

  await sink.append(fileName, toLogLine(event));
}

async function writeAppLog(event: Omit<LogEvent, "timestamp">) {
  // Cast through the index signature: TS widens level/event to `unknown`
  // across the spread, even though Omit<LogEvent,"timestamp"> guarantees them.
  const normalizedEvent = { ...event, timestamp: nowIso() } as LogEvent;

  await appendLog("app.log", normalizedEvent);
  if (normalizedEvent.level === "error") {
    await appendLog("error.log", normalizedEvent);
  }
}

async function writeAccessLog(event: Omit<LogEvent, "timestamp" | "level" | "event">) {
  await appendLog("access.log", {
    timestamp: nowIso(),
    level: "info",
    event: "http.access",
    ...event,
  });
}

function logLoggerBoot(context: ExecutionContextLike | undefined) {
  if (loggerBootLogged) return;
  loggerBootLogged = true;

  scheduleLog(
    context,
    writeAppLog({
      level: "info",
      event: "logger.initialized",
      runtime: getRuntimeName(),
      files: LOG_FILES,
      logDir: "logs",
    }),
  );
}

function logAccess(
  context: ExecutionContextLike | undefined,
  request: Request,
  response: Response,
  requestId: string,
  startedAt: number,
) {
  scheduleLog(
    context,
    writeAccessLog({
      requestId,
      method: request.method,
      path: sanitizeUrlForLog(request.url),
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ip: getClientIp(request),
      userAgent: truncate(request.headers.get("user-agent") ?? "", 512),
      referer: request.headers.get("referer")
        ? sanitizeUrlForLog(request.headers.get("referer") ?? "")
        : undefined,
    }),
  );
}

type RateBucket = { count: number; windowStart: number; notified: boolean };

const clientLogBuckets = new Map<string, RateBucket>();
let clientLogGlobalCount = 0;
let clientLogGlobalWindowStart = 0;
let clientLogGlobalNotified = false;

// Returns { allowed, retryAfterSec, scope } for the given IP. Fixed-window
// counter: one window per IP plus one global window. Evicts the oldest bucket
// when the map grows past CLIENT_LOG_BUCKETS_MAX to bound memory.
function checkClientLogRate(
  ip: string,
  now: number,
):
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; scope: "ip" | "global"; firstHit: boolean } {
  if (
    clientLogGlobalWindowStart === 0 ||
    now - clientLogGlobalWindowStart >= CLIENT_LOG_WINDOW_MS
  ) {
    clientLogGlobalWindowStart = now;
    clientLogGlobalCount = 0;
    clientLogGlobalNotified = false;
  }

  let bucket = clientLogBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= CLIENT_LOG_WINDOW_MS) {
    bucket = { count: 0, windowStart: now, notified: false };
    clientLogBuckets.set(ip, bucket);
  }

  if (clientLogBuckets.size > CLIENT_LOG_BUCKETS_MAX) {
    const oldestKey = clientLogBuckets.keys().next().value;
    if (oldestKey && oldestKey !== ip) clientLogBuckets.delete(oldestKey);
  }

  if (bucket.count >= CLIENT_LOG_PER_IP_LIMIT) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((CLIENT_LOG_WINDOW_MS - (now - bucket.windowStart)) / 1000),
    );
    const firstHit = !bucket.notified;
    bucket.notified = true;
    return { allowed: false, retryAfterSec, scope: "ip", firstHit };
  }

  if (clientLogGlobalCount >= CLIENT_LOG_GLOBAL_LIMIT) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((CLIENT_LOG_WINDOW_MS - (now - clientLogGlobalWindowStart)) / 1000),
    );
    const firstHit = !clientLogGlobalNotified;
    clientLogGlobalNotified = true;
    return { allowed: false, retryAfterSec, scope: "global", firstHit };
  }

  bucket.count += 1;
  clientLogGlobalCount += 1;
  return { allowed: true };
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CLIENT_LOG_BYTES) {
    throw new Error(`Client log payload exceeds ${MAX_CLIENT_LOG_BYTES} bytes.`);
  }

  const body = await request.text();
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > MAX_CLIENT_LOG_BYTES) {
    throw new Error(`Client log payload exceeds ${MAX_CLIENT_LOG_BYTES} bytes.`);
  }

  return JSON.parse(body);
}

function normalizeClientLogPayload(
  payload: unknown,
  request: Request,
  requestId: string,
): LogEvent {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const level = record.level === "error" || record.level === "warn" ? record.level : "info";
  const event =
    typeof record.event === "string" && record.event.trim()
      ? truncate(record.event.trim(), 120)
      : "client.log";
  const message =
    typeof record.message === "string" && record.message.trim()
      ? truncate(record.message.trim(), 2_000)
      : undefined;

  return {
    timestamp: nowIso(),
    level,
    event,
    requestId,
    message,
    source: typeof record.source === "string" ? truncate(record.source, 160) : "browser",
    clientTimestamp:
      typeof record.timestamp === "string" ? truncate(record.timestamp, 80) : undefined,
    page: typeof record.url === "string" ? sanitizeUrlForLog(record.url) : undefined,
    userAgent:
      typeof record.userAgent === "string"
        ? truncate(record.userAgent, 512)
        : truncate(request.headers.get("user-agent") ?? "", 512),
    details: sanitizeForLog(record.details),
    error: sanitizeForLog(record.error),
  };
}

async function handleClientLogRequest(
  request: Request,
  requestId: string,
  context: ExecutionContextLike | undefined,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const ip = getClientIp(request) ?? "unknown";
  const rate = checkClientLogRate(ip, Date.now());
  if (!rate.allowed) {
    if (rate.firstHit) {
      scheduleLog(
        context,
        writeAppLog({
          level: "warn",
          event: "client_log.rate_limited",
          requestId,
          message: `Client log rate limit hit (${rate.scope}).`,
          scope: rate.scope,
          ip: rate.scope === "ip" ? ip : undefined,
        }),
      );
    }
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(rate.retryAfterSec),
      },
    });
  }

  try {
    const payload = await readLimitedJson(request);
    const event = normalizeClientLogPayload(payload, request, requestId);
    scheduleLog(context, writeAppLog(event));

    return new Response(null, { status: 204 });
  } catch (error) {
    scheduleLog(
      context,
      writeAppLog({
        level: "warn",
        event: "client_log.rejected",
        requestId,
        message: "Rejected malformed client log payload.",
        error: serializeError(error),
      }),
    );

    return new Response("Bad Request", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

export default {
  // Cloudflare Workers invoke fetch as (request, env, ctx). baseFetch's
  // declared type only takes (request, opts?), so we accept the CF shape
  // here and forward just the request to baseFetch.
  async fetch(request: Request, _env: unknown, context?: ExecutionContextLike): Promise<Response> {
    const startedAt = performance.now();
    const requestId = createRequestId();

    logLoggerBoot(context);

    // Wrap the SSR handler so an unhandled throw doesn't leave the request
    // hanging until the worker's wall-clock timeout. Return a 500 with the
    // same security headers we apply to every response.
    try {
      const url = new URL(request.url);
      const response =
        url.pathname === LOG_ENDPOINT_PATH
          ? await handleClientLogRequest(request, requestId, context)
          : await baseFetch(request);

      // For HTML responses, mint a per-request nonce, stamp it onto every
      // <script> tag in the body, and use a strict CSP that requires the
      // nonce. Non-HTML responses (JSON, assets, redirects) get the legacy
      // CSP — scripts in those payloads aren't executed anyway, but we
      // keep the header for defense in depth.
      let scopedResponse = response;
      let csp = buildLegacyCsp();
      if (isHtmlResponse(response)) {
        const nonce = generateScriptNonce();
        scopedResponse = injectScriptNonce(response, nonce);
        csp = buildCsp(nonce);
      }
      const securedResponse = applySecurityHeaders(scopedResponse, csp, requestId);

      if (securedResponse.status >= 500) {
        scheduleLog(
          context,
          writeAppLog({
            level: "error",
            event: "server.error_response",
            requestId,
            message: "Server returned an error response.",
            method: request.method,
            path: sanitizeUrlForLog(request.url),
            status: securedResponse.status,
          }),
        );
      }

      logAccess(context, request, securedResponse, requestId, startedAt);

      return securedResponse;
    } catch (error) {
      scheduleLog(
        context,
        writeAppLog({
          level: "error",
          event: "server.unhandled_exception",
          requestId,
          message: "SSR handler threw.",
          method: request.method,
          path: sanitizeUrlForLog(request.url),
          error: serializeError(error),
        }),
      );

      const response = applySecurityHeaders(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        buildLegacyCsp(),
        requestId,
      );

      logAccess(context, request, response, requestId, startedAt);

      return response;
    }
  },
};
