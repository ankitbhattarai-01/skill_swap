# Admin Control Matrix

## Scope

This matrix maps the implemented enterprise admin controls to SOC 2, ISO 27001,
and GDPR-style objectives. It covers the Phase 1 rollout in
`20260511070000_enterprise_admin_phase1.sql` plus the `/admin` shell and secured
moderation action path.

## Control Mapping

| Objective                | Implemented control                                                                                                                    | Evidence                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Least privilege          | Granular `admin_permission_definitions` with domain/action pairs and scoped `admin_role_assignments`.                                  | `admin_has_permission`, `get_my_admin_permissions`                   |
| Separation of duties     | `admin_action_requests` blocks maker/checker self-approval. Settings versions also require separate proposer/approver.                 | `CHECK (checker_id IS NULL OR checker_id <> maker_id)`               |
| Privileged write control | Report status updates require `admin_update_report_status`; direct authenticated `UPDATE reports` is revoked.                          | RPC plus RLS deny policy                                             |
| Finance write control    | Manual credit adjustments, escrow refunds, and escrow releases are requested first and executed only by a separate approver.           | `request_finance_action`, `approve_finance_action`, `/admin/finance` |
| Mandatory reason capture | `admin_reason_codes` and audit function require reason + justification. Ticket references are enforced when configured.                | `admin_log_audit_event`                                              |
| Auditability             | `admin_audit_events` records actor, role snapshot, action, entity, before/after snapshots, correlation id, retention metadata.         | immutable audit table                                                |
| Tamper evidence          | Audit events include `prev_event_hash`, `event_hash`, and `checksum_version`. Hashing is serialized with an advisory transaction lock. | `admin_log_audit_event`                                              |
| Forensic verification    | Audit chain verification recomputes hashes and reports the first failing sequence.                                                     | `verify_admin_audit_chain`, `/admin/audit`                           |
| Export integrity         | Audit export manifests include range, event count, manifest hash, generator, timestamp, and correlation id.                            | `create_admin_audit_export_manifest`                                 |
| Case management          | Moderation reports can be promoted to SLA-tracked cases with assignment, escalation, disposition, and immutable notes.                 | `admin_cases`, `/admin/cases`                                        |
| Access review readiness  | Assignments include expiry, break-glass marker, incident ticket reference, and `access_review_due_at`.                                 | `admin_role_assignments`                                             |
| Access governance        | JIT role requests require ticket, duration, justification, and a separate checker for approval or rejection.                           | `admin_action_requests`, `/admin/access`                             |
| Finance assurance        | Finance dashboard exposes pending approvals, negative balances, stuck escrow, unusual velocity, reconciliation runs, and manifests.    | `get_admin_finance_dashboard`, `run_finance_reconciliation`          |
| Privacy and retention    | DSAR manifests, legal hold, anonymization, retention dry-runs, and PII reveal are server-enforced and audited.                         | `get_admin_compliance_dashboard`, `/admin/compliance`                |
| Data minimization        | User administration masks email/name by default and requires an audited reason before revealing restricted fields.                     | `get_admin_users`, `reveal_admin_user_pii`, `/admin/users`           |
| Data classification      | Key entities are tagged public/internal/confidential/restricted with retention class, purpose, and PII fields.                         | `data_classification_registry`                                       |
| Change control           | Settings changes use proposal, separate approval, publish, and rollback proposal workflows with before/after evidence.                 | `admin_settings_versions`, `/admin/settings`                         |
| Security monitoring      | Admin console and security dashboard expose policy denials, break-glass usage, suspicious bursts, pending approvals, and audit volume. | `get_admin_security_dashboard`, `/admin/security`                    |

## Current Gaps

Phase 1 closes the direct moderation write gap and establishes the control plane.
Phase 2 adds audit and security visibility. Phase 3 adds case management and JIT
access governance. Phase 4 adds finance maker-checker execution, reconciliation,
anomaly views, and report manifests. Phase 5 adds privacy operations, masked
user administration, retention dry-runs, data classification, and compliance
summary manifests. Phase 6 adds settings proposal, approval, publish, rollback,
and active feature-flag-ready config. Later phases should add edge-function SIEM
forwarding, scheduled retention purge workers, and access review exports.
