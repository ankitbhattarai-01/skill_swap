import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";

export type AdminDomain =
  | "moderation"
  | "users"
  | "sessions"
  | "wallet"
  | "analytics"
  | "compliance"
  | "settings"
  | "incident-response"
  | "access-governance"
  | "security"
  | "privacy";

export type AdminAction =
  | "read"
  | "create"
  | "update"
  | "approve"
  | "export"
  | "override"
  | "reveal"
  | "delete";

export type AdminPermission = {
  domain: AdminDomain;
  action: AdminAction;
  high_risk: boolean;
  requires_reauth: boolean;
  role_slug: string;
  scope_type: string;
  scope_value: string | null;
  expires_at: string | null;
  break_glass: boolean;
};

export type AdminSnapshot = {
  users?: {
    total?: number;
    profiles?: number;
    onboarded?: number;
    admins?: number;
  };
  sessions?: Record<string, number>;
  reports?: Record<string, number>;
  ledger?: {
    transactions?: number;
    creditsMoved24h?: number;
    negativeBalances?: number;
  };
  privacy?: {
    openRequests?: number;
    legalHolds?: number;
  };
  pendingActionRequests?: number;
  auditEvents24h?: number;
  breakGlassActive?: number;
  overdueAccessReviews?: number;
  policyDenials24h?: number;
  generatedAt?: string;
};

export type AdminAuditEvent = {
  sequence: number;
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role_snapshot: unknown;
  domain: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  reason_code: string;
  justification: string;
  ticket_ref: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  retention_class: string;
  purge_after: string;
  legal_hold: boolean;
  checksum_version: number;
  prev_event_hash: string | null;
  event_hash: string;
  before_snapshot: unknown | null;
  after_snapshot: unknown | null;
};

export type AuditChainVerification = {
  ok?: boolean;
  checkedEvents?: number;
  firstFailureSequence?: number | null;
  latestHash?: string | null;
  checksumVersion?: number;
  verifiedAt?: string;
};

export type SecurityDashboard = {
  policyDenials24h?: number;
  policyDenials7d?: number;
  breakGlassActive?: number;
  privilegedActions24h?: number;
  suspiciousBursts24h?: number;
  recentPolicyDenials?: {
    created_at: string;
    actor_id: string | null;
    actor_email: string | null;
    domain: string;
    entity_type: string;
    entity_id: string | null;
    reason_code: string;
    correlation_id: string;
  }[];
  activeBreakGlass?: {
    user_id: string;
    user_email: string | null;
    starts_at: string;
    expires_at: string | null;
    incident_ticket_ref: string | null;
    grant_reason: string;
  }[];
  generatedAt?: string;
};

export type AdminCase = {
  id: string;
  case_number: string;
  report_id: string | null;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "assigned" | "escalated" | "resolved" | "dismissed";
  assigned_to: string | null;
  assigned_to_email: string | null;
  sla_due_at: string;
  escalation_level: number;
  disposition: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  report_reason: string | null;
  report_status: string | null;
  reported_user_id: string | null;
  reported_user_email: string | null;
  note_count: number;
};

export type AdminCaseNote = {
  id: string;
  case_id: string;
  author_id: string | null;
  author_email: string | null;
  visibility: "internal" | "compliance" | "incident-response";
  body: string;
  created_at: string;
};

export type AccessGovernance = {
  pendingRequests?: number;
  activeAssignments?: number;
  expiringSoon?: number;
  overdueReviews?: number;
  breakGlassActive?: number;
  generatedAt?: string;
  requests?: {
    id: string;
    status: string;
    maker_id: string | null;
    maker_email: string | null;
    checker_id: string | null;
    checker_email: string | null;
    reason_code: string;
    justification: string;
    ticket_ref: string | null;
    payload: Record<string, unknown>;
    created_at: string;
    expires_at: string;
    decided_at: string | null;
    executed_at: string | null;
  }[];
  assignments?: {
    id: string;
    user_id: string;
    user_email: string | null;
    role_slug: string;
    scope_type: string;
    scope_value: string | null;
    starts_at: string;
    expires_at: string | null;
    break_glass: boolean;
    incident_ticket_ref: string | null;
    access_review_due_at: string;
    revoked_at: string | null;
  }[];
};

export type FinanceDashboard = {
  pendingFinanceRequests?: number;
  negativeBalances?: number;
  stuckEscrow?: number;
  unusualVelocity24h?: number;
  ledgerEntries24h?: number;
  creditsMoved24h?: number;
  generatedAt?: string;
  requests?: {
    id: string;
    status: string;
    maker_id: string | null;
    maker_email: string | null;
    checker_id: string | null;
    checker_email: string | null;
    reason_code: string;
    justification: string;
    ticket_ref: string | null;
    payload: Record<string, unknown>;
    created_at: string;
    decided_at: string | null;
    executed_at: string | null;
  }[];
  negativeBalanceRows?: {
    user_id: string;
    user_email: string | null;
    credits: number;
  }[];
  stuckEscrowRows?: {
    id: string;
    learner_id: string | null;
    learner_email: string | null;
    teacher_id: string | null;
    teacher_email: string | null;
    credits: number;
    status: string;
    scheduled_at: string | null;
    updated_at: string;
  }[];
  recentReconciliations?: {
    id: string;
    run_type: string;
    status: string;
    negative_balance_count: number;
    stuck_escrow_count: number;
    unusual_velocity_count: number;
    started_at: string;
    completed_at: string;
  }[];
};

export type SessionsDashboard = {
  _fallback?: boolean;
  statusCounts?: Record<string, number>;
  totalSessions?: number;
  activeSessions?: number;
  scheduledNext7d?: number;
  stuckEscrow?: number;
  reportedSessions?: number;
  generatedAt?: string;
  recentSessions?: {
    id: string;
    status: string;
    credits: number;
    duration_minutes: number;
    escrow_held: boolean;
    scheduled_at: string | null;
    created_at: string;
    updated_at: string;
    learner_id: string | null;
    learner_email: string | null;
    teacher_id: string | null;
    teacher_email: string | null;
    skill_name: string | null;
    skill_category: string | null;
    open_report_count: number;
  }[];
};

export type AdminUserRow = {
  id: string;
  masked_email: string | null;
  masked_name: string | null;
  onboarded: boolean | null;
  learning_mode: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  has_admin_role: boolean;
  session_count: number;
  report_count: number;
};

export type ComplianceDashboard = {
  privilegedActionVolume24h?: number;
  makerCheckerTurnaroundHours7d?: number;
  overdueAccessReviews?: number;
  openPrivacyRequests?: number;
  overduePrivacyRequests?: number;
  retentionPoliciesEnabled?: number;
  lastPurgeStatus?: string | null;
  moderationSlaBreaches?: number;
  walletAnomalyCount?: number;
  generatedAt?: string;
  privacyRequests?: {
    id: string;
    subject_user_id: string | null;
    masked_subject_email: string | null;
    request_type: string;
    status: string;
    due_at: string;
    legal_hold: boolean;
    reason_code: string | null;
    justification: string | null;
    export_manifest: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }[];
  retentionPolicies?: {
    id: string;
    data_type: string;
    retention_class: string;
    retain_for: string;
    legal_basis: string;
    anonymize_instead_of_delete: boolean;
    enabled: boolean;
    updated_at: string;
  }[];
  purgeRuns?: {
    id: string;
    policy_id: string | null;
    data_type: string | null;
    dry_run: boolean;
    status: string;
    candidate_count: number;
    purged_count: number;
    manifest: Record<string, unknown>;
    started_at: string;
    completed_at: string | null;
  }[];
  classifications?: {
    entity_type: string;
    classification: "public" | "internal" | "confidential" | "restricted";
    pii_fields: string[];
    retention_class: string;
    purpose: string;
    default_masking: boolean;
  }[];
};

export type SettingsDashboard = {
  pendingApprovals?: number;
  publishedSettings?: number;
  changes7d?: number;
  generatedAt?: string;
  activeSettings?: {
    setting_key: string;
    current_version_id: string | null;
    current_value: Record<string, unknown>;
    published_by: string | null;
    published_by_email: string | null;
    published_at: string;
    updated_at: string;
  }[];
  versions?: {
    id: string;
    setting_key: string;
    version: number;
    status: string;
    proposed_value: Record<string, unknown>;
    previous_value: Record<string, unknown> | null;
    proposer_id: string | null;
    proposer_email: string | null;
    approver_id: string | null;
    approver_email: string | null;
    reason_code: string;
    justification: string;
    published_at: string | null;
    created_at: string;
  }[];
};

export const ADMIN_PERMISSIONS_KEY = (userId: string | null | undefined) =>
  ["admin-permissions", userId] as const;

export const ADMIN_SNAPSHOT_KEY = (userId: string | null | undefined) =>
  ["admin-snapshot", userId] as const;

export const ADMIN_AUDIT_EVENTS_KEY = (userId: string | null | undefined, limit?: number) =>
  ["admin-audit-events", userId, limit] as const;

export const ADMIN_AUDIT_VERIFY_KEY = (userId: string | null | undefined) =>
  ["admin-audit-verify", userId] as const;

export const ADMIN_SECURITY_DASHBOARD_KEY = (userId: string | null | undefined) =>
  ["admin-security-dashboard", userId] as const;

export const ADMIN_CASES_KEY = (userId: string | null | undefined) =>
  ["admin-cases", userId] as const;

export const ADMIN_CASE_NOTES_KEY = (userId: string | null | undefined, caseId: string | null) =>
  ["admin-case-notes", userId, caseId] as const;

export const ADMIN_ACCESS_GOVERNANCE_KEY = (userId: string | null | undefined) =>
  ["admin-access-governance", userId] as const;

export const ADMIN_FINANCE_DASHBOARD_KEY = (userId: string | null | undefined) =>
  ["admin-finance-dashboard", userId] as const;

export const ADMIN_SESSIONS_DASHBOARD_KEY = (userId: string | null | undefined, status: string) =>
  ["admin-sessions-dashboard", userId, status] as const;

export const ADMIN_USERS_KEY = (userId: string | null | undefined, search: string) =>
  ["admin-users", userId, search] as const;

export const ADMIN_COMPLIANCE_DASHBOARD_KEY = (userId: string | null | undefined) =>
  ["admin-compliance-dashboard", userId] as const;

export const ADMIN_SETTINGS_DASHBOARD_KEY = (userId: string | null | undefined) =>
  ["admin-settings-dashboard", userId] as const;

export function adminErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
  }
  return "RPC failed";
}

function maskName(value: string | null) {
  if (!value) return null;
  return `${value.slice(0, 1)}${"*".repeat(Math.max(value.length - 1, 0))}`;
}

export function hasAdminPermission(
  permissions: AdminPermission[] | undefined,
  domain: AdminDomain,
  action: AdminAction,
) {
  return Boolean(permissions?.some((p) => p.domain === domain && p.action === action));
}

export function useAdminPermissions() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_PERMISSIONS_KEY(user?.id),
    enabled: Boolean(user?.id),
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_admin_permissions");
      if (error) throw error;
      return (data ?? []) as AdminPermission[];
    },
  });
}

export function useAdminSnapshot(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_SNAPSHOT_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_console_snapshot");
      if (error) throw error;
      return (data ?? {}) as AdminSnapshot;
    },
  });
}

export function useAdminAuditEvents(enabled: boolean, limit: number = 100) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_AUDIT_EVENTS_KEY(user?.id, limit),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_audit_events", {
        p_limit: limit,
      });
      if (error) throw error;
      return (data ?? []) as AdminAuditEvent[];
    },
  });
}

export function useAdminAuditVerification(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_AUDIT_VERIFY_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("verify_admin_audit_chain", {
        p_limit: 1000,
      });
      if (error) throw error;
      return (data ?? {}) as AuditChainVerification;
    },
  });
}

export function useAdminSecurityDashboard(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_SECURITY_DASHBOARD_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_security_dashboard");
      if (error) throw error;
      return (data ?? {}) as SecurityDashboard;
    },
  });
}

export function useAdminCases(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_CASES_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_cases", {
        p_limit: 100,
      });
      if (error) throw error;
      return (data ?? []) as AdminCase[];
    },
  });
}

export function useAdminCaseNotes(caseId: string | null) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_CASE_NOTES_KEY(user?.id, caseId),
    enabled: Boolean(user?.id) && Boolean(caseId),
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!caseId) return [] as AdminCaseNote[];
      const { data, error } = await supabase.rpc("get_admin_case_notes", {
        p_case_id: caseId,
      });
      if (error) throw error;
      return (data ?? []) as AdminCaseNote[];
    },
  });
}

export function useAccessGovernance(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_ACCESS_GOVERNANCE_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_access_governance");
      if (error) throw error;
      return (data ?? {}) as AccessGovernance;
    },
  });
}

export function useAdminFinanceDashboard(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_FINANCE_DASHBOARD_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_finance_dashboard");
      if (error) throw error;
      return (data ?? {}) as FinanceDashboard;
    },
  });
}

export function useAdminSessionsDashboard(enabled: boolean, status: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_SESSIONS_DASHBOARD_KEY(user?.id, status),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_sessions_dashboard", {
        p_limit: 75,
        p_status: status === "all" ? null : status,
      });

      // Fallback when the RPC migration has not been applied to the live
      // database yet (PostgREST PGRST202). Build a basic dashboard from a
      // direct sessions query so the page still renders.
      const code = (error as { code?: string } | null)?.code;
      const missingFunction = code === "PGRST202" || code === "42883";
      if (error && missingFunction) {
        let fallback = supabase
          .from("sessions")
          .select(
            "id, status, credits, duration_minutes, escrow_held, scheduled_at, created_at, updated_at, learner_id, teacher_id, skill_id",
          )
          .order("updated_at", { ascending: false })
          .limit(75);
        if (status !== "all")
          fallback = fallback.eq(
            "status",
            status as "pending" | "accepted" | "rejected" | "active" | "completed" | "cancelled",
          );
        const { data: rows, error: fallbackError } = await fallback;
        if (fallbackError) throw error;

        const statusCounts: Record<string, number> = {};
        for (const row of rows ?? []) {
          const key = row.status ?? "unknown";
          statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        }
        return {
          _fallback: true,
          statusCounts,
          totalSessions: rows?.length ?? 0,
          activeSessions: (rows ?? []).filter((row) =>
            ["accepted", "active"].includes(row.status ?? ""),
          ).length,
          scheduledNext7d: 0,
          stuckEscrow: 0,
          reportedSessions: 0,
          generatedAt: new Date().toISOString(),
          recentSessions: (rows ?? []).map((row) => ({
            id: row.id,
            status: row.status ?? "unknown",
            credits: row.credits ?? 0,
            duration_minutes: row.duration_minutes ?? 0,
            escrow_held: Boolean(row.escrow_held),
            scheduled_at: row.scheduled_at,
            created_at: row.created_at ?? new Date().toISOString(),
            updated_at: row.updated_at ?? new Date().toISOString(),
            learner_id: row.learner_id,
            learner_email: null,
            teacher_id: row.teacher_id,
            teacher_email: null,
            skill_name: null,
            skill_category: null,
            open_report_count: 0,
          })),
        } satisfies SessionsDashboard;
      }
      if (error) throw error;
      return (data ?? {}) as SessionsDashboard;
    },
  });
}

export function useAdminUsers(enabled: boolean, search: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_USERS_KEY(user?.id, search),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_users", {
        p_limit: 50,
        p_search: search.trim() || null,
      });
      if (error) {
        let fallbackQuery = supabase
          .from("profiles")
          .select("id, full_name, onboarded, learning_mode, created_at")
          .order("created_at", { ascending: false })
          .limit(50);

        const term = search.trim();
        if (term) {
          const uuidLike =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(term);
          fallbackQuery = uuidLike
            ? fallbackQuery.eq("id", term)
            : fallbackQuery.ilike("full_name", `%${term}%`);
        }

        const { data: fallbackData, error: fallbackError } = await fallbackQuery;
        if (fallbackError) throw error;

        return (fallbackData ?? []).map((profile) => ({
          id: profile.id,
          masked_email: null,
          masked_name: maskName(profile.full_name),
          onboarded: profile.onboarded,
          learning_mode: profile.learning_mode,
          created_at: profile.created_at,
          last_sign_in_at: null,
          suspended_at: null,
          suspended_reason: null,
          has_admin_role: false,
          session_count: 0,
          report_count: 0,
        })) as AdminUserRow[];
      }
      return (data ?? []) as AdminUserRow[];
    },
  });
}

export function useAdminComplianceDashboard(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_COMPLIANCE_DASHBOARD_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_compliance_dashboard");
      if (error) throw error;
      return (data ?? {}) as ComplianceDashboard;
    },
  });
}

export function useAdminSettingsDashboard(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_SETTINGS_DASHBOARD_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_settings_dashboard");
      if (error) throw error;
      return (data ?? {}) as SettingsDashboard;
    },
  });
}

// -----------------------------------------------------------------------------
// Phase 7 — extension hooks (suspend, skills catalog, broadcast, health, reports)
// -----------------------------------------------------------------------------

export type AdminSkillRow = {
  id: string;
  name: string;
  category: string | null;
  created_at: string;
  teaching_count: number;
  learning_count: number;
  session_count: number;
};

export type AdminReportRow = {
  id: string;
  reason: string;
  details: string | null;
  status: string;
  // Present on rows returned by `get_admin_report_queue` once the report has
  // been resolved/dismissed. Optional + null because the queue surfaces open
  // rows where this field hasn't been set yet.
  resolution?: string | null;
  created_at: string;
  reporter_id: string | null;
  reported_user_id: string | null;
  session_id: string | null;
  message_id: string | null;
  review_id: string | null;
  reporter_name: string | null;
  reported_user_name: string | null;
  message_preview: string | null;
  review_preview: string | null;
  session_skill: string | null;
};

export type AdminSystemHealth = {
  auditEvents1h?: number;
  auditEvents24h?: number;
  denials24h?: number;
  sessionsCreated24h?: number;
  messagesPosted1h?: number;
  suspendedUsers?: number;
  pendingReports?: number;
  pendingActionRequests?: number;
  auditByDomain24h?: Record<string, number>;
  generatedAt?: string;
};

export const ADMIN_SKILLS_KEY = (userId: string | null | undefined) =>
  ["admin-skills-catalog", userId] as const;

export const ADMIN_REPORTS_KEY = (userId: string | null | undefined) =>
  ["admin-reports-queue", userId] as const;

export const ADMIN_HEALTH_KEY = (userId: string | null | undefined) =>
  ["admin-system-health", userId] as const;

export function useAdminSkillsCatalog(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_SKILLS_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_skills_catalog");
      if (error) throw error;
      return (data ?? []) as AdminSkillRow[];
    },
  });
}

export function useAdminReportsQueue(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_REPORTS_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_report_queue", { p_limit: 200 });
      if (error) throw error;
      return (data ?? []) as AdminReportRow[];
    },
  });
}

export function useAdminSystemHealth(enabled: boolean) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ADMIN_HEALTH_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_system_health");
      if (error) throw error;
      return (data ?? {}) as AdminSystemHealth;
    },
  });
}

// Stable key per logical operation — deliberately NO timestamp component.
// Appending Date.now() made every retry/double-click a "new" operation,
// which defeated the server-side idempotency check entirely. Callers whose
// operation can legitimately repeat (e.g. two manual adjustments to the same
// user) pass a `nonce` minted once per dialog open: retries inside the same
// dialog reuse the key, a fresh dialog gets a fresh one.
export function buildIdempotencyKey(prefix: string, id: string, next: string, nonce?: string) {
  return nonce ? `${prefix}:${id}:${next}:${nonce}` : `${prefix}:${id}:${next}`;
}

export function newIdempotencyNonce() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
