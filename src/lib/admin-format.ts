// Shared formatters used across every admin route. Previously each route
// (admin.index, admin.users, admin.finance, admin.cases, admin.compliance,
// admin.access, admin.security, admin.audit, admin.sessions, admin.settings,
// admin.health) had its own near-identical pair — the same display string
// could format slightly differently depending on which page you were on
// because copies drifted over time.
//
// Two flavors of formatDate existed before this consolidation — one that
// returned ASCII hyphen "-" on null, one that returned em-dash. We standardize
// on "-" because 10 of 11 admin pages already used that, so this is the
// least visually disruptive choice.

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function metricValue(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

// user_strikes.reason is a constrained code column (migration 20260512070000).
// Anything unrecognised falls back to the raw code rather than being hidden, so
// a future reason added in SQL still renders something meaningful.
const STRIKE_REASON_LABELS: Record<string, string> = {
  late_cancel_2h: "Late cancellation (within 2h)",
  late_cancel_30min: "Late cancellation (within 30 min)",
  no_show_learner: "No-show as learner",
  no_show_teacher: "No-show as teacher",
  admin_upheld_report: "Report upheld against them",
  admin_bad_faith_report: "Filed a bad-faith report",
  admin_other: "Manual moderator action",
};

export function strikeReasonLabel(reason: string): string {
  return STRIKE_REASON_LABELS[reason] ?? reason;
}

const SUSPENSION_LABELS: Record<string, string> = {
  none: "Good standing",
  teaching_only: "Teaching paused",
  full: "Cannot accept sessions",
  permanent: "Permanently suspended",
};

export function suspensionLabel(kind: string): string {
  return SUSPENSION_LABELS[kind] ?? kind;
}
