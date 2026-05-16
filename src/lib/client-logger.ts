type ClientLogLevel = "info" | "warn" | "error";

type ClientLogPayload = {
  level: ClientLogLevel;
  event: string;
  source?: string;
  message?: string;
  timestamp: string;
  url?: string;
  userAgent?: string;
  details?: unknown;
  error?: unknown;
};

const CLIENT_LOG_ENDPOINT = "/api/logs/client";
const MAX_SERIALIZED_VALUE_LENGTH = 8_000;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passcode|apikey|api_key|key|credential|session|refresh|access)/i;

let installed = false;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function getCurrentPage(): string | undefined {
  if (typeof window === "undefined") return undefined;

  const search = new URLSearchParams(window.location.search);
  const safeSearch = new URLSearchParams();

  search.forEach((value, key) => {
    safeSearch.set(key, SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : truncate(value, 256));
  });

  const query = safeSearch.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function serializeForLog(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MaxDepth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return truncate(value, MAX_SERIALIZED_VALUE_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? truncate(value.stack, MAX_SERIALIZED_VALUE_LENGTH) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => serializeForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(
      0,
      80,
    )) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : serializeForLog(nestedValue, depth + 1);
    }

    return result;
  }

  return String(value);
}

function getMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function sendClientLog(payload: Omit<ClientLogPayload, "timestamp" | "url" | "userAgent">) {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;

  const body = JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
    url: getCurrentPage(),
    userAgent: navigator.userAgent,
  } satisfies ClientLogPayload);

  try {
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(CLIENT_LOG_ENDPOINT, blob)) return;
    }

    void fetch(CLIENT_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {
      // Logging must never become part of the user-facing failure path.
    });
  } catch {
    // Swallow logging transport failures for the same reason.
  }
}

export function logClientEvent(
  event: string,
  details?: unknown,
  options?: { level?: ClientLogLevel; source?: string; message?: string },
) {
  sendClientLog({
    level: options?.level ?? "info",
    event,
    source: options?.source ?? "browser",
    message: options?.message,
    details: serializeForLog(details),
  });
}

export function logClientError(error: unknown, source = "browser", details?: unknown) {
  sendClientLog({
    level: "error",
    event: "client.error",
    source,
    message: getMessage(error, "Unhandled browser error"),
    error: serializeForLog(error),
    details: serializeForLog(details),
  });
}

export function installClientLogging() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    logClientError(event.error ?? event.message, "window.error", {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logClientError(event.reason, "window.unhandledrejection");
  });
}
