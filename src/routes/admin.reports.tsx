import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, Loader2, ShieldCheck, X as XIcon } from "lucide-react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ADMIN_REPORTS_KEY,
  buildIdempotencyKey,
  hasAdminPermission,
  useAdminPermissions,
  useAdminReportsQueue,
} from "@/lib/admin";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({ meta: [{ title: "Moderation | SkillSwap" }] }),
  component: AdminReportsPage,
});

type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";
type ReportResolution =
  | "no_action"
  | "bad_faith"
  | "upheld_minor"
  | "upheld_major"
  | "upheld_severe";

type ReportQueueRow = {
  id: string;
  reason: string;
  details: string | null;
  status: ReportStatus;
  resolution: ReportResolution | null;
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

type ReportView = Omit<
  ReportQueueRow,
  "reporter_name" | "reported_user_name" | "message_preview" | "review_preview" | "session_skill"
> & {
  reporterName: string;
  reportedUserName: string | null;
  messagePreview: string | null;
  reviewPreview: string | null;
  sessionSkill: string | null;
};

const DISMISS_RESOLUTIONS: { value: ReportResolution; label: string; description: string }[] = [
  {
    value: "no_action",
    label: "No action - not enough evidence",
    description: "Report wasn't substantiated. No penalty to anyone.",
  },
  {
    value: "bad_faith",
    label: "Bad faith - fake or malicious report",
    description: "Issues a strike against the REPORTER for filing in bad faith.",
  },
];

const RESOLVE_RESOLUTIONS: { value: ReportResolution; label: string; description: string }[] = [
  {
    value: "upheld_minor",
    label: "Upheld - minor (1 strike)",
    description: "Confirmed violation. Reported user gets 1 strike.",
  },
  {
    value: "upheld_major",
    label: "Upheld - major (2 strikes)",
    description: "Serious violation. Reported user gets 2 strikes.",
  },
  {
    value: "upheld_severe",
    label: "Upheld - severe (4 strikes)",
    description: "Severe violation. 4 strikes may trigger permanent ban.",
  },
];

const STATUS_FILTERS: { key: ReportStatus | "all"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "reviewing", label: "Reviewing" },
  { key: "resolved", label: "Resolved" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

const REASON_LABELS: Record<string, string> = {
  harassment_or_abuse: "Harassment or abuse",
  spam: "Spam",
  inappropriate_content: "Inappropriate content",
  contact_off_platform: "Off-platform contact",
  no_show_or_unresponsive: "No-show",
  scam_or_fraud: "Scam or fraud",
  impersonation: "Impersonation",
  other: "Other",
};

const STATUS_BADGE: Record<ReportStatus, string> = {
  open: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  reviewing: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  resolved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  dismissed: "bg-muted text-muted-foreground border-border",
};

const STATUS_REASON_OPTIONS = [
  {
    value: "moderation:status_review",
    label: "Status review",
  },
  {
    value: "moderation:policy_violation",
    label: "Policy violation confirmed",
  },
  {
    value: "moderation:false_positive",
    label: "False positive / no violation",
  },
];

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AdminReportsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const permissionsQuery = useAdminPermissions();
  const canRead = hasAdminPermission(permissionsQuery.data, "moderation", "read");
  const canUpdate = hasAdminPermission(permissionsQuery.data, "moderation", "update");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const queryClient = useQueryClient();
  // Read through the shared TanStack Query hook so this route benefits from
  // the same caching/refetch wiring (and ADMIN_REPORTS_KEY invalidation) as
  // the rest of the admin pages. Previously this route had its own bespoke
  // fetch + useState pair which bypassed any cross-page cache invalidation.
  const reportsQuery = useAdminReportsQueue(Boolean(authorized));
  const loading = reportsQuery.isLoading;
  const reports = useMemo<ReportView[]>(() => {
    const rows = reportsQuery.data ?? [];
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      // RPC returns generic strings; narrow back to our local unions.
      status: r.status as ReportStatus,
      resolution: (r.resolution ?? null) as ReportResolution | null,
      created_at: r.created_at,
      reporter_id: r.reporter_id,
      reported_user_id: r.reported_user_id,
      session_id: r.session_id,
      message_id: r.message_id,
      review_id: r.review_id,
      reporterName: r.reporter_name ?? "Deleted user",
      reportedUserName: r.reported_user_id ? (r.reported_user_name ?? "Student") : null,
      messagePreview: r.message_id ? (r.message_preview ?? "(deleted)") : null,
      reviewPreview: r.review_id ? r.review_preview?.trim() || "(removed)" : null,
      sessionSkill: r.session_skill ?? null,
    }));
  }, [reportsQuery.data]);
  const [filter, setFilter] = useState<ReportStatus | "all">("open");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    reportId: string;
    status: ReportStatus;
  } | null>(null);
  const [reasonCode, setReasonCode] = useState("moderation:status_review");
  const [justification, setJustification] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [resolution, setResolution] = useState<ReportResolution | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin/reports" } });
    }
  }, [authLoading, navigate, user]);

  useEffect(() => {
    if (!user || permissionsQuery.isLoading) return;
    setAuthorized(canRead);
    if (!canRead) {
      toast.error("You don't have access to moderation.");
      navigate({ to: "/dashboard" });
    }
  }, [canRead, navigate, permissionsQuery.isLoading, user]);

  // Reload happens automatically via TanStack Query — surface RPC errors as a
  // toast (the old hand-rolled fetch did the same).
  useEffect(() => {
    if (!reportsQuery.error) return;
    toast.error(reportsQuery.error.message ?? "Could not load reports queue.");
  }, [reportsQuery.error]);

  const filtered = useMemo(
    () => (filter === "all" ? reports : reports.filter((r) => r.status === filter)),
    [reports, filter],
  );

  const counts = useMemo(() => {
    const map: Record<ReportStatus | "all", number> = {
      all: reports.length,
      open: 0,
      reviewing: 0,
      resolved: 0,
      dismissed: 0,
    };
    for (const r of reports) map[r.status] += 1;
    return map;
  }, [reports]);

  const openStatusAction = (id: string, next: ReportStatus) => {
    if (!canUpdate) {
      toast.error("You can view reports, but you cannot update moderation status.");
      return;
    }

    setReasonCode(next === "dismissed" ? "moderation:false_positive" : "moderation:status_review");
    setJustification("");
    setTicketRef("");
    // Pre-pick the safest default so moderators don't accidentally fire a
    // strike: dismissed defaults to "no action" (no penalty), resolved
    // defaults to "minor" (small penalty).
    setResolution(next === "dismissed" ? "no_action" : next === "resolved" ? "upheld_minor" : null);
    setPendingAction({ reportId: id, status: next });
  };

  const submitStatusUpdate = async () => {
    if (!pendingAction) return;
    if (justification.trim().length < 8) {
      toast.error("Add a justification of at least 8 characters.");
      return;
    }
    if (
      (pendingAction.status === "resolved" || pendingAction.status === "dismissed") &&
      !resolution
    ) {
      toast.error("Pick a resolution before confirming.");
      return;
    }

    setBusyId(pendingAction.reportId);
    const { error } = await supabase.rpc("admin_update_report_status", {
      p_report_id: pendingAction.reportId,
      p_status: pendingAction.status,
      p_reason_code: reasonCode,
      p_justification: justification.trim(),
      p_ticket_ref: ticketRef.trim() || null,
      p_idempotency_key: buildIdempotencyKey(
        "report-status",
        pendingAction.reportId,
        pendingAction.status,
      ),
      p_resolution: resolution,
    });
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    // Invalidate the shared TanStack Query cache so the next render reflects
    // the new server-side status. Cheaper than the old hand-rolled state
    // patch and keeps anyone else reading via the hook in sync too.
    void queryClient.invalidateQueries({ queryKey: ADMIN_REPORTS_KEY(user?.id) });
    toast.success(
      pendingAction.status === "dismissed" && resolution === "bad_faith"
        ? "Dismissed - strike issued to reporter"
        : pendingAction.status === "resolved"
          ? `Resolved - strike issued to reported user`
          : `Marked ${pendingAction.status}`,
    );
    setPendingAction(null);
  };

  if (authLoading || permissionsQuery.isLoading || authorized === null) {
    return <PageLoading variant="list-wide" />;
  }
  if (!authorized) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4">
        <header className="glass rounded-3xl p-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold gradient-brand-text">Moderation</h1>
            <p className="text-xs text-muted-foreground">
              Review user-submitted reports. Status changes require reasoned, audited RPC actions.
            </p>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as ReportStatus | "all")}
          >
            <SelectTrigger className="w-48" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label} ({counts[f.key]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass rounded-3xl px-6 py-12 text-center text-sm text-muted-foreground">
            No reports in this view.
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => (
              <article key={r.id} className="glass rounded-2xl p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("border", STATUS_BADGE[r.status])}>
                        {r.status}
                      </Badge>
                      {r.resolution && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "border",
                            r.resolution === "bad_faith"
                              ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                              : r.resolution.startsWith("upheld_")
                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                : "bg-muted text-muted-foreground border-border",
                          )}
                        >
                          {r.resolution.replace(/_/g, " ")}
                        </Badge>
                      )}
                      <Badge variant="outline" className="bg-white/5 border-white/10">
                        {REASON_LABELS[r.reason] ?? r.reason}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(r.created_at)}
                      </span>
                    </div>
                    <div className="mt-2 text-sm">
                      <span className="font-semibold">{r.reporterName}</span>{" "}
                      <span className="text-muted-foreground">reported</span>{" "}
                      {r.reportedUserName ? (
                        <span className="font-semibold">{r.reportedUserName}</span>
                      ) : (
                        <span className="text-muted-foreground">N/A</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.status === "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === r.id}
                        onClick={() => openStatusAction(r.id, "reviewing")}
                      >
                        <Eye className="h-4 w-4" /> Reviewing
                      </Button>
                    )}
                    {(r.status === "open" || r.status === "reviewing") && (
                      <>
                        <Button
                          size="sm"
                          variant="hero"
                          disabled={busyId === r.id}
                          onClick={() => openStatusAction(r.id, "resolved")}
                        >
                          <CheckCircle2 className="h-4 w-4" /> Resolve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === r.id}
                          onClick={() => openStatusAction(r.id, "dismissed")}
                        >
                          <XIcon className="h-4 w-4" /> Dismiss
                        </Button>
                      </>
                    )}
                    {(r.status === "resolved" || r.status === "dismissed") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === r.id}
                        onClick={() => openStatusAction(r.id, "open")}
                      >
                        Reopen
                      </Button>
                    )}
                  </div>
                </div>

                {(r.details || r.messagePreview || r.reviewPreview || r.sessionSkill) && (
                  <div className="mt-3 space-y-2 rounded-xl bg-background/40 p-3 text-sm">
                    {r.details && (
                      <div>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          Details
                        </span>
                        <p className="mt-1 whitespace-pre-wrap">{r.details}</p>
                      </div>
                    )}
                    {r.messagePreview && (
                      <div>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          Reported message
                        </span>
                        <p className="mt-1 italic">&ldquo;{r.messagePreview}&rdquo;</p>
                      </div>
                    )}
                    {r.reviewPreview && (
                      <div>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          Reported review
                        </span>
                        <p className="mt-1 italic">&ldquo;{r.reviewPreview}&rdquo;</p>
                      </div>
                    )}
                    {r.sessionSkill && (
                      <div>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          Session
                        </span>
                        <p className="mt-1">{r.sessionSkill}</p>
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </main>

      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Confirm moderation action</DialogTitle>
            <DialogDescription>
              This privileged action is executed by secured RPC and written to the immutable admin
              audit chain.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
              Changing this report to{" "}
              <span className="font-semibold">{pendingAction?.status ?? "unknown"}</span> may affect
              downstream trust and safety workflows.
            </div>

            {(pendingAction?.status === "dismissed" || pendingAction?.status === "resolved") && (
              <div className="space-y-2">
                <Label htmlFor="resolution">Resolution</Label>
                <Select
                  value={resolution ?? ""}
                  onValueChange={(v) => setResolution(v as ReportResolution)}
                >
                  <SelectTrigger id="resolution">
                    <SelectValue placeholder="Pick a resolution" />
                  </SelectTrigger>
                  <SelectContent>
                    {(pendingAction.status === "dismissed"
                      ? DISMISS_RESOLUTIONS
                      : RESOLVE_RESOLUTIONS
                    ).map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {resolution && (
                  <p className="text-xs text-muted-foreground">
                    {
                      (pendingAction.status === "dismissed"
                        ? DISMISS_RESOLUTIONS
                        : RESOLVE_RESOLUTIONS
                      ).find((o) => o.value === resolution)?.description
                    }
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="reason-code">Reason code</Label>
              <Select value={reasonCode} onValueChange={setReasonCode}>
                <SelectTrigger id="reason-code">
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_REASON_OPTIONS.map((reason) => (
                    <SelectItem key={reason.value} value={reason.value}>
                      {reason.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="justification">Justification</Label>
              <Textarea
                id="justification"
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                placeholder="Document the policy basis and reviewer rationale."
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ticket-ref">Ticket or incident reference</Label>
              <Input
                id="ticket-ref"
                value={ticketRef}
                onChange={(event) => setTicketRef(event.target.value)}
                placeholder="Optional for moderation, mandatory for incident reasons"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              variant="hero"
              disabled={Boolean(pendingAction && busyId === pendingAction.reportId)}
              onClick={() => void submitStatusUpdate()}
            >
              Confirm action
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
