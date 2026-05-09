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
