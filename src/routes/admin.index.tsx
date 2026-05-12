import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Coins,
  FileSearch,
  FileText,
  Flame,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  Users,
} from "lucide-react";
import type { ElementType, ReactNode } from "react";

const AdminCharts = lazy(() =>
  import("@/components/admin/AdminCharts.lazy").then((m) => ({ default: m.AdminCharts })),
);
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { KpiTile } from "@/components/admin/KpiTile";
import { formatDate, metricValue } from "@/lib/admin-format";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import {
  adminErrorMessage,
  useAdminPermissions,
  useAdminSnapshot,
  type AdminPermission,
} from "@/lib/admin";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Admin Control Center - SkillSwap" }] }),
  component: AdminHomePage,
});

// Hex values pulled from site palette in src/styles.css so charts render
// reliably across SVG fill and stay readable on light + dark themes.
const BRAND = {
  purple: "#7c3aed",
  cyan: "#10b981",
  blue: "#3b82f6",
  yellow: "#f59e0b",
  red: "#ef4444",
  slate: "#94a3b8",
} as const;

const SESSION_STATUS_COLORS: Record<string, string> = {
  pending: BRAND.yellow,
  accepted: BRAND.blue,
  active: BRAND.purple,
  completed: BRAND.cyan,
  cancelled: BRAND.red,
  rejected: BRAND.slate,
};

const REPORT_STATUS_COLORS: Record<string, string> = {
  open: BRAND.yellow,
  reviewing: BRAND.blue,
  resolved: BRAND.cyan,
  dismissed: BRAND.slate,
};

function uniqueRoleSummary(permissions: AdminPermission[]) {
  const roles = Array.from(new Set(permissions.map((p) => p.role_slug))).sort();
  if (roles.length === 0) return "No active role";
  if (roles.length === 1) return roles[0].replaceAll("_", " ");
  return `${roles.length} active roles`;
}

function AdminHomePage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const permissionsQuery = useAdminPermissions();
  const permissions = useMemo(() => permissionsQuery.data ?? [], [permissionsQuery.data]);
  const isAdmin = permissions.length > 0;
  const snapshotQuery = useAdminSnapshot(isAdmin);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin" } });
    }
  }, [authLoading, navigate, user]);

  // Recharts' ResponsiveContainer measures the DOM and produces different
  // markup on SSR vs client; delay rendering until after mount to avoid the
  // hydration mismatch and to keep the SSR route bundle slim.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => setChartsReady(true), []);

  const snapshot = snapshotQuery.data;

  const reportCounts = useMemo(() => snapshot?.reports ?? {}, [snapshot?.reports]);
  const sessionCounts = useMemo(() => snapshot?.sessions ?? {}, [snapshot?.sessions]);
  const openReports = (reportCounts.open ?? 0) + (reportCounts.reviewing ?? 0);
  const activeSessions = (sessionCounts.accepted ?? 0) + (sessionCounts.active ?? 0);

  const sessionChartData = useMemo(
    () =>
      Object.entries(sessionCounts)
        .filter(([, count]) => typeof count === "number" && count > 0)
        .map(([status, count]) => ({
          name: status,
          value: count as number,
          fill: SESSION_STATUS_COLORS[status] ?? "hsl(215 16% 47%)",
        })),
    [sessionCounts],
  );

  const reportChartData = useMemo(
    () =>
      ["open", "reviewing", "resolved", "dismissed"]
        .map((status) => ({
          name: status,
          value: (reportCounts[status] ?? 0) as number,
          fill: REPORT_STATUS_COLORS[status] ?? "hsl(215 16% 47%)",
        }))
        .filter((entry) => entry.value > 0),
    [reportCounts],
  );

  if (authLoading || permissionsQuery.isLoading) {
    return <PageLoading variant="dashboard" />;
  }

  if (!user) return null;

  if (!isAdmin) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <section className="glass rounded-2xl p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
              <ShieldX className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">No admin access</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your account has no active privileged role assignment. Access requests must be
                approved through the governance workflow.
              </p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <section className="glass rounded-[2rem] p-5 shadow-card sm:p-6">
        <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-center">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Admin Control Center
              </h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">
                Server-enforced RBAC, SoD-ready workflows, and audit evidence.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/45 p-2 pl-3 md:justify-end">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-emerald-300"
              >
                {uniqueRoleSummary(permissions)}
              </Badge>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Updated {formatDate(snapshot?.generatedAt)}
              </span>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full bg-background/60"
              disabled={snapshotQuery.isFetching}
              onClick={() => {
                void snapshotQuery.refetch();
              }}
              title="Refresh"
            >
              <RefreshCw
                className={snapshotQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />
            </Button>
          </div>
        </div>
        {snapshotQuery.isError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load admin data: {adminErrorMessage(snapshotQuery.error)}
          </div>
        )}
      </section>

      <section className="mt-5 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiTile icon={Users} label="Users" value={snapshot?.users?.total} hint="onboarded" />
        <KpiTile icon={Activity} label="Active sessions" value={activeSessions} hint="now" />
        <KpiTile icon={FileText} label="Open reports" value={openReports} hint="needs review" />
        <KpiTile
          icon={KeyRound}
          label="Pending approvals"
          value={snapshot?.pendingActionRequests}
          hint="maker-checker"
          tone={(snapshot?.pendingActionRequests ?? 0) > 0 ? "warn" : "default"}
        />
        <KpiTile
          icon={Flame}
          label="Break-glass"
          value={snapshot?.breakGlassActive}
          hint="active grants"
          tone={(snapshot?.breakGlassActive ?? 0) > 0 ? "danger" : "default"}
        />
        <KpiTile
          icon={FileSearch}
          label="Audit events 24h"
          value={snapshot?.auditEvents24h}
          hint="privileged"
        />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <DashboardCard
          title="Session Lifecycle"
          icon={Activity}
          actionLabel="Open Sessions"
          actionHref="/admin/sessions"
        >
          {sessionChartData.length === 0 ? (
            <EmptyChart label="No active sessions yet." />
          ) : !chartsReady ? (
            <ChartSkeleton variant="pie" />
          ) : (
            // ErrorBoundary catches dynamic-import chunk-load failures (stale
            // deploy, network blip during the lazy() import) so the surrounding
            // admin dashboard stays usable instead of blanking on a thrown
            // ChunkLoadError. Falls back to the same EmptyChart placeholder.
            <ErrorBoundary
              label="AdminCharts:session"
              fallback={<EmptyChart label="Charts failed to load. Refresh the page." />}
            >
              <Suspense fallback={<ChartSkeleton variant="pie" />}>
                <AdminCharts slot="session" data={sessionChartData} />
              </Suspense>
            </ErrorBoundary>
          )}
        </DashboardCard>

        <DashboardCard
          title="Report Queue"
          icon={FileText}
          actionLabel="Open Reports"
          actionHref="/admin/reports"
        >
          {reportChartData.length === 0 ? (
            <EmptyChart label="No reports in the queue." />
          ) : !chartsReady ? (
            <ChartSkeleton variant="bar" />
          ) : (
            <ErrorBoundary
              label="AdminCharts:report"
              fallback={<EmptyChart label="Charts failed to load. Refresh the page." />}
            >
              <Suspense fallback={<ChartSkeleton variant="bar" />}>
                <AdminCharts slot="report" data={reportChartData} />
              </Suspense>
            </ErrorBoundary>
          )}
        </DashboardCard>
      </section>

      <section className="mt-4">
        <article className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4 text-amber-300" /> Attention required
            </h2>
          </div>
          <ul className="space-y-2 text-sm">
            <AttentionRow
              icon={Coins}
              label="Negative wallet balances"
              value={snapshot?.ledger?.negativeBalances}
              to="/admin/finance"
            />
            <AttentionRow
              icon={TrendingUp}
              label="Credits moved 24h"
              value={snapshot?.ledger?.creditsMoved24h}
              to="/admin/finance"
              neutral
            />
          </ul>
        </article>
      </section>
    </main>
  );
}

function DashboardCard({
  title,
  icon: Icon,
  actionLabel,
  actionHref,
  children,
}: {
  title: string;
  icon: ElementType;
  actionLabel?: string;
  actionHref?:
    | "/admin"
    | "/admin/users"
    | "/admin/sessions"
    | "/admin/finance"
    | "/admin/reports"
    | "/admin/skills";
  children: ReactNode;
}) {
  return (
    <article className="glass rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Icon className="h-4 w-4" /> {title}
        </h2>
        {actionHref && actionLabel && (
          <Button asChild variant="ghost" size="sm">
            <Link to={actionHref}>
              {actionLabel} <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        )}
      </div>
      {children}
    </article>
  );
}

function ChartSkeleton({ variant }: { variant: "pie" | "bar"; height?: "h-60" | "h-56" }) {
  // Chart-shaped placeholder so swapping in the real chart doesn't cause a
  // visual flash at the empty-state → loaded transition.
  return (
    <div className="h-60 rounded-xl bg-muted/40 animate-pulse p-4">
      {variant === "pie" ? (
        <div className="flex h-full items-center justify-center">
          <div className="h-28 w-28 rounded-full bg-muted/60" />
        </div>
      ) : (
        <div className="flex h-full flex-col justify-end gap-2 pb-4">
          <div className="h-3 w-3/4 rounded bg-muted/60" />
          <div className="h-3 w-1/2 rounded bg-muted/60" />
          <div className="h-3 w-2/3 rounded bg-muted/60" />
        </div>
      )}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function AttentionRow({
  icon: Icon,
  label,
  value,
  to,
  tone = "default",
  neutral = false,
}: {
  icon: ElementType;
  label: string;
  value: unknown;
  to:
    | "/admin"
    | "/admin/users"
    | "/admin/sessions"
    | "/admin/finance"
    | "/admin/reports"
    | "/admin/skills";
  tone?: "default" | "danger";
  neutral?: boolean;
}) {
  const numeric = typeof value === "number" ? value : 0;
  const isActive = !neutral && numeric > 0;
  return (
    <li>
      <Link
        to={to}
        className={cn(
          "group flex items-center justify-between gap-3 rounded-xl border border-transparent px-3 py-2 transition-colors hover:border-border/70 hover:bg-background/40",
        )}
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon
            className={cn(
              "h-4 w-4",
              isActive && tone === "danger" && "text-destructive",
              isActive && tone !== "danger" && "text-amber-400",
            )}
          />
          {label}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-semibold",
            !isActive && "bg-muted/60 text-muted-foreground",
            isActive && tone === "danger" && "bg-destructive/15 text-destructive",
            isActive && tone !== "danger" && "bg-amber-500/15 text-amber-300",
          )}
        >
          {metricValue(value)}
        </span>
      </Link>
    </li>
  );
}
