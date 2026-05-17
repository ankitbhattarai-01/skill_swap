# Data Retention and Privacy Runbook

## DSAR Export

1. Open `/admin/compliance` and create a privacy request with
   `request_type = 'dsar_export'`.
2. Validate requester identity outside the browser client and attach the ticket
   reference to the admin action.
3. Run the DSAR action from the privacy request row. The
   `complete_privacy_export` RPC creates a restricted manifest with subject data
   counts and a manifest hash.
4. Store the generated manifest in `privacy_requests.export_manifest`.
5. Verify the corresponding `privacy:export` entry in `/admin/audit`.

## Delete or Anonymize

1. Create a privacy request with `delete` or `anonymize`.
2. Check legal hold from `/admin/compliance`. If legal hold is enabled, the
   server blocks execution and keeps the request in `blocked_legal_hold`.
3. Run anonymization only after legal review. The
   `execute_privacy_anonymization` RPC removes profile PII and skill links while
   preserving ledger, safety, audit, and session evidence.
4. Use Supabase Auth/provider admin tooling for full identity deletion after
   confirming finance, safety, and legal retention obligations.
5. Record completion evidence in the privacy request and admin audit log.

## Retention Purge

1. Use `data_retention_policies` to select candidate rows.
2. Run dry-run purge first from `/admin/compliance`; `run_retention_purge`
   stores candidate counts and an integrity manifest in `retention_purge_runs`.
3. Execute destructive purge only from scheduled service-role jobs after archival
   and legal approval. The browser admin workflow records non-destructive runs
   only.
4. Skip legal holds and immutable audit events before their `purge_after`.

## PII Reveal

1. `/admin/users` displays masked email and name by default.
2. Reveal requires `users:reveal` or `privacy:reveal`, a ticket reference, and
   an eight-character minimum justification.
3. `reveal_admin_user_pii` emits a `privacy:reveal` audit event before returning
   restricted profile and identity fields.

## Default Policies

Admin audit events retain for seven years. Financial ledger records retain for
seven years. Trust and safety reports retain for three years unless a legal hold
extends the period.
