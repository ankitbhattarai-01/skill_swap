-- Fix: admin write actions (suspend/reinstate user, reveal PII, and every other
-- audited admin action) fail at the audit-logging step with
--   "function digest(...) does not exist".
--
-- Root cause: public.admin_log_audit_event() — and a handful of manifest/hash
-- helpers — call digest()/encode(digest(...)) unqualified, but these are
-- declared with `SET search_path = public`. pgcrypto (which provides digest)
-- lives in the `extensions` schema on Supabase, so the bare digest() reference
-- is unresolvable at call time and every audited action raises an exception.
--
-- Because admin_log_audit_event is the final step of admin_suspend_user,
-- admin_reinstate_user and reveal_admin_user_pii, the dialog submit fails for
-- all three even though the UI and permission checks are correct.
--
-- This migration makes pgcrypto reachable and adds `extensions` to the
-- search_path of every affected SECURITY DEFINER function. It resolves each
-- function by name across both `public` and `private` (functions were moved to
-- `private` by the later security-definer wrapper migrations), so it is safe to
-- run regardless of which of those wrapper migrations have been applied.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE
  v_target_names TEXT[] := ARRAY[
    'admin_log_audit_event',
    'verify_admin_audit_chain',
    'create_admin_audit_export_manifest',
    'create_compliance_summary_manifest',
    'create_finance_report_manifest',
    'run_retention_purge',
    'complete_privacy_export'
  ];
  v_fn oid;
BEGIN
  FOR v_fn IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE p.proname = ANY (v_target_names)
      AND ns.nspname IN ('public', 'private')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, extensions, pg_temp',
      v_fn::regprocedure
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
