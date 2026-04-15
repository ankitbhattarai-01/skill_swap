// Tiny UUID v4 (and broader RFC-4122) shape check. Used to gate route
// parameters before they reach a PostgREST query, where an unparseable
// UUID causes `invalid input syntax for type uuid` and a noisy 4xx that
// the UI then has to translate into a "Not found" toast anyway.
//
// We accept any RFC-4122 layout (8-4-4-4-12 hex, case-insensitive). The
// variant nibble check is intentionally loose — we just want to filter
// out obvious garbage like "abc" or "<script>", not enforce v4 vs v1.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
