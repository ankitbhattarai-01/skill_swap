import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { cwd } from "node:process";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

type DevLogLevel = "info" | "warn" | "error";
type DevLogFile = "app.log" | "error.log" | "access.log";
type DevLogEventInput = {
  level: DevLogLevel;
  event: string;
  requestId?: string;
  message?: string;
  [key: string]: unknown;
};
type DevLogEvent = DevLogEventInput & { timestamp: string };

const DEV_LOG_ENDPOINT_PATH = "/api/logs/client";
const DEV_LOG_DIR = join(cwd(), "logs");
const DEV_LOG_FILES: readonly DevLogFile[] = ["app.log", "error.log", "access.log"];
const MAX_DEV_CLIENT_LOG_BYTES = 16 * 1024;
const SENSITIVE_LOG_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passcode|apikey|api_key|key|credential|session|refresh|access)/i;

function truncateLogValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function sanitizeLogUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "http://localhost");
    const params = new URLSearchParams();

    url.searchParams.forEach((value, key) => {
      params.set(
        key,
        SENSITIVE_LOG_KEY_PATTERN.test(key) ? "[REDACTED]" : truncateLogValue(value, 256),
      );
    });

    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return truncateLogValue(rawUrl, 1024);
  }
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MaxDepth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncateLogValue(value, 8_000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);

  if (value instanceof Error) return serializeDevError(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(
      0,
      80,
    )) {
      result[key] = SENSITIVE_LOG_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeLogValue(nestedValue, depth + 1);
    }

    return result;
  }

  return String(value);
}

function serializeDevError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? truncateLogValue(error.stack, 8_000) : undefined,
    };
  }

  return {
    message: typeof error === "string" ? truncateLogValue(error, 8_000) : "Non-Error thrown",
    value: sanitizeLogValue(error),
  };
}

function ensureDevLogFiles() {
  mkdirSync(DEV_LOG_DIR, { recursive: true });

  for (const fileName of DEV_LOG_FILES) {
    appendFileSync(join(DEV_LOG_DIR, fileName), "", { encoding: "utf8", flag: "a" });
  }
}

function appendDevLog(fileName: DevLogFile, event: DevLogEvent) {
  try {
    ensureDevLogFiles();
    appendFileSync(join(DEV_LOG_DIR, fileName), `${JSON.stringify(sanitizeLogValue(event))}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  } catch (error) {
    console.warn("[logger] Failed to write dev log file.", error);
  }
}

function writeDevAppLog(event: DevLogEventInput) {
  const normalizedEvent: DevLogEvent = { timestamp: new Date().toISOString(), ...event };

  appendDevLog("app.log", normalizedEvent);
  if (normalizedEvent.level === "error") {
    appendDevLog("error.log", normalizedEvent);
  }
}

function writeDevAccessLog(event: Omit<DevLogEvent, "timestamp" | "level" | "event">) {
  appendDevLog("access.log", {
    timestamp: new Date().toISOString(),
    level: "info",
    event: "http.access",
    ...event,
  });
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function readLimitedDevBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_DEV_CLIENT_LOG_BYTES) {
        fail(new Error(`Client log payload exceeds ${MAX_DEV_CLIENT_LOG_BYTES} bytes.`));
        request.destroy();
        return;
      }

      body += chunk;
    });
    request.on("error", fail);
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
  });
}

function normalizeDevClientLogPayload(
  payload: unknown,
  request: IncomingMessage,
  requestId: string,
): DevLogEvent {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const level = record.level === "error" || record.level === "warn" ? record.level : "info";
  const event =
    typeof record.event === "string" && record.event.trim()
      ? truncateLogValue(record.event.trim(), 120)
      : "client.log";

  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId,
    message:
      typeof record.message === "string" && record.message.trim()
        ? truncateLogValue(record.message.trim(), 2_000)
        : undefined,
    source: typeof record.source === "string" ? truncateLogValue(record.source, 160) : "browser",
    clientTimestamp:
      typeof record.timestamp === "string" ? truncateLogValue(record.timestamp, 80) : undefined,
    page: typeof record.url === "string" ? sanitizeLogUrl(record.url) : undefined,
    userAgent:
      typeof record.userAgent === "string"
        ? truncateLogValue(record.userAgent, 512)
        : truncateLogValue(getHeader(request, "user-agent") ?? "", 512),
    details: sanitizeLogValue(record.details),
    error: sanitizeLogValue(record.error),
  };
}

function finishDevResponse(
  response: ServerResponse,
  statusCode: number,
  body?: string,
  headers?: Record<string, string>,
) {
  response.statusCode = statusCode;

  for (const [name, value] of Object.entries(headers ?? {})) {
    response.setHeader(name, value);
  }

  response.end(body);
}

function skillswapDevLoggingPlugin(): Plugin {
  return {
    name: "skillswap-dev-file-logging",
    apply: "serve",
    configureServer(server) {
      ensureDevLogFiles();
      writeDevAppLog({
        level: "info",
        event: "logger.initialized",
        runtime: "vite-dev",
        files: DEV_LOG_FILES,
        logDir: DEV_LOG_DIR,
      });

      server.middlewares.use((request, response, next) => {
        const startedAt = Date.now();
        const requestId = randomUUID();
        const url = new URL(request.url ?? "/", "http://localhost");

        response.setHeader("X-Request-Id", requestId);
        response.on("finish", () => {
          writeDevAccessLog({
            requestId,
            method: request.method,
            path: sanitizeLogUrl(request.url ?? "/"),
            status: response.statusCode,
            durationMs: Date.now() - startedAt,
            ip: request.socket.remoteAddress,
            userAgent: truncateLogValue(getHeader(request, "user-agent") ?? "", 512),
            referer: getHeader(request, "referer")
              ? sanitizeLogUrl(getHeader(request, "referer") ?? "")
              : undefined,
          });
        });

        if (url.pathname !== DEV_LOG_ENDPOINT_PATH) {
          next();
          return;
        }

        if (request.method !== "POST") {
          finishDevResponse(response, 405, "Method Not Allowed", { Allow: "POST" });
          return;
        }

        void (async () => {
          try {
            const payload = JSON.parse(await readLimitedDevBody(request));
            writeDevAppLog(normalizeDevClientLogPayload(payload, request, requestId));
            finishDevResponse(response, 204);
          } catch (error) {
            writeDevAppLog({
              level: "warn",
              event: "client_log.rejected",
              requestId,
              message: "Rejected malformed client log payload.",
              error: serializeDevError(error),
            });
            finishDevResponse(response, 400, "Bad Request", {
              "Content-Type": "text/plain; charset=utf-8",
            });
          }
        })();
      });
    },
  };
}

function getClientEnvDefines(mode: string): Record<string, string> {
  const loadedEnv = loadEnv(mode, cwd(), "VITE_");
  return Object.fromEntries(
    Object.entries(loadedEnv).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  );
}

// Security headers applied to every deployed response. Ported from the old
// Cloudflare Worker entry (server.ts), which is no longer in the request path
// on Vercel/Nitro. The CSP is the static ("legacy") variant: Cloudflare's
// per-request nonce injection relied on its HTMLRewriter global, which doesn't
// exist on Vercel, so script-src falls back to 'unsafe-inline'. Every origin
// listed is one the app actually talks to — prune these if a feature is
// dropped (e.g. hCaptcha, Jitsi/8x8, Gemini). Nitro compiles these into the
// Vercel Build Output config so they apply at the CDN edge, not just the SSR
// function. Applied on `build` only so the CSP's connect-src doesn't block
// Vite's dev HMR websocket.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
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
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    'camera=(self "https://8x8.vc" "https://meet.jit.si"), microphone=(self "https://8x8.vc" "https://meet.jit.si"), display-capture=(self "https://8x8.vc" "https://meet.jit.si"), geolocation=(), payment=(), usb=(), bluetooth=(), midi=()',
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
};

function getPlugins(command: "build" | "serve"): PluginOption[] {
  // Nitro is TanStack Start's universal server layer; it detects the Vercel
  // build environment automatically and emits Vercel Functions output there,
  // while producing a plain Node server build locally. It replaces the old
  // @cloudflare/vite-plugin target. Plugin order follows the TanStack + Vercel
  // reference config: tanstackStart() → nitro() → viteReact().
  return [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    ...tanstackStart(),
    nitro(command === "build" ? { routeRules: { "/**": { headers: SECURITY_HEADERS } } } : undefined),
    viteReact(),
    skillswapDevLoggingPlugin(),
  ];
}

// Split the big shared vendors out of the single eager entry chunk so they get
// their own long-lived cache entries. App code changes between deploys no longer
// invalidate React/Supabase/TanStack/Radix for returning visitors, and it keeps
// any one chunk under Rollup's 500 kB warning threshold. Scoped to the client
// build only (see `environments.client`) so the Nitro SSR server bundle is
// left untouched.
function vendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  // Supabase is independent of the React tree, so it gets its own cache entry.
  if (id.includes("@supabase")) return "vendor-supabase";
  // React core (react / react-dom / scheduler) is a leaf the rest of the tree
  // imports one-directionally, so it splits cleanly. TanStack/Radix are NOT
  // split out: TanStack Start's generated route tree creates a mutual cycle
  // between them and the app entry, so Rollup would just merge them back.
  if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
  return undefined;
}

export default defineConfig((env) => ({
  define: getClientEnvDefines(env.mode),
  resolve: {
    alias: {
      "@": join(cwd(), "src"),
    },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  plugins: getPlugins(env.command),
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            manualChunks: vendorChunk,
          },
        },
      },
    },
  },
  server: {
    host: "::",
    port: 8080,
    allowedHosts: [".ngrok-free.app", ".ngrok.app", ".trycloudflare.com"],
    watch: {
      awaitWriteFinish: {
        stabilityThreshold: 1_000,
        pollInterval: 100,
      },
    },
    // Warm the most-trafficked routes on dev startup so the first navigation
    // doesn't trigger a Vite transform waterfall.
    warmup: {
      clientFiles: [
        "./src/routes/__root.tsx",
        "./src/routes/dashboard.tsx",
        "./src/routes/explore.tsx",
        "./src/routes/messages.tsx",
        "./src/routes/profile.tsx",
      ],
    },
  },
  // Pre-bundle heavy deps so cold dev start doesn't pay the transform cost
  // on first route hit. Only deps that are imported on the *initial* route
  // chunk belong here — recharts/cmdk/embla/day-picker live behind lazy
  // boundaries (AdminCharts, GlobalSearch, Calendar in lazy dialogs), so
  // including them only slows dev cold-start without speeding any route.
  optimizeDeps: {
    include: [
      "@supabase/supabase-js",
      "@tanstack/react-query",
      "@tanstack/react-router",
      "sonner",
      "lucide-react",
    ],
  },
}));
