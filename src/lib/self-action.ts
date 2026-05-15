// When a user performs a session action (cancel/accept/reject/complete), the
// backend trigger inserts a notification row addressed to them (and the other
// party). The realtime subscription in SessionEventHeadsUp would then show
// the actor a popup about an action they just took — feedback the actor
// already got via the sonner toast from the action handler.
//
// We mark `(sessionId, expected notification types)` here at the call site
// and consume it when the matching realtime notification arrives, suppressing
// only the heads-up popup. The notification row still lands in the inbox
// (NotificationsMenu) so the actor has a history entry.

const TTL_MS = 15_000;

type Mark = { sessionId: string; types: ReadonlySet<string>; expiresAt: number };

const marks: Mark[] = [];

function gc(now: number) {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].expiresAt <= now) marks.splice(i, 1);
  }
}

export function markSelfAction(sessionId: string, types: readonly string[]) {
  const now = Date.now();
  gc(now);
  marks.push({ sessionId, types: new Set(types), expiresAt: now + TTL_MS });
}

export function consumeSelfAction(sessionId: string, type: string): boolean {
  const now = Date.now();
  gc(now);
  const idx = marks.findIndex((m) => m.sessionId === sessionId && m.types.has(type));
  if (idx === -1) return false;
  marks.splice(idx, 1);
  return true;
}
