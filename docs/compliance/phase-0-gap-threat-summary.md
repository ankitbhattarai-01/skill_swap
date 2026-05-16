# Phase 0 Gap and Threat Summary

## Observed Baseline

The application already has strong hardening patterns for reports, sessions,
credits, notifications, and account deletion. The main admin primitive was a
boolean `profiles.is_admin` plus an `is_admin` RPC. The moderation queue used a
server-side read RPC, but report status changes still happened through a direct
client `UPDATE`.

## Primary Gaps

- Admin authorization was coarse grained and difficult to review quarterly.
- Privileged status updates did not require reason codes, ticket references, or
  justification.
- The existing report action log was useful but not tamper-evident.
- No maker-checker queue existed for finance, settings, or emergency access.
- Retention, privacy, DSAR, legal hold, and purge evidence were not modeled.
- The frontend admin surface was a single moderation route rather than a
  compliance-oriented shell.

## Threats Addressed First

- Unauthorized report state changes by a broad admin role.
- Missing forensic evidence after privileged actions.
- Insider abuse without reason capture.
- Admin account enumeration through compatibility paths.
- Duplicate high-risk actions without idempotency keys.

## Phase 1 Result

Phase 1 introduces granular RBAC, scoped assignments, reason taxonomy,
tamper-evident audit events, SoD-ready requests, governance tables, and a secured
moderation update RPC. The UI now uses permission-aware rendering and a
mandatory reason modal for report status changes.
