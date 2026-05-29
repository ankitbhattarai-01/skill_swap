import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Coins,
  Download,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  ShieldX,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReasonFields } from "@/components/admin/ReasonFields";
import { formatDate, metricValue } from "@/lib/admin-format";
import { Metric } from "@/components/admin/KpiTile";
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
import { PageLoading } from "@/components/PageLoading";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { hasAuthRedirectParams } from "@/lib/auth-redirect";
import { cn } from "@/lib/utils";
import {
  ADMIN_FINANCE_DASHBOARD_KEY,
  adminErrorMessage,
  buildIdempotencyKey,
  hasAdminPermission,
  useAdminFinanceDashboard,
  useAdminPermissions,
} from "@/lib/admin";

export const Route = createFileRoute("/admin/finance")({
  head: () => ({ meta: [{ title: "Finance - SkillSwap Admin" }] }),
  // Sub-role boundary: even an admin with other domains needs `wallet:read`
  // before the finance dashboard mounts. Component-level checks (canRead,
  // canOverride, etc.) still gate every dangerous action — this just stops
  // an unauthorized admin from seeing the page chrome and loading the
  // finance queries at all. SSR-safe: skip on server where the Supabase
  // session lives in localStorage.
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    if (hasAuthRedirectParams()) return;

    const { data, error } = await supabase.rpc("get_my_admin_permissions");
    if (error) throw redirect({ to: "/dashboard" });

    const canReadWallet = (data ?? []).some(
      (permission) => permission.domain === "wallet" && permission.action === "read",
    );
    if (!canReadWallet) throw redirect({ to: "/dashboard" });
  },
  component: AdminFinancePage,
});

function payloadText(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "-";
}

// Convert a Date to the local-time string that <input type="datetime-local">
// expects: "YYYY-MM-DDTHH:mm" — the wire format the browser produces in
// `event.target.value`, with no timezone suffix. Building it manually so we
// don't lose minutes to a Date#toISOString() round-trip through UTC.
function toLocalDateTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Inverse of the above: parse the input value back into a full ISO string the
// RPC accepts. Returns null on invalid input so the caller can refuse instead
// of sending a garbage timestamp to the audit chain.
function toIsoFromLocal(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function AdminFinancePage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissionsQuery = useAdminPermissions();
  const permissions = permissionsQuery.data;
  const canRead = hasAdminPermission(permissions, "wallet", "read");
  const canOverride = hasAdminPermission(permissions, "wallet", "override");
  const canApprove = hasAdminPermission(permissions, "wallet", "approve");
  const canExport = hasAdminPermission(permissions, "wallet", "export");
  const dashboardQuery = useAdminFinanceDashboard(canRead);
  const dashboard = dashboardQuery.data;
  const requests = useMemo(() => dashboard?.requests ?? [], [dashboard?.requests]);
  const negativeBalances = dashboard?.negativeBalanceRows ?? [];
  const stuckEscrow = dashboard?.stuckEscrowRows ?? [];
  const reconciliations = dashboard?.recentReconciliations ?? [];

  const [requestOpen, setRequestOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileRef, setReconcileRef] = useState("");
  const [decision, setDecision] = useState<{ id: string; action: "approve" | "reject" } | null>(
    null,
  );
  const [manifestOpen, setManifestOpen] = useState(false);
  const [actionType, setActionType] = useState("manual_adjustment");
  const [targetUserId, setTargetUserId] = useState("");
  const [amount, setAmount] = useState("1");
  const [sessionId, setSessionId] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [justification, setJustification] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "pending" | "approved" | "rejected" | "executed" | "all"
  >("pending");
  const [searchTerm, setSearchTerm] = useState("");
  type FinanceRequestRow = (typeof requests)[number];
  const [detailRequest, setDetailRequest] = useState<FinanceRequestRow | null>(null);
  // Stored as the `datetime-local` string form ("YYYY-MM-DDTHH:mm") so the
  // controlled <Input type="datetime-local"> stays in sync. The RPC is fed
  // the full ISO string in `createManifest()` via `toIsoFromLocal`.
  const [from, setFrom] = useState(() =>
    toLocalDateTimeString(new Date(Date.now() - 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = useState(() => toLocalDateTimeString(new Date()));
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedDecisionRequest = requests.find((request) => request.id === decision?.id);
  const selectedDecisionReason =
    payloadText(selectedDecisionRequest?.payload, "action_type") === "manual_adjustment"
      ? "wallet:manual_adjustment"
      : "wallet:escrow_intervention";

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin/finance" } });
    }
  }, [authLoading, navigate, user]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ADMIN_FINANCE_DASHBOARD_KEY(user?.id) });
  };

  const resetReason = () => {
    setTicketRef("");
    setJustification("");
  };

  const closeRequest = () => {
    setRequestOpen(false);
    setTargetUserId("");
    setSessionId("");
    setAmount("1");
    setActionType("manual_adjustment");
    resetReason();
  };

  const closeDecision = () => {
    setDecision(null);
    resetReason();
  };

  const closeManifest = () => {
    setManifestOpen(false);
    setManifest(null);
    resetReason();
  };

  const filteredRequests = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return requests.filter((request) => {
      if (statusFilter !== "all" && request.status !== statusFilter) return false;
      if (needle) {
        const action = payloadText(request.payload, "action_type");
        const target =
          payloadText(request.payload, "target_user_id") !== "-"
            ? payloadText(request.payload, "target_user_id")
            : payloadText(request.payload, "session_id");
        const haystack =
          `${request.maker_email ?? ""} ${request.ticket_ref ?? ""} ${action} ${target}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [requests, statusFilter, searchTerm]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, executed: 0 };
    for (const request of requests) {
      counts[request.status] = (counts[request.status] ?? 0) + 1;
    }
    return counts;
  }, [requests]);

  const prefillAdjustForUser = (userId: string) => {
    setActionType("manual_adjustment");
    setTargetUserId(userId);
    setAmount("1");
    setSessionId("");
    resetReason();
    setRequestOpen(true);
  };

  const prefillEscrowForSession = (sid: string, kind: "escrow_refund" | "escrow_release") => {
    setActionType(kind);
    setSessionId(sid);
    setTargetUserId("");
    resetReason();
    setRequestOpen(true);
  };

  const submitRequest = async () => {
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    const parsedAmount = Number(amount);
    if (
      actionType === "manual_adjustment" &&
      (!targetUserId || !Number.isFinite(parsedAmount) || parsedAmount === 0)
    ) {
      toast.error("Manual adjustment needs target user id and non-zero amount.");
      return;
    }
    if (actionType !== "manual_adjustment" && !sessionId) {
      toast.error("Escrow intervention needs a session id.");
      return;
    }

    // try/finally so a network throw (offline, fetch abort) can't strand the
    // dialog's Submit button in its disabled state.
    setBusy(true);
    try {
      const { error } = await supabase.rpc("request_finance_action", {
        p_action_type: actionType,
        p_target_user_id: actionType === "manual_adjustment" ? targetUserId : null,
        p_amount: actionType === "manual_adjustment" ? parsedAmount : null,
        p_session_id: actionType === "manual_adjustment" ? null : sessionId,
        p_reason_code:
          actionType === "manual_adjustment"
            ? "wallet:manual_adjustment"
            : "wallet:escrow_intervention",
        p_justification: justification.trim(),
        p_ticket_ref: ticketRef.trim(),
        p_idempotency_key: buildIdempotencyKey("finance", targetUserId || sessionId, actionType),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Finance request submitted for approval.");
      closeRequest();
      // Fire-and-forget: the dashboard refetch shouldn't block the dialog's
      // busy spinner from clearing — the RPC has already succeeded.
      void invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit finance request.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async () => {
    if (!decision) return;
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    setBusy(true);
    try {
      const call =
        decision.action === "approve"
          ? supabase.rpc("approve_finance_action", {
              p_request_id: decision.id,
              p_reason_code: selectedDecisionReason,
              p_justification: justification.trim(),
              p_ticket_ref: ticketRef.trim(),
            })
          : supabase.rpc("reject_finance_action", {
              p_request_id: decision.id,
              p_reason_code: selectedDecisionReason,
              p_justification: justification.trim(),
              p_ticket_ref: ticketRef.trim(),
            });
      const { error } = await call;
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(
        decision.action === "approve" ? "Finance action approved." : "Finance action rejected.",
      );
      closeDecision();
      void invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record decision.");
    } finally {
      setBusy(false);
    }
  };

  const closeReconcile = () => {
    setReconcileOpen(false);
    setReconcileRef("");
  };

  const runReconciliation = async () => {
    const reference = reconcileRef.trim();
    if (reference.length < 3) {
      toast.error("Ticket reference is required (3+ characters).");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("run_finance_reconciliation", {
        p_reason_code: "wallet:reconciliation",
        p_justification: "Manual finance reconciliation review from admin dashboard.",
        p_ticket_ref: reference,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Reconciliation completed.");
      closeReconcile();
      void invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  const createManifest = async () => {
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    const fromIso = toIsoFromLocal(from);
    const toIso = toIsoFromLocal(to);
    if (!fromIso || !toIso) {
      toast.error("Pick valid From and To dates.");
      return;
    }
    if (new Date(fromIso) > new Date(toIso)) {
      toast.error("'From' must be before 'To'.");
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("create_finance_report_manifest", {
        p_from: fromIso,
        p_to: toIso,
        p_reason_code: "wallet:report_export",
        p_justification: justification.trim(),
        p_ticket_ref: ticketRef.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      setManifest((data ?? {}) as Record<string, unknown>);
      toast.success("Finance report manifest generated.");
      void invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate manifest.");
    } finally {
      setBusy(false);
    }
  };

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
              <h1 className="text-xl font-semibold">No finance access</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Finance controls require wallet read permission.
              </p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Coins className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Finance Controls</h1>
              <p className="text-sm text-muted-foreground">
                Maker-checker wallet overrides, escrow interventions, and reconciliation.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={dashboardQuery.isFetching}
              onClick={() => void dashboardQuery.refetch()}
              title="Refresh dashboard"
            >
              <RefreshCw
                className={dashboardQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />
              Refresh
            </Button>
            <Button variant="outline" disabled={!canRead} onClick={() => setReconcileOpen(true)}>
              <RefreshCw className="h-4 w-4" /> Reconcile
            </Button>
            <Button variant="outline" disabled={!canExport} onClick={() => setManifestOpen(true)}>
              <Download className="h-4 w-4" /> Report manifest
            </Button>
            <Button disabled={!canOverride} onClick={() => setRequestOpen(true)}>
              Request action
            </Button>
          </div>
        </div>

        {dashboardQuery.isError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load finance dashboard: {adminErrorMessage(dashboardQuery.error)}
          </div>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="Pending" value={dashboard?.pendingFinanceRequests} />
          <Metric label="Negative balances" value={dashboard?.negativeBalances} />
          <Metric label="Stuck escrow" value={dashboard?.stuckEscrow} />
          <Metric label="Velocity flags" value={dashboard?.unusualVelocity24h} />
          <Metric label="Ledger 24h" value={dashboard?.ledgerEntries24h} />
          <Metric label="Credits 24h" value={dashboard?.creditsMoved24h} />
        </div>
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <article className="rounded-2xl border border-border/70 bg-card/80 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-semibold">Finance Requests</h2>
            {dashboardQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          </div>

          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="pl-9"
                placeholder="Search maker email, ticket, target id"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
            >
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending ({statusCounts.pending ?? 0})</SelectItem>
                <SelectItem value="approved">Approved ({statusCounts.approved ?? 0})</SelectItem>
                <SelectItem value="executed">Executed ({statusCounts.executed ?? 0})</SelectItem>
                <SelectItem value="rejected">Rejected ({statusCounts.rejected ?? 0})</SelectItem>
                <SelectItem value="all">All ({requests.length})</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {requests.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No finance requests.
            </div>
          ) : filteredRequests.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No requests match the current filters.
            </div>
          ) : (
            <Table className="table-stack-mobile">
              <TableHeader>
                <TableRow>
                  <TableHead>Maker</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ticket</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRequests.map((request) => (
                  <TableRow
                    key={request.id}
                    onClick={() => setDetailRequest(request)}
                    className="cursor-pointer hover:bg-muted/30"
                  >
                    <TableCell
                      data-label="Maker"
                      className="md:max-w-[180px] md:truncate break-anywhere"
                    >
                      {request.maker_email ?? request.maker_id ?? "Deleted admin"}
                    </TableCell>
                    <TableCell data-label="Action">
                      <div className="space-y-1 text-right md:text-left">
                        <div>{payloadText(request.payload, "action_type")}</div>
                        <div className="text-xs text-muted-foreground break-anywhere">
                          {payloadText(request.payload, "target_user_id") !== "-"
                            ? payloadText(request.payload, "target_user_id")
                            : payloadText(request.payload, "session_id")}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell data-label="Status">
                      <Badge
                        variant={
                          request.status === "pending"
                            ? "outline"
                            : request.status === "rejected"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {request.status}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Ticket">{request.ticket_ref ?? "-"}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          title="View detail"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDetailRequest(request);
                          }}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            !canApprove ||
                            request.status !== "pending" ||
                            !request.maker_id ||
                            request.maker_id === user.id
                          }
                          title={
                            !request.maker_id
                              ? "Maker account was deleted"
                              : request.maker_id === user.id
                                ? "Cannot approve your own request"
                                : "Approve"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            setDecision({ id: request.id, action: "approve" });
                            resetReason();
                          }}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !canApprove ||
                            request.status !== "pending" ||
                            !request.maker_id ||
                            request.maker_id === user.id
                          }
                          title="Reject"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDecision({ id: request.id, action: "reject" });
                            resetReason();
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {requests.length > 0 && (
            <div className="mt-3 text-xs text-muted-foreground">
              Showing {filteredRequests.length} of {requests.length} requests
            </div>
          )}
        </article>

        <div className="space-y-4">
          <AnomalyTable
            title="Negative Balances"
            rows={negativeBalances}
            kind="negative"
            canAct={canOverride}
            onAdjust={prefillAdjustForUser}
          />
          <AnomalyTable
            title="Stuck Escrow"
            rows={stuckEscrow}
            kind="escrow"
            canAct={canOverride}
            onEscrowAction={prefillEscrowForSession}
          />
          <article className="rounded-2xl border border-border/70 bg-card/80 p-4">
            <h2 className="mb-3 font-semibold">Recent Reconciliations</h2>
            {reconciliations.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No runs yet.</div>
            ) : (
              <div className="space-y-2">
                {reconciliations.map((run) => (
                  <div key={run.id} className="rounded-xl border border-border/60 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>{formatDate(run.started_at)}</span>
                      <Badge
                        variant={
                          run.status === "completed"
                            ? "secondary"
                            : run.status === "failed"
                              ? "destructive"
                              : "outline"
                        }
                        className={cn(
                          run.status === "completed" &&
                            "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
                        )}
                      >
                        {run.status}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Negative {run.negative_balance_count} / Escrow {run.stuck_escrow_count} /
                      Velocity {run.unusual_velocity_count}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>

      <Dialog
        open={requestOpen}
        onOpenChange={(open) => (open ? setRequestOpen(true) : closeRequest())}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request finance action</DialogTitle>
            <DialogDescription>Finance overrides require a separate approver.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Action type</Label>
              <Select value={actionType} onValueChange={setActionType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual_adjustment">manual_adjustment</SelectItem>
                  <SelectItem value="escrow_refund">escrow_refund</SelectItem>
                  <SelectItem value="escrow_release">escrow_release</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {actionType === "manual_adjustment" ? (
              <>
                <div className="space-y-2">
                  <Label>Target user id</Label>
                  <Input value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Amount change</Label>
                  <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>Session id</Label>
                <Input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
              </div>
            )}
            <ReasonFields
              ticketRef={ticketRef}
              justification={justification}
              onTicketRefChange={setTicketRef}
              onJustificationChange={setJustification}
              ticketPlaceholder="FIN- or INC- reference"
              justificationPlaceholder="Finance reason, evidence, and approval context."
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeRequest}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void submitRequest()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(detailRequest)}
        onOpenChange={(open) => !open && setDetailRequest(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Finance request</DialogTitle>
            <DialogDescription>
              Maker-checker payload. Every state change is written to the audit chain.
            </DialogDescription>
          </DialogHeader>
          {detailRequest && (
            <div className="space-y-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailField label="Status" value={detailRequest.status} />
                <DetailField
                  label="Action"
                  value={payloadText(detailRequest.payload, "action_type")}
                />
                <DetailField
                  label="Maker"
                  value={detailRequest.maker_email ?? detailRequest.maker_id ?? "Deleted admin"}
                />
                <DetailField
                  label="Checker"
                  value={detailRequest.checker_email ?? detailRequest.checker_id ?? "N/A"}
                />
                <DetailField label="Reason code" value={detailRequest.reason_code} />
                <DetailField label="Ticket" value={detailRequest.ticket_ref ?? "N/A"} />
                <DetailField label="Created" value={formatDate(detailRequest.created_at)} />
                <DetailField label="Decided" value={formatDate(detailRequest.decided_at)} />
                <DetailField label="Executed" value={formatDate(detailRequest.executed_at)} />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Justification
                </div>
                <p className="mt-1 whitespace-pre-wrap rounded-xl border border-border/60 bg-background/40 p-3 text-sm">
                  {detailRequest.justification}
                </p>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Request details
                </div>
                <div className="mt-1 grid gap-3 sm:grid-cols-2">
                  {payloadText(detailRequest.payload, "action_type") === "manual_adjustment" ? (
                    <>
                      <DetailField
                        label="Target user"
                        value={payloadText(detailRequest.payload, "target_user_id")}
                      />
                      <DetailField
                        label="Credit change"
                        value={formatCreditDelta(detailRequest.payload?.amount)}
                      />
                    </>
                  ) : (
                    <DetailField
                      label="Session"
                      value={payloadText(detailRequest.payload, "session_id")}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailRequest(null)}>
              Close
            </Button>
            {detailRequest &&
              detailRequest.status === "pending" &&
              detailRequest.maker_id &&
              detailRequest.maker_id !== user.id &&
              canApprove && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const id = detailRequest.id;
                      setDetailRequest(null);
                      setDecision({ id, action: "reject" });
                      resetReason();
                    }}
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </Button>
                  <Button
                    onClick={() => {
                      const id = detailRequest.id;
                      setDetailRequest(null);
                      setDecision({ id, action: "approve" });
                      resetReason();
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4" /> Approve
                  </Button>
                </>
              )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(decision)} onOpenChange={(open) => !open && closeDecision()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.action === "approve" ? "Approve finance action" : "Reject finance action"}
            </DialogTitle>
            <DialogDescription>
              This decision is audited and cannot be made by the maker.
            </DialogDescription>
          </DialogHeader>
          <ReasonFields
            ticketRef={ticketRef}
            justification={justification}
            onTicketRefChange={setTicketRef}
            onJustificationChange={setJustification}
            ticketPlaceholder="FIN- or INC- reference"
            justificationPlaceholder="Finance reason, evidence, and approval context."
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeDecision}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void decide()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reconcileOpen}
        onOpenChange={(open) => (open ? setReconcileOpen(true) : closeReconcile())}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run finance reconciliation</DialogTitle>
            <DialogDescription>
              Recomputes negative balances, stuck escrow, and unusual velocity. The run and its
              ticket reference are recorded in the audit chain.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reconcile-ticket">Ticket reference</Label>
            <Input
              id="reconcile-ticket"
              value={reconcileRef}
              onChange={(event) => setReconcileRef(event.target.value)}
              placeholder="FIN-, RECON-, or INC- reference"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeReconcile}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void runReconciliation()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Run reconciliation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={manifestOpen}
        onOpenChange={(open) => (open ? setManifestOpen(true) : closeManifest())}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Finance report manifest</DialogTitle>
            <DialogDescription>
              Generate integrity evidence for a finance report pack.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>From</Label>
                <Input
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  max={to || undefined}
                />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  min={from || undefined}
                />
              </div>
            </div>
            <ReasonFields
              ticketRef={ticketRef}
              justification={justification}
              onTicketRefChange={setTicketRef}
              onJustificationChange={setJustification}
              ticketPlaceholder="FIN- or INC- reference"
              justificationPlaceholder="Finance reason, evidence, and approval context."
            />
            {manifest && <ManifestSummary manifest={manifest} />}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeManifest}>
              Close
            </Button>
            <Button disabled={busy || !canExport} onClick={() => void createManifest()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

// Render a credit amount as a signed, human-readable string ("+5 credits").
// Falls back to "-" for anything that isn't a finite number so a malformed
// payload never prints "NaN credits" in the admin UI.
function formatCreditDelta(value: unknown): string {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return "-";
  const sign = amount > 0 ? "+" : "";
  const unit = Math.abs(amount) === 1 ? "credit" : "credits";
  return `${sign}${amount.toLocaleString()} ${unit}`;
}

// The report manifest RPC returns a small JSONB object (range, counts, and a
// SHA-256 integrity hash). Rather than dump raw JSON at the admin, present it
// as labeled fields with the hash called out for copy/verify.
function ManifestSummary({ manifest }: { manifest: Record<string, unknown> }) {
  const hash = typeof manifest.manifestHash === "string" ? manifest.manifestHash : "";
  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailField label="From" value={formatDate(manifest.from as string)} />
        <DetailField label="To" value={formatDate(manifest.to as string)} />
        <DetailField label="Transactions" value={metricValue(manifest.transactionCount)} />
        <DetailField label="Credits moved" value={metricValue(manifest.creditsMoved)} />
        <DetailField label="Generated" value={formatDate(manifest.generatedAt as string)} />
      </div>
      {hash && (
        <div className="rounded-xl border border-border/60 bg-background/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Integrity hash (SHA-256)
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(hash)
                  .then(() => toast.success("Hash copied."))
                  .catch(() => toast.error("Could not copy hash."));
              }}
            >
              Copy
            </Button>
          </div>
          <div className="mt-1 break-all font-mono text-xs">{hash}</div>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all text-sm font-medium">{value}</div>
    </div>
  );
}

function AnomalyTable({
  title,
  rows,
  kind,
  canAct,
  onAdjust,
  onEscrowAction,
}: {
  title: string;
  rows: Record<string, unknown>[];
  kind: "negative" | "escrow";
  canAct: boolean;
  onAdjust?: (userId: string) => void;
  onEscrowAction?: (sessionId: string, kind: "escrow_refund" | "escrow_release") => void;
}) {
  return (
    <article className="rounded-2xl border border-border/70 bg-card/80 p-4">
      <div className="mb-3 flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 text-amber-400" />
        <h2 className="font-semibold">{title}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length === 0 ? "" : `${Math.min(rows.length, 5)} of ${rows.length}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No anomalies.</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 5).map((row, index) => {
            const userId = String(row.user_id ?? "");
            const sessionId = String(row.id ?? "");
            return (
              <div
                key={String(row.id ?? row.user_id ?? index)}
                className="rounded-xl border border-border/60 p-3 text-sm"
              >
                {kind === "negative" ? (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{String(row.user_email ?? row.user_id)}</div>
                      <div className="text-xs text-muted-foreground">
                        Credits: {String(row.credits)}
                      </div>
                    </div>
                    {canAct && onAdjust && userId && (
                      <Button size="sm" variant="outline" onClick={() => onAdjust(userId)}>
                        Adjust
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{sessionId}</div>
                      <div className="text-xs text-muted-foreground">
                        {String(row.credits)} credits / {String(row.status)}
                      </div>
                    </div>
                    {canAct && onEscrowAction && sessionId && (
                      <div className="flex flex-col gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onEscrowAction(sessionId, "escrow_refund")}
                        >
                          Refund
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onEscrowAction(sessionId, "escrow_release")}
                        >
                          Release
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
