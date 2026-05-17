# RBAC and SoD Model

## Permission Format

Permissions use `domain:action`.

Domains: `moderation`, `users`, `sessions`, `wallet`, `analytics`,
`compliance`, `settings`, `incident-response`, `access-governance`, `security`,
and `privacy`.

Actions: `read`, `create`, `update`, `approve`, `export`, `override`, `reveal`,
and `delete`.

## Role Templates

| Role                 | Intended use                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `moderator`          | Report queue review with limited user/session context.                                                |
| `trust_lead`         | Senior moderation operator with escalation and export capability.                                     |
| `finance_ops`        | Wallet, escrow, and reconciliation operations. High-risk execution must use maker-checker.            |
| `compliance_auditor` | Read/export-only review role. Runtime checks ignore non-read/export grants.                           |
| `super_admin`        | Bootstrap and platform administration. Existing `profiles.is_admin` users map here for compatibility. |
| `break_glass`        | Emergency access only. Requires expiry and incident ticket reference.                                 |

## Scoped Access

Assignments support global, region, team, and entity scopes through
`scope_type`, `scope_value`, and optional `admin_policy_scopes.constraints`.
Server checks treat global as universal and otherwise require matching scope.

## Separation of Duties

High-risk requests are represented in `admin_action_requests`.

- The maker cannot be the checker.
- JIT admin access requests are submitted with `request_admin_access` and
  approved or rejected through `approve_admin_access_request` /
  `reject_admin_access_request`.
- Settings approvals require separate proposer and approver.
- Break-glass assignments require an expiry and incident ticket reference.
- Finance overrides are represented as `wallet:*` actions. Manual credit
  adjustments, escrow refunds, and escrow releases are submitted through
  `request_finance_action` and executed only by a different approver through
  `approve_finance_action`.

## Escalation Policy

Use the least privileged role first. Use `trust_lead` for moderation escalation,
`finance_ops` for wallet controls, `compliance_auditor` for evidence review, and
`break_glass` only during active incidents with a ticket reference and short
expiry.

## Case Operations

Moderation reports can be converted into `admin_cases`. Cases track severity,
SLA due time, escalation level, assignment, disposition, and internal notes.
All case changes go through secured RPCs and emit admin audit events.

## Finance Operations

Finance operators can request manual credit adjustments and escrow
interventions from `/admin/finance`. The server validates `wallet:override` for
makers, `wallet:approve` for checkers, mandatory ticket references, configured
reason codes, idempotency keys, and maker/checker separation before changing
`profiles.credits`, `credit_ledger`, or escrow session state. Reconciliation and
report manifest generation are separate audited operations requiring wallet read
or export permission.
