# Change Management Process

## Lifecycle

Configuration and policy changes use `admin_settings_versions`.

1. Proposal: proposer submits a new setting version through `/admin/settings`
   with JSON value, reason, justification, and ticket reference.
2. Pending approval: reviewer compares `previous_value` and `proposed_value`
   and verifies test or rollout evidence.
3. Approved or rejected: checker must be different from proposer. The
   `approve_admin_setting_version` and `reject_admin_setting_version` RPCs
   enforce maker-checker separation.
4. Published: `publish_admin_setting_version` writes the value into
   `admin_active_settings` and records immutable audit evidence.
5. Rollback: `propose_admin_setting_rollback` creates a new pending proposal
   from a previously published value, so rollback still follows approval.

## Required Evidence

Every change must include a reason code, justification, ticket reference when
required, before/after values, proposing actor, approving actor, publication
timestamp, and the audit event hash chain.

## Rollout Safety

Feature flags are regular active settings such as
`admin.feature.phase6.enabled`. Backward compatibility is preserved by keeping
`is_admin` as a bootstrap compatibility check while new authorization uses
`admin_has_permission`.

## Emergency Changes

Emergency changes require break-glass access with expiry and incident reference.
After resolution, revoke the assignment and attach the audit event chain to the
incident record.
