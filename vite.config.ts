import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { cwd } from "node:process";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ConfigEnv, type Plugin, type PluginOption } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

type DevLogLevel = "info" | "warn" | "error";
type DevLogFile = "app.log" | "error.log" | "access.log";
type DevLogEvent = {
  timestamp: string;
  level: DevLogLevel;
  event: string;
  requestId?: string;
  message?: string;
  [key: string]: unknown;
};

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

function writeDevAppLog(event: Omit<DevLogEvent, "timestamp">) {
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

function getPlugins(env: ConfigEnv): PluginOption[] {
  const plugins: PluginOption[] = [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
  ];

  if (env.command === "build") {
    plugins.push(...cloudflare({ viteEnvironment: { name: "ssr" } }));
  }

  plugins.push(
    ...tanstackStart({ router: { autoCodeSplitting: true } }),
    viteReact(),
    skillswapDevLoggingPlugin(),
  );

  return plugins;
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
  plugins: getPlugins(env),
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
