-- Add covering indexes for foreign keys reported by the Supabase performance
-- advisor. These indexes help deletes/updates on referenced rows and common
-- joins avoid table scans. They are intentionally additive and do not change
-- authorization or application behavior.

CREATE INDEX IF NOT EXISTS admin_action_requests_checker_id_idx
  ON public.admin_action_requests (checker_id);
CREATE INDEX IF NOT EXISTS admin_action_requests_reason_code_idx
  ON public.admin_action_requests (reason_code);

CREATE INDEX IF NOT EXISTS admin_active_settings_current_version_id_idx
  ON public.admin_active_settings (current_version_id);
CREATE INDEX IF NOT EXISTS admin_active_settings_published_by_idx
  ON public.admin_active_settings (published_by);

CREATE INDEX IF NOT EXISTS admin_audit_events_reason_code_idx
  ON public.admin_audit_events (reason_code);

CREATE INDEX IF NOT EXISTS admin_case_notes_author_id_idx
  ON public.admin_case_notes (author_id);
CREATE INDEX IF NOT EXISTS admin_case_notes_case_id_idx
  ON public.admin_case_notes (case_id);

CREATE INDEX IF NOT EXISTS admin_cases_assigned_to_idx
  ON public.admin_cases (assigned_to);
CREATE INDEX IF NOT EXISTS admin_cases_created_by_idx
  ON public.admin_cases (created_by);
CREATE INDEX IF NOT EXISTS admin_cases_report_id_idx
  ON public.admin_cases (report_id);

CREATE INDEX IF NOT EXISTS admin_role_assignments_granted_by_idx
  ON public.admin_role_assignments (granted_by);
CREATE INDEX IF NOT EXISTS admin_role_assignments_revoked_by_idx
  ON public.admin_role_assignments (revoked_by);
CREATE INDEX IF NOT EXISTS admin_role_assignments_role_id_idx
  ON public.admin_role_assignments (role_id);
CREATE INDEX IF NOT EXISTS admin_role_assignments_scope_id_idx
  ON public.admin_role_assignments (scope_id);

CREATE INDEX IF NOT EXISTS admin_role_permissions_permission_id_idx
  ON public.admin_role_permissions (permission_id);

CREATE INDEX IF NOT EXISTS admin_settings_versions_approver_id_idx
  ON public.admin_settings_versions (approver_id);
CREATE INDEX IF NOT EXISTS admin_settings_versions_proposer_id_idx
  ON public.admin_settings_versions (proposer_id);
CREATE INDEX IF NOT EXISTS admin_settings_versions_reason_code_idx
  ON public.admin_settings_versions (reason_code);

CREATE INDEX IF NOT EXISTS credit_transactions_session_id_idx
  ON public.credit_transactions (session_id);

CREATE INDEX IF NOT EXISTS finance_reconciliation_runs_started_by_idx
  ON public.finance_reconciliation_runs (started_by);

CREATE INDEX IF NOT EXISTS learning_tracks_ended_by_idx
  ON public.learning_tracks (ended_by);
CREATE INDEX IF NOT EXISTS learning_tracks_skill_id_idx
  ON public.learning_tracks (skill_id);

CREATE INDEX IF NOT EXISTS messages_sender_id_idx
  ON public.messages (sender_id);

CREATE INDEX IF NOT EXISTS privacy_requests_reason_code_idx
  ON public.privacy_requests (reason_code);
CREATE INDEX IF NOT EXISTS privacy_requests_requested_by_idx
  ON public.privacy_requests (requested_by);
CREATE INDEX IF NOT EXISTS privacy_requests_subject_user_id_idx
  ON public.privacy_requests (subject_user_id);

CREATE INDEX IF NOT EXISTS profiles_suspended_by_idx
  ON public.profiles (suspended_by);

CREATE INDEX IF NOT EXISTS report_actions_moderator_id_idx
  ON public.report_actions (moderator_id);

CREATE INDEX IF NOT EXISTS reschedule_proposals_proposer_id_idx
  ON public.reschedule_proposals (proposer_id);
CREATE INDEX IF NOT EXISTS reschedule_proposals_responder_id_idx
  ON public.reschedule_proposals (responder_id);

CREATE INDEX IF NOT EXISTS retention_purge_runs_policy_id_idx
  ON public.retention_purge_runs (policy_id);
CREATE INDEX IF NOT EXISTS retention_purge_runs_started_by_idx
  ON public.retention_purge_runs (started_by);

CREATE INDEX IF NOT EXISTS reviews_reviewer_id_idx
  ON public.reviews (reviewer_id);

CREATE INDEX IF NOT EXISTS session_attendance_user_id_idx
  ON public.session_attendance (user_id);

CREATE INDEX IF NOT EXISTS session_settlement_settled_by_idx
  ON public.session_settlement (settled_by);

CREATE INDEX IF NOT EXISTS track_planned_sessions_materialized_session_id_idx
  ON public.track_planned_sessions (materialized_session_id);

CREATE INDEX IF NOT EXISTS user_strikes_created_by_idx
  ON public.user_strikes (created_by);
CREATE INDEX IF NOT EXISTS user_strikes_report_id_idx
  ON public.user_strikes (report_id);
CREATE INDEX IF NOT EXISTS user_strikes_revoked_by_idx
  ON public.user_strikes (revoked_by);
CREATE INDEX IF NOT EXISTS user_strikes_session_id_idx
  ON public.user_strikes (session_id);
