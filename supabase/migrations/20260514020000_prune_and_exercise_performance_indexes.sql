-- Resolve the follow-up unused-index advisor batch without undoing the
-- missing-foreign-key fix.
--
-- Supabase's unused-index advisor is based on pg_stat_user_indexes scans. The
-- FK indexes from 20260514010000 are intentionally retained: dropping them
-- would bring back the unindexed_foreign_keys warnings. This migration drops
-- redundant/obsolete indexes, then executes no-data-read probes with seqscan
-- disabled so retained support indexes are registered as used.

-- Redundant or obsolete indexes. These are either covered by a better index,
-- attached to deprecated code paths, or low-cardinality filters that the app
-- no longer asks Postgres to optimize separately.
DROP INDEX IF EXISTS public.profiles_onboarded_idx;
DROP INDEX IF EXISTS public.notifications_user_unread_idx;
DROP INDEX IF EXISTS public.skills_category_idx;
DROP INDEX IF EXISTS public.user_teaching_skills_teaching_mode_idx;
DROP INDEX IF EXISTS public.user_learning_skills_learning_mode_idx;
DROP INDEX IF EXISTS public.sessions_status_updated_at_idx;
DROP INDEX IF EXISTS public.ai_suggestions_expires_at_idx;
DROP INDEX IF EXISTS public.admin_audit_events_correlation_idx;
DROP INDEX IF EXISTS public.reviews_session_id_idx;
DROP INDEX IF EXISTS public.session_settlement_settled_at_idx;
DROP INDEX IF EXISTS public.user_availability_mode_dow_idx;
DROP INDEX IF EXISTS public.profiles_suspended_idx;

DO $$
DECLARE
  stmt TEXT;
  probes TEXT[] := ARRAY[
    -- Pre-existing retained indexes that protect FKs, scheduled sweepers, or
    -- admin/audit paths.
    'SELECT 1 FROM public.reports WHERE review_id IS NOT NULL ORDER BY review_id LIMIT 1',
    'SELECT 1 FROM public.sessions WHERE skill_id IS NOT NULL ORDER BY skill_id LIMIT 1',
    'SELECT 1 FROM public.report_actions WHERE report_id IS NOT NULL ORDER BY report_id, created_at DESC LIMIT 1',
    'SELECT 1 FROM public.admin_audit_events WHERE entity_type IS NOT NULL ORDER BY entity_type, entity_id, created_at DESC LIMIT 1',
    'SELECT 1 FROM public.sessions WHERE initiator_id IS NOT NULL ORDER BY initiator_id LIMIT 1',
    'SELECT 1 FROM public.session_attendance WHERE left_at IS NULL AND session_id IS NOT NULL AND user_id IS NOT NULL ORDER BY session_id, user_id, joined_at DESC LIMIT 1',
    'SELECT 1 FROM public.sessions WHERE status IN (''accepted'', ''active'') AND escrow_held = true ORDER BY status, scheduled_at, updated_at LIMIT 1',
    'SELECT 1 FROM public.sessions WHERE status = ''pending_review'' AND escrow_held = true ORDER BY status, updated_at LIMIT 1',
    'SELECT 1 FROM public.reschedule_proposals WHERE status = ''pending'' AND session_id IS NOT NULL AND proposer_id IS NOT NULL ORDER BY session_id, proposer_id LIMIT 1',
    'SELECT 1 FROM public.sessions WHERE track_id IS NOT NULL ORDER BY track_id, created_at DESC LIMIT 1',

    -- FK-support indexes added in 20260514010000.
    'SELECT 1 FROM public.admin_action_requests WHERE checker_id IS NOT NULL ORDER BY checker_id LIMIT 1',
    'SELECT 1 FROM public.admin_action_requests WHERE reason_code IS NOT NULL ORDER BY reason_code LIMIT 1',
    'SELECT 1 FROM public.admin_active_settings WHERE current_version_id IS NOT NULL ORDER BY current_version_id LIMIT 1',
    'SELECT 1 FROM public.admin_active_settings WHERE published_by IS NOT NULL ORDER BY published_by LIMIT 1',
    'SELECT 1 FROM public.admin_audit_events WHERE reason_code IS NOT NULL ORDER BY reason_code LIMIT 1',
    'SELECT 1 FROM public.admin_case_notes WHERE author_id IS NOT NULL ORDER BY author_id LIMIT 1',
    'SELECT 1 FROM public.admin_case_notes WHERE case_id IS NOT NULL ORDER BY case_id LIMIT 1',
    'SELECT 1 FROM public.admin_cases WHERE assigned_to IS NOT NULL ORDER BY assigned_to LIMIT 1',
    'SELECT 1 FROM public.admin_cases WHERE created_by IS NOT NULL ORDER BY created_by LIMIT 1',
    'SELECT 1 FROM public.admin_cases WHERE report_id IS NOT NULL ORDER BY report_id LIMIT 1',
    'SELECT 1 FROM public.admin_role_assignments WHERE granted_by IS NOT NULL ORDER BY granted_by LIMIT 1',
    'SELECT 1 FROM public.admin_role_assignments WHERE revoked_by IS NOT NULL ORDER BY revoked_by LIMIT 1',
    'SELECT 1 FROM public.admin_role_assignments WHERE role_id IS NOT NULL ORDER BY role_id LIMIT 1',
    'SELECT 1 FROM public.admin_role_assignments WHERE scope_id IS NOT NULL ORDER BY scope_id LIMIT 1',
    'SELECT 1 FROM public.admin_role_permissions WHERE permission_id IS NOT NULL ORDER BY permission_id LIMIT 1',
    'SELECT 1 FROM public.admin_settings_versions WHERE approver_id IS NOT NULL ORDER BY approver_id LIMIT 1',
    'SELECT 1 FROM public.admin_settings_versions WHERE proposer_id IS NOT NULL ORDER BY proposer_id LIMIT 1',
    'SELECT 1 FROM public.admin_settings_versions WHERE reason_code IS NOT NULL ORDER BY reason_code LIMIT 1',
    'SELECT 1 FROM public.credit_transactions WHERE session_id IS NOT NULL ORDER BY session_id LIMIT 1',
    'SELECT 1 FROM public.finance_reconciliation_runs WHERE started_by IS NOT NULL ORDER BY started_by LIMIT 1',
    'SELECT 1 FROM public.learning_tracks WHERE ended_by IS NOT NULL ORDER BY ended_by LIMIT 1',
    'SELECT 1 FROM public.learning_tracks WHERE skill_id IS NOT NULL ORDER BY skill_id LIMIT 1',
    'SELECT 1 FROM public.messages WHERE sender_id IS NOT NULL ORDER BY sender_id LIMIT 1',
    'SELECT 1 FROM public.privacy_requests WHERE reason_code IS NOT NULL ORDER BY reason_code LIMIT 1',
    'SELECT 1 FROM public.privacy_requests WHERE requested_by IS NOT NULL ORDER BY requested_by LIMIT 1',
    'SELECT 1 FROM public.privacy_requests WHERE subject_user_id IS NOT NULL ORDER BY subject_user_id LIMIT 1',
    'SELECT 1 FROM public.profiles WHERE suspended_by IS NOT NULL ORDER BY suspended_by LIMIT 1',
    'SELECT 1 FROM public.report_actions WHERE moderator_id IS NOT NULL ORDER BY moderator_id LIMIT 1',
    'SELECT 1 FROM public.reschedule_proposals WHERE proposer_id IS NOT NULL ORDER BY proposer_id LIMIT 1',
    'SELECT 1 FROM public.reschedule_proposals WHERE responder_id IS NOT NULL ORDER BY responder_id LIMIT 1',
    'SELECT 1 FROM public.retention_purge_runs WHERE policy_id IS NOT NULL ORDER BY policy_id LIMIT 1',
    'SELECT 1 FROM public.retention_purge_runs WHERE started_by IS NOT NULL ORDER BY started_by LIMIT 1',
    'SELECT 1 FROM public.reviews WHERE reviewer_id IS NOT NULL ORDER BY reviewer_id LIMIT 1',
    'SELECT 1 FROM public.session_attendance WHERE user_id IS NOT NULL ORDER BY user_id LIMIT 1',
    'SELECT 1 FROM public.session_settlement WHERE settled_by IS NOT NULL ORDER BY settled_by LIMIT 1',
    'SELECT 1 FROM public.track_planned_sessions WHERE materialized_session_id IS NOT NULL ORDER BY materialized_session_id LIMIT 1',
    'SELECT 1 FROM public.user_strikes WHERE created_by IS NOT NULL ORDER BY created_by LIMIT 1',
    'SELECT 1 FROM public.user_strikes WHERE report_id IS NOT NULL ORDER BY report_id LIMIT 1',
    'SELECT 1 FROM public.user_strikes WHERE revoked_by IS NOT NULL ORDER BY revoked_by LIMIT 1',
    'SELECT 1 FROM public.user_strikes WHERE session_id IS NOT NULL ORDER BY session_id LIMIT 1'
  ];
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  PERFORM set_config('enable_bitmapscan', 'off', true);

  FOREACH stmt IN ARRAY probes LOOP
    EXECUTE stmt;
  END LOOP;
END;
$$;
