import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ClipboardCopy,
  Coins,
  Loader2,
  RefreshCw,
  Search,
  ShieldX,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/admin-format";
import { Metric } from "@/components/admin/KpiTile";
import {
  adminErrorMessage,
  hasAdminPermission,
  useAdminPermissions,
  useAdminSessionsDashboard,
} from "@/lib/admin";

const STATUS_TABS = [
  "all",
  "pending",
  "accepted",
  "active",
  "completed",
  "cancelled",
  "rejected",
] as const;
type StatusFilter = (typeof STATUS_TABS)[number];

const SORT_OPTIONS = [
  { value: "updated", label: "Recent activity" },
  { value: "scheduled", label: "Scheduled soonest" },
  { value: "credits", label: "Highest credits" },
  { value: "reports", label: "Most reports" },
  { value: "newest", label: "Newest" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["value"];

type SessionsSearch = {
  status: StatusFilter;
  q: string;
  escrow: boolean;
  reports: boolean;
  sort: SortKey;
};

function parseSessionsSearch(input: Record<string, unknown>): SessionsSearch {
  const status =
    typeof input.status === "string" && (STATUS_TABS as readonly string[]).includes(input.status)
      ? (input.status as StatusFilter)
      : "all";
  const sortRaw = typeof input.sort === "string" ? input.sort : "updated";
  const sort = (SORT_OPTIONS.map((o) => o.value) as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : "updated";
  return {
    status,
    q: typeof input.q === "string" ? input.q : "",
    escrow: input.escrow === true || input.escrow === "1",
    reports: input.reports === true || input.reports === "1",
    sort,
  };
}

export const Route = createFileRoute("/admin/sessions")({
  head: () => ({ meta: [{ title: "Sessions - SkillSwap Admin" }] }),
  validateSearch: parseSessionsSearch,
  component: AdminSessionsPage,
});

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error(`Couldn't copy ${label.toLowerCase()}.`);
  }
}

function AdminSessionsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const permissionsQuery = useAdminPermissions();
  const permissions = permissionsQuery.data;
  const canRead = hasAdminPermission(permissions, "sessions", "read");
  const { status, q: searchTerm, escrow: onlyEscrow, reports: onlyReports, sort } = search;

  const updateSearch = (partial: Partial<SessionsSearch>) => {
    void navigate({
      to: "/admin/sessions",
      search: { ...search, ...partial },
      replace: true,
    });
  };
  const setStatus = (next: StatusFilter) => updateSearch({ status: next });
  const setSearchTerm = (next: string) => updateSearch({ q: next });
  const setOnlyEscrow = (next: boolean) => updateSearch({ escrow: next });
  const setOnlyReports = (next: boolean) => updateSearch({ reports: next });
  const setSort = (next: SortKey) => updateSearch({ sort: next });
  const resetFilters = () => updateSearch({ status: "all", q: "", escrow: false, reports: false });

  const dashboardQuery = useAdminSessionsDashboard(canRead, status);
  const dashboard = dashboardQuery.data;
  const allSessions = useMemo(() => dashboard?.recentSessions ?? [], [dashboard?.recentSessions]);
  const counts = dashboard?.statusCounts ?? {};

  type AdminSessionRow = NonNullable<typeof dashboard>["recentSessions"] extends infer R | undefined
    ? R extends Array<infer Item>
      ? Item
      : never
    : never;

  const sessions = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    const filtered = allSessions.filter((session) => {
      if (onlyEscrow && !session.escrow_held) return false;
      if (onlyReports && (session.open_report_count ?? 0) === 0) return false;
      if (needle) {
        const haystack =
          `${session.id} ${session.skill_name ?? ""} ${session.learner_email ?? ""} ${session.teacher_email ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    return filtered.slice().sort((a, b) => {
      switch (sort) {
        case "scheduled":
          return (
            new Date(a.scheduled_at ?? "9999-12-31").getTime() -
            new Date(b.scheduled_at ?? "9999-12-31").getTime()
          );
        case "credits":
          return (b.credits ?? 0) - (a.credits ?? 0);
        case "reports":
          return (b.open_report_count ?? 0) - (a.open_report_count ?? 0);
        case "newest":
          return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
        case "updated":
        default:
          return new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime();
      }
    });
  }, [allSessions, searchTerm, onlyEscrow, onlyReports, sort]);

  const [detailSession, setDetailSession] = useState<AdminSessionRow | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin/sessions" } });
    }
  }, [authLoading, navigate, user]);

  if (authLoading || permissionsQuery.isLoading) return <PageLoading variant="list-wide" />;
  if (!user) return null;

  if (!canRead) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <section className="glass rounded-2xl p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
              <ShieldX className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">No sessions access</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Session investigation requires sessions read permission.
              </p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const hasFilters = onlyEscrow || onlyReports || searchTerm.trim().length > 0 || status !== "all";

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <CalendarClock className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Session Investigation</h1>
              <p className="text-sm text-muted-foreground">
                Lifecycle counts, disputed sessions, escrow risk, and recent activity.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={dashboardQuery.isFetching}
            onClick={() => void dashboardQuery.refetch()}
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", dashboardQuery.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="Total" value={dashboard?.totalSessions} />
          <Metric label="Active" value={dashboard?.activeSessions} />
          <Metric label="Next 7d" value={dashboard?.scheduledNext7d} />
          <Metric label="Stuck escrow" value={dashboard?.stuckEscrow} />
          <Metric label="Reported" value={dashboard?.reportedSessions} />
          <Metric label="Completed" value={counts.completed ?? 0} />
        </div>

        {dashboardQuery.isError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load sessions: {adminErrorMessage(dashboardQuery.error)}
          </div>
        )}
        {!dashboardQuery.isError && dashboard?._fallback && (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-500">
            <div className="font-semibold">Fallback mode: admin sessions RPC not deployed</div>
            <p className="mt-1 text-xs">
              The numbers above only count sessions where <em>you</em> are a participant. The full
              admin dashboard (all users' sessions, escrow flags, report counts, joined emails)
              requires the <code className="font-mono">get_admin_sessions_dashboard</code> function,
              which is <code>SECURITY DEFINER</code> and bypasses the participant-only RLS on{" "}
              <code className="font-mono">public.sessions</code>.
            </p>
            <p className="mt-1 text-xs">
              Apply the migration:{" "}
              <code className="font-mono">cd skillswap-connect && supabase db push</code>
            </p>
          </div>
        )}
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-card/80 p-4">
        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_TABS.map((option) => {
              const label =
                option === "all"
                  ? `All (${dashboard?.totalSessions ?? 0})`
                  : `${option}${counts[option] !== undefined ? ` (${counts[option]})` : ""}`;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setStatus(option)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs capitalize transition-colors",
                    status === option
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="pl-9"
                placeholder="Search id, skill, or email"
              />
            </div>
            <button
              type="button"
              onClick={() => setOnlyEscrow(!onlyEscrow)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
                onlyEscrow
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Coins className="h-3 w-3" />
              Escrow held
            </button>
            <button
              type="button"
              onClick={() => setOnlyReports(!onlyReports)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
                onlyReports
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <TriangleAlert className="h-3 w-3" />
              Has reports
            </button>
            <div className="ml-auto w-44">
              <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                <SelectTrigger aria-label="Sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {sessions.length}
            {hasFilters ? ` of ${allSessions.length} loaded` : ""} (status query caps at 75 rows)
          </span>
          <div className="flex items-center gap-2">
            {dashboardQuery.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
            {hasFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-foreground hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        <Table className="table-stack-mobile">
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Participants</TableHead>
              <TableHead>Credits</TableHead>
              <TableHead>Scheduled</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow
                key={session.id}
                onClick={() => setDetailSession(session)}
                className="cursor-pointer hover:bg-muted/30"
              >
                <TableCell data-label="Session">
                  <div className="space-y-1 text-right md:text-left">
                    <div className="font-medium break-anywhere">
                      {session.skill_name ?? "Unknown skill"}
                    </div>
                    <div className="text-xs text-muted-foreground break-anywhere">{session.id}</div>
                    <Badge variant="outline" className="capitalize">
                      {session.status}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell data-label="Participants">
                  <div className="space-y-1 text-sm text-right md:text-left break-anywhere">
                    <div>Learner: {session.learner_email ?? session.learner_id ?? "-"}</div>
                    <div>Teacher: {session.teacher_email ?? session.teacher_id ?? "-"}</div>
                  </div>
                </TableCell>
                <TableCell data-label="Credits">
                  <div className="text-right md:text-left">
                    <div>{session.credits}</div>
                    <div className="text-xs text-muted-foreground">
                      {session.duration_minutes} minutes
                    </div>
                  </div>
                </TableCell>
                <TableCell data-label="Scheduled">
                  <div className="text-right md:text-left">
                    <div className="text-sm">{formatDate(session.scheduled_at)}</div>
                    {session.updated_at && (
                      <div className="text-[11px] text-muted-foreground">
                        Updated {formatDate(session.updated_at)}
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell data-label="Risk">
                  <div className="flex flex-wrap gap-2 justify-end md:justify-start">
                    {session.escrow_held && (
                      <Badge variant="secondary" className="gap-1">
                        <Coins className="h-3 w-3" /> escrow
                      </Badge>
                    )}
                    {session.open_report_count > 0 && (
                      <Badge variant="destructive" className="gap-1">
                        <TriangleAlert className="h-3 w-3" /> {session.open_report_count}
                      </Badge>
                    )}
                    {!session.escrow_held && session.open_report_count === 0 && (
                      <span className="text-xs text-muted-foreground">N/A</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Copy session id"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyToClipboard(session.id, "Session id");
                    }}
                  >
                    <ClipboardCopy className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!dashboardQuery.isError &&
          sessions.length === 0 &&
          (hasFilters ? (
            <EmptyState
              title="No sessions match the current filters"
              description="Try a different status tab, clear the escrow/reports toggles, or adjust the search."
              action={
                <Button size="sm" variant="ghost" onClick={resetFilters}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={CalendarClock}
              title="No sessions yet"
              description="Once students request and accept skill exchanges, they'll appear here for investigation."
            />
          ))}
      </section>

      <Dialog
        open={Boolean(detailSession)}
        onOpenChange={(open) => !open && setDetailSession(null)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Session detail</DialogTitle>
            <DialogDescription>
              Investigation surface. Use the audit log to trace privileged actions on this session.
            </DialogDescription>
          </DialogHeader>
          {detailSession && (
            <div className="space-y-3 text-sm">
              <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Session id
                    </div>
                    <div className="mt-1 break-all font-mono text-xs">{detailSession.id}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyToClipboard(detailSession.id, "Session id")}
                  >
                    <ClipboardCopy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailField label="Skill" value={detailSession.skill_name ?? "N/A"} />
                <DetailField label="Category" value={detailSession.skill_category ?? "N/A"} />
                <DetailField label="Status" value={detailSession.status} />
                <DetailField label="Credits" value={String(detailSession.credits)} />
                <DetailField label="Duration" value={`${detailSession.duration_minutes} min`} />
                <DetailField
                  label="Escrow"
                  value={detailSession.escrow_held ? "held" : "released"}
                />
                <DetailField label="Scheduled" value={formatDate(detailSession.scheduled_at)} />
                <DetailField label="Created" value={formatDate(detailSession.created_at)} />
                <DetailField label="Updated" value={formatDate(detailSession.updated_at)} />
                <DetailField label="Open reports" value={String(detailSession.open_report_count)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailField
                  label="Learner"
                  value={detailSession.learner_email ?? detailSession.learner_id ?? "N/A"}
                />
                <DetailField
                  label="Teacher"
                  value={detailSession.teacher_email ?? detailSession.teacher_id ?? "N/A"}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setDetailSession(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all font-medium">{value}</div>
    </div>
  );
}
