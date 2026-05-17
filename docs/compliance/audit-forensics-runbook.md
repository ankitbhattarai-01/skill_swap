# Audit and Forensics Runbook

## Investigation Start

1. Identify the actor, entity, correlation id, ticket reference, or time window.
2. Query `admin_audit_events` through a compliance/security role.
3. Reconstruct state transitions from `before_snapshot` and `after_snapshot`.
4. Join related moderation evidence from `reports` and `report_actions` when the
   entity type is `report`.

## Integrity Verification

In the admin panel, open `/admin/audit`. The Chain status card calls
`verify_admin_audit_chain(1000)` and reports the first failing sequence if the
chain is broken.

For each event ordered by `sequence`:

1. Confirm `prev_event_hash` matches the previous row's `event_hash`.
2. Recompute the hash using checksum version `1` fields:
   `sequence`, `id`, `actor_id`, `domain`, `action`, `entity_type`,
   `entity_id`, `reason_code`, `justification`, before/after snapshots,
   previous hash, and `correlation_id`.
3. Any mismatch is a potential tampering incident and should be linked to an
   incident-response case.

## Evidence Preservation

Admin audit events are append-only. The mutation trigger blocks updates and
deletes. Legal holds are represented by `legal_hold = true`, and purge processes
must skip held rows.

## SIEM Forwarding

Use the audit schema as the canonical event contract. Forward at least:
`sequence`, `id`, `actor_id`, `domain`, `action`, `entity_type`, `entity_id`,
`reason_code`, `ticket_ref`, `correlation_id`, `event_hash`, `prev_event_hash`,
and `created_at`.

## Export Manifest

Use `create_admin_audit_export_manifest(from, to, reason, justification, ticket)`
for compliance exports. It returns event count, manifest hash, timestamp,
generator, and correlation id, then writes the export itself into the audit
chain.
