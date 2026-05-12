-- Admin security boundary smoke tests.
-- Run against a migrated local database with:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin_security_boundaries.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'reports'
      AND grantee = 'authenticated'
      AND privilege_type = 'UPDATE'
  ) THEN
    RAISE NOTICE 'ok - authenticated has no direct UPDATE grant on reports';
  ELSE
    RAISE EXCEPTION 'authenticated must not have direct UPDATE on reports';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reports'
      AND policyname = 'Admins update reports via RPC only'
      AND qual LIKE '%false%'
  ) THEN
    RAISE EXCEPTION 'reports update deny policy is missing';
  END IF;

  RAISE NOTICE 'ok - reports direct admin update policy denies browser writes';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'admin_audit_events_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'admin audit immutability trigger is missing';
  END IF;

  RAISE NOTICE 'ok - audit immutability trigger exists';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'admin_update_report_status'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'admin_update_report_status must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - moderation status RPC is SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'verify_admin_audit_chain'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'verify_admin_audit_chain must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'create_admin_audit_export_manifest'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'create_admin_audit_export_manifest must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - Phase 2 audit verification/export RPCs are SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'admin_create_case_from_report'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'admin_create_case_from_report must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'approve_admin_access_request'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'approve_admin_access_request must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - Phase 3 case/access RPCs are SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'request_finance_action'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'request_finance_action must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'approve_finance_action'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'approve_finance_action must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'run_finance_reconciliation'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'run_finance_reconciliation must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - Phase 4 finance RPCs are SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'reveal_admin_user_pii'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'reveal_admin_user_pii must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'complete_privacy_export'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'complete_privacy_export must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'run_retention_purge'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'run_retention_purge must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'create_compliance_summary_manifest'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'create_compliance_summary_manifest must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - Phase 5 privacy/compliance RPCs are SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'propose_admin_setting_change'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'propose_admin_setting_change must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'approve_admin_setting_version'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'approve_admin_setting_version must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'publish_admin_setting_version'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'publish_admin_setting_version must be SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'ok - Phase 6 settings RPCs are SECURITY DEFINER';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_name LIKE '%admin_action_requests%'
      AND check_clause LIKE '%checker_id%'
      AND check_clause LIKE '%maker_id%'
  ) THEN
    RAISE NOTICE 'warning - maker/checker constraint name was not discoverable; inspect admin_action_requests checks manually';
  ELSE
    RAISE NOTICE 'ok - maker/checker SoD check is discoverable';
  END IF;
END;
$$;
