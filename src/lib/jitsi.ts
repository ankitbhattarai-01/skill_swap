export type CreateVideoRoomPayload = {
  sessionId: string;
  skillName?: string | null;
};

const JAAS_DOMAIN = "8x8.vc";

export function getJaasAppId(): string | null {
  const id = import.meta.env.VITE_JAAS_APP_ID;
  return id && typeof id === "string" ? id : null;
}

export function isJaasMode() {
  return Boolean(getJaasAppId());
}

// Returns the JaaS domain when configured, or "" when not. The public
// meet.jit.si fallback was removed because it has no per-room
// authorization — anyone with the URL could enter the call. Callers
// should use isJaasMode() (or rely on the empty return) to gate UI
// instead of silently downgrading to an insecure provider.
export function getJitsiDomain() {
  if (!isJaasMode()) return "";
  return import.meta.env.VITE_JITSI_DOMAIN || JAAS_DOMAIN;
}

function makeRawRoomName(sessionId: string, skillName?: string | null) {
  const skillPart = (skillName ?? "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  return `skillswap-${skillPart || "session"}-${sessionPart || Date.now()}`;
}

// In JaaS, every URL & External-API roomName is prefixed with the tenant App ID.
function withTenantPrefix(rawRoomName: string) {
  const appId = getJaasAppId();
  return appId ? `${appId}/${rawRoomName}` : rawRoomName;
}

export function isJitsiRoomUrl(link: string | null | undefined) {
  if (!link) return false;
  if (!isJaasMode()) return false;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== getJitsiDomain()) return false;
    const appId = getJaasAppId();
    return appId ? url.pathname.startsWith(`/${appId}/`) : false;
  } catch {
    return false;
  }
}

export function sanitizeVideoRoomUrl(link: string | null | undefined) {
  if (!isJitsiRoomUrl(link)) return "";
  return link ?? "";
}

export function getVideoRoomUrl({
  link,
  sessionId,
  skillName,
}: {
  link?: string | null;
  sessionId: string;
  skillName?: string | null;
}) {
  const existing = sanitizeVideoRoomUrl(link);
  if (existing) return existing;
  // No JaaS = no safe room. Returning "" lets callers (Join buttons,
  // session detail pages) treat the room as unavailable instead of
  // silently sending users to an unauthenticated meet.jit.si link.
  if (!isJaasMode()) return "";

  const domain = getJitsiDomain();
  const path = withTenantPrefix(makeRawRoomName(sessionId, skillName));
  return `https://${domain}/${path}`;
}

// Returns the roomName as the External API expects it (tenant-prefixed
// `<APP_ID>/<room>`). Returns "" outside JaaS mode — callers must not
// initialise the External API without a real tenant.
export function getApiRoomName(sessionId: string, skillName?: string | null) {
  if (!isJaasMode()) return "";
  return withTenantPrefix(makeRawRoomName(sessionId, skillName));
}

// The bare room name (no tenant prefix). This is what goes into the JWT's
// `room` claim — JaaS expects the un-prefixed name there.
export function getBareRoomName(sessionId: string, skillName?: string | null) {
  return makeRawRoomName(sessionId, skillName);
}

export function getRoomNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (isJaasMode()) {
      const appId = getJaasAppId();
      if (appId && path.startsWith(`${appId}/`)) return path.slice(appId.length + 1);
      return path.split("/")[0] || "";
    }
    return path.split("/")[0] || "";
  } catch {
    return "";
  }
}

export async function createVideoRoom({
  sessionId,
  skillName,
}: CreateVideoRoomPayload): Promise<{ link: string }> {
  if (!sessionId) throw new Error("Missing session id");
  if (!isJaasMode()) {
    throw new Error(
      "Video calls are not configured for this environment. Ask an admin to set VITE_JAAS_APP_ID.",
    );
  }
  return { link: getVideoRoomUrl({ sessionId, skillName }) };
}

// External API loader (https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe).
export type JitsiExternalApiConstructor = new (
  domain: string,
  options: Record<string, unknown>,
) => JitsiExternalApiInstance;

export type JitsiExternalApiInstance = {
  executeCommand: (command: string, ...args: unknown[]) => void;
  addListener: (event: string, listener: (payload: unknown) => void) => void;
  removeListener: (event: string, listener: (payload: unknown) => void) => void;
  getIFrame: () => HTMLIFrameElement | null;
  getNumberOfParticipants: () => number;
  dispose: () => void;
};

// How long we wait for Jitsi to finish its own teardown after a hangup before
// destroying the iframe anyway. Normal hangups resolve in well under 300ms;
// the ceiling only matters when the client is already wedged.
export const HANGUP_GRACE_MS = 1500;

/**
 * Asks the conference to leave and resolves once the client says it has
 * finished (`readyToClose`), or after `timeoutMs`, whichever comes first.
 *
 * The iframe API contract is hangup -> readyToClose -> dispose. Destroying the
 * iframe without that handshake discards the browsing context before the client
 * can send its "I'm gone" presence, so the bridge keeps the endpoint alive until
 * its own ping timeout - and a rejoin inside that window shows up alongside the
 * stale endpoint as a phantom extra participant.
 *
 * Deliberately does NOT dispose: the caller owns the instance and may have
 * already thrown it away by the time this resolves.
 */
export function requestHangUp(
  api: JitsiExternalApiInstance,
  timeoutMs: number = HANGUP_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        api.removeListener("readyToClose", finish);
      } catch {
        // Instance already disposed - nothing to detach.
      }
      resolve();
    };
    // Declared after `finish` so the timeout can be cleared from inside it;
    // nothing can call `finish` before this line runs.
    const timer = window.setTimeout(finish, timeoutMs);
    try {
      api.addListener("readyToClose", finish);
      api.executeCommand("hangup");
    } catch {
      // Iframe is already detached or the transport is dead; there is no
      // graceful path left, so let the caller dispose immediately.
      finish();
    }
  });
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: JitsiExternalApiConstructor;
  }
}

let externalApiPromise: Promise<JitsiExternalApiConstructor> | null = null;

export function loadJitsiExternalApi(): Promise<JitsiExternalApiConstructor> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Jitsi requires a browser environment"));
  }
  if (!isJaasMode()) {
    return Promise.reject(new Error("Video calls are not configured for this environment."));
  }
  if (window.JitsiMeetExternalAPI) {
    return Promise.resolve(window.JitsiMeetExternalAPI);
  }
  if (externalApiPromise) return externalApiPromise;

  const domain = getJitsiDomain();
  externalApiPromise = new Promise<JitsiExternalApiConstructor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-jitsi-external-api="${domain}"]`,
    );
    const script = existing ?? document.createElement("script");
    script.src = `https://${domain}/external_api.js`;
    script.async = true;
    script.dataset.jitsiExternalApi = domain;

    const handleLoad = () => {
      if (window.JitsiMeetExternalAPI) {
        resolve(window.JitsiMeetExternalAPI);
      } else {
        externalApiPromise = null;
        reject(new Error("Jitsi external_api.js loaded but did not register"));
      }
    };
    const handleError = () => {
      externalApiPromise = null;
      reject(new Error("Could not load Jitsi external_api.js"));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) document.head.appendChild(script);
  });

  return externalApiPromise;
}
