// Per-user "cleared at" horizon stored in localStorage. Anything created
// at-or-before this instant is suppressed from the bell UI forever on this
// device — covers DB rows that survive a failed delete, legacy message
// notifications whose metadata predates the `messageId` field, and the
// 5-minute fallback poll that would otherwise resurrect the same 8
// messages as "new" notifications on every refresh.

export const clearedHorizonKey = (userId: string) =>
  `skillswap-notifications-cleared-at-${userId}`;

export function readClearedHorizon(userId: string) {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(clearedHorizonKey(userId));
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function writeClearedHorizon(userId: string, iso: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(clearedHorizonKey(userId), iso);
}

export function clearClearedHorizon(userId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(clearedHorizonKey(userId));
}
