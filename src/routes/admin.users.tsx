import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ClipboardCopy,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  ShieldOff,
  ShieldX,
  Users,
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
import { ReasonFields } from "@/components/admin/ReasonFields";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search-config";
import { formatDate } from "@/lib/admin-format";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  ADMIN_USERS_KEY,
  adminErrorMessage,
  hasAdminPermission,
  useAdminPermissions,
  useAdminUsers,
  type AdminUserRow,
} from "@/lib/admin";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/users")({
  head: () => ({ meta: [{ title: "Users - SkillSwap Admin" }] }),
  component: AdminUsersPage,
});

const SORT_OPTIONS = [
  { value: "sessions", label: "Most sessions" },
  { value: "reports", label: "Most reports" },
  { value: "sign_in", label: "Recent sign-in" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["value"];

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error(`Couldn't copy ${label.toLowerCase()}.`);
  }
}

function AdminUsersPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissionsQuery = useAdminPermissions();
  const permissions = permissionsQuery.data;
  const canRead = hasAdminPermission(permissions, "users", "read");
  const canReveal =
    hasAdminPermission(permissions, "users", "reveal") ||
    hasAdminPermission(permissions, "privacy", "reveal");
  const canSuspend = hasAdminPermission(permissions, "users", "update");
  const canGrantAdmin = hasAdminPermission(permissions, "access-governance", "approve");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admins" | "standard">("all");
  const [onboardedFilter, setOnboardedFilter] = useState<"all" | "yes" | "no">("all");
  const [sort, setSort] = useState<SortKey>("sessions");
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<{
    id: string;
    mode: "suspend" | "reinstate";
    label: string | null;
  } | null>(null);
  const [adminTarget, setAdminTarget] = useState<{
    id: string;
    mode: "grant" | "revoke";
    label: string | null;
  } | null>(null);
  const [ticketRef, setTicketRef] = useState("");
  const [justification, setJustification] = useState("");
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailUser, setDetailUser] = useState<AdminUserRow | null>(null);
  const usersQuery = useAdminUsers(canRead, search);
  const allUsers = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);

  // Debounce the search input so we don't fire an RPC on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const filteredUsers = useMemo(() => {
    return allUsers
      .filter((row) => {
        if (roleFilter === "admins" && !row.has_admin_role) return false;
        if (roleFilter === "standard" && row.has_admin_role) return false;
        if (onboardedFilter === "yes" && !row.onboarded) return false;
        if (onboardedFilter === "no" && row.onboarded) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        switch (sort) {
          case "sessions":
            return b.session_count - a.session_count;
          case "reports":
            return b.report_count - a.report_count;
          case "sign_in":
            return (
              new Date(b.last_sign_in_at ?? 0).getTime() -
              new Date(a.last_sign_in_at ?? 0).getTime()
            );
          case "newest":
            return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
          case "oldest":
            return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
          default:
            return 0;
        }
      });
  }, [allUsers, roleFilter, onboardedFilter, sort]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin/users" } });
    }
  }, [authLoading, navigate, user]);

  const closeReveal = () => {
    setRevealTarget(null);
    setTicketRef("");
    setJustification("");
    setRevealed(null);
  };

  const closeSuspend = () => {
    setSuspendTarget(null);
    setTicketRef("");
    setJustification("");
  };

  const closeAdmin = () => {
    setAdminTarget(null);
    setTicketRef("");
    setJustification("");
  };

  const runAdminAction = async () => {
    if (!adminTarget || busy) return;
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    setBusy(true);
    try {
      const makeAdmin = adminTarget.mode === "grant";
      const { error } = await supabase.rpc("admin_set_user_admin", {
        p_user_id: adminTarget.id,
        p_make_admin: makeAdmin,
        p_reason_code: makeAdmin ? "access:admin_grant" : "access:admin_revoke",
        p_justification: justification.trim(),
        p_ticket_ref: ticketRef.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(makeAdmin ? "User is now an admin." : "Admin access removed.");
      closeAdmin();
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY(user?.id, search) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update admin access.");
    } finally {
      setBusy(false);
    }
  };

  const runSuspendAction = async () => {
    if (!suspendTarget || busy) return;
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    // try/finally so a network throw can't strand the dialog's button in its
    // disabled busy state.
    setBusy(true);
    try {
      const rpc = suspendTarget.mode === "suspend" ? "admin_suspend_user" : "admin_reinstate_user";
      const reasonCode = suspendTarget.mode === "suspend" ? "users:suspend" : "users:reinstate";
      const { error } = await supabase.rpc(rpc, {
        p_user_id: suspendTarget.id,
        p_reason_code: reasonCode,
        p_justification: justification.trim(),
        p_ticket_ref: ticketRef.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(suspendTarget.mode === "suspend" ? "User suspended." : "User reinstated.");
      closeSuspend();
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY(user?.id, search) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the user.");
    } finally {
      setBusy(false);
    }
  };

  const revealPii = async () => {
    if (!revealTarget || busy) return;
    if (ticketRef.trim().length < 3 || justification.trim().length < 8) {
      toast.error("Ticket reference and justification are required.");
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("reveal_admin_user_pii", {
        p_user_id: revealTarget,
        p_reason_code: "privacy:pii_reveal",
        p_justification: justification.trim(),
        p_ticket_ref: ticketRef.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      setRevealed((data ?? {}) as Record<string, unknown>);
      toast.success("PII reveal logged.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reveal PII.");
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
              <h1 className="text-xl font-semibold">No user admin access</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                User administration requires users read permission.
              </p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const hasFilters =
    roleFilter !== "all" || onboardedFilter !== "all" || searchInput.trim().length > 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">User Administration</h1>
              <p className="text-sm text-muted-foreground">
                Masked-by-default user search with audited reveal controls.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{canReveal ? "Reveal enabled" : "Masked only"}</Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={usersQuery.isFetching}
              onClick={() => void usersQuery.refetch()}
              title="Refresh users"
            >
              <RefreshCw className={usersQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-[2fr_1fr_1fr_180px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="pl-9"
              placeholder="Search by email or exact user id"
            />
            {searchInput !== search && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {[
              { value: "all", label: "Any role" },
              { value: "admins", label: "Admins" },
              { value: "standard", label: "Standard" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRoleFilter(option.value as typeof roleFilter)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  roleFilter === option.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {[
              { value: "all", label: "Any state" },
              { value: "yes", label: "Onboarded" },
              { value: "no", label: "Pending" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setOnboardedFilter(option.value as typeof onboardedFilter)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  onboardedFilter === option.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
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

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {filteredUsers.length}
            {hasFilters ? ` of ${allUsers.length} loaded` : ""} (max 50 per query, narrow the search
            for more)
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setRoleFilter("all");
                setOnboardedFilter("all");
              }}
              className="text-foreground hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {usersQuery.isError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load users: {adminErrorMessage(usersQuery.error)}
          </div>
        )}
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-card/80 p-2 sm:p-4">
        <Table className="table-stack-mobile">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead>Admin</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.map((row) => (
              <TableRow
                key={row.id}
                onClick={() => setDetailUser(row)}
                className="cursor-pointer hover:bg-muted/30"
              >
                <TableCell data-label="User">
                  <div className="space-y-1 text-right md:text-left">
                    <div className="font-medium break-anywhere">
                      {row.masked_email ?? "masked user"}
                    </div>
                    <div className="text-xs text-muted-foreground break-anywhere">
                      {row.masked_name ?? row.id}
                    </div>
                  </div>
                </TableCell>
                <TableCell data-label="Activity">
                  <div className="text-right md:text-left">
                    <div className="text-sm">{row.session_count} sessions</div>
                    <div className="text-xs text-muted-foreground">
                      {row.report_count} reports
                      {row.report_count > 0 && (
                        <FileText className="ml-1 inline h-3 w-3 text-amber-400" />
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell data-label="Admin">
                  <div className="flex flex-row items-center gap-1 md:flex-col md:items-start">
                    <Badge variant={row.has_admin_role ? "default" : "outline"}>
                      {row.has_admin_role ? "privileged" : "standard"}
                    </Badge>
                    {row.suspended_at && (
                      <Badge variant="destructive" className="text-[10px]">
                        suspended
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell data-label="Last sign-in">{formatDate(row.last_sign_in_at)}</TableCell>
                <TableCell className="text-right">
                  <div
                    className="flex flex-wrap justify-end gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canReveal}
                      onClick={() => {
                        setTicketRef("");
                        setJustification("");
                        setRevealed(null);
                        setRevealTarget(row.id);
                      }}
                    >
                      <Eye className="h-4 w-4" /> Reveal
                    </Button>
                    {canGrantAdmin &&
                      row.id !== user.id &&
                      (row.has_admin_role ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Remove admin access"
                          onClick={() => {
                            setTicketRef("");
                            setJustification("");
                            setAdminTarget({
                              id: row.id,
                              mode: "revoke",
                              label: row.masked_email ?? row.masked_name,
                            });
                          }}
                        >
                          <ShieldOff className="h-4 w-4" /> Remove admin
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Make this user an admin"
                          onClick={() => {
                            setTicketRef("");
                            setJustification("");
                            setAdminTarget({
                              id: row.id,
                              mode: "grant",
                              label: row.masked_email ?? row.masked_name,
                            });
                          }}
                        >
                          <Shield className="h-4 w-4" /> Make admin
                        </Button>
                      ))}
                    {row.suspended_at ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canSuspend}
                        title="Reinstate user"
                        onClick={() => {
                          setTicketRef("");
                          setJustification("");
                          setSuspendTarget({
                            id: row.id,
                            mode: "reinstate",
                            label: row.masked_email ?? row.masked_name,
                          });
                        }}
                      >
                        <CheckCircle2 className="h-4 w-4" /> Reinstate
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canSuspend || row.id === user.id}
                        title={row.id === user.id ? "Cannot suspend yourself" : "Suspend user"}
                        onClick={() => {
                          setTicketRef("");
                          setJustification("");
                          setSuspendTarget({
                            id: row.id,
                            mode: "suspend",
                            label: row.masked_email ?? row.masked_name,
                          });
                        }}
                      >
                        <Ban className="h-4 w-4" /> Suspend
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!usersQuery.isError &&
          filteredUsers.length === 0 &&
          (hasFilters ? (
            <EmptyState
              title="No users match the current filters"
              description="Try a broader search, or clear the role/onboarded filters."
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearchInput("");
                    setRoleFilter("all");
                    setOnboardedFilter("all");
                  }}
                >
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Users} title="No users found" />
          ))}
      </section>

      <Dialog open={Boolean(detailUser)} onOpenChange={(open) => !open && setDetailUser(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>User detail</DialogTitle>
            <DialogDescription>
              Read-only summary from the masked admin user view. Use Reveal to log a PII disclosure.
            </DialogDescription>
          </DialogHeader>
          {detailUser && (
            <div className="space-y-3 text-sm">
              <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      User id
                    </div>
                    <div className="mt-1 break-all font-mono text-xs">{detailUser.id}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyToClipboard(detailUser.id, "User id")}
                  >
                    <ClipboardCopy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailField label="Masked email" value={detailUser.masked_email ?? "N/A"} />
                <DetailField label="Masked name" value={detailUser.masked_name ?? "N/A"} />
                <DetailField
                  label="Role"
                  value={detailUser.has_admin_role ? "privileged" : "standard"}
                />
                <DetailField label="Onboarded" value={detailUser.onboarded ? "yes" : "no"} />
                <DetailField label="Learning mode" value={detailUser.learning_mode ?? "N/A"} />
                <DetailField label="Sessions" value={String(detailUser.session_count)} />
                <DetailField label="Reports" value={String(detailUser.report_count)} />
                <DetailField label="Created" value={formatDate(detailUser.created_at)} />
                <DetailField label="Last sign-in" value={formatDate(detailUser.last_sign_in_at)} />
                <DetailField
                  label="Suspended"
                  value={detailUser.suspended_at ? formatDate(detailUser.suspended_at) : "no"}
                />
                {detailUser.suspended_reason && (
                  <DetailField label="Suspension reason" value={detailUser.suspended_reason} />
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailUser(null)}>
              Close
            </Button>
            {detailUser && canReveal && (
              <Button
                onClick={() => {
                  const id = detailUser.id;
                  setDetailUser(null);
                  setTicketRef("");
                  setJustification("");
                  setRevealed(null);
                  setRevealTarget(id);
                }}
              >
                <Eye className="h-4 w-4" /> Reveal PII
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(suspendTarget)} onOpenChange={(open) => !open && closeSuspend()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {suspendTarget?.mode === "suspend" ? "Suspend user" : "Reinstate user"}
            </DialogTitle>
            <DialogDescription>
              {suspendTarget?.mode === "suspend"
                ? "Suspended users are blocked from creating new sessions. The action is recorded in the audit chain."
                : "Reinstating clears the suspension and the user can resume creating sessions immediately."}
            </DialogDescription>
          </DialogHeader>
          {suspendTarget && (
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-sm">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Target</div>
              <div className="mt-1 break-all font-medium">
                {suspendTarget.label ?? suspendTarget.id}
              </div>
            </div>
          )}
          <div className="space-y-4">
            <ReasonFields
              ticketRef={ticketRef}
              justification={justification}
              onTicketRefChange={setTicketRef}
              onJustificationChange={setJustification}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeSuspend}>
              Cancel
            </Button>
            <Button
              variant={suspendTarget?.mode === "suspend" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void runSuspendAction()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {suspendTarget?.mode === "suspend" ? "Suspend" : "Reinstate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(adminTarget)} onOpenChange={(open) => !open && closeAdmin()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {adminTarget?.mode === "grant" ? "Make user an admin" : "Remove admin access"}
            </DialogTitle>
            <DialogDescription>
              {adminTarget?.mode === "grant"
                ? "Grants full platform admin access (every admin permission). The change is recorded in the audit chain."
                : "Revokes every active admin role from this user. The change is recorded in the audit chain."}
            </DialogDescription>
          </DialogHeader>
          {adminTarget && (
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-sm">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Target</div>
              <div className="mt-1 break-all font-medium">
                {adminTarget.label ?? adminTarget.id}
              </div>
            </div>
          )}
          <div className="space-y-4">
            <ReasonFields
              ticketRef={ticketRef}
              justification={justification}
              onTicketRefChange={setTicketRef}
              onJustificationChange={setJustification}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAdmin}>
              Cancel
            </Button>
            <Button
              variant={adminTarget?.mode === "revoke" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void runAdminAction()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {adminTarget?.mode === "grant" ? "Make admin" : "Remove admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(revealTarget)} onOpenChange={(open) => !open && closeReveal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reveal restricted user data</DialogTitle>
            <DialogDescription>
              This action is logged with reason, ticket, actor, and subject id.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!revealed && (
              <ReasonFields
                ticketRef={ticketRef}
                justification={justification}
                onTicketRefChange={setTicketRef}
                onJustificationChange={setJustification}
              />
            )}
            {revealed && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Revealed details
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void copyToClipboard(JSON.stringify(revealed, null, 2), "Revealed details")
                    }
                  >
                    <ClipboardCopy className="h-4 w-4" /> Copy
                  </Button>
                </div>
                <div className="grid max-h-72 gap-3 overflow-auto sm:grid-cols-2">
                  {revealedPiiEntries(revealed).map((entry) => (
                    <DetailField key={entry.key} label={entry.label} value={entry.value} />
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeReveal}>
              Close
            </Button>
            {!revealed && (
              <Button disabled={busy} onClick={() => void revealPii()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Reveal
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

// Friendly labels + display order for the revealed PII payload so the reveal
// dialog reads as a labeled record rather than raw JSON. Any key not listed
// here still renders (using its raw name) so no disclosed field is ever hidden.
const PII_FIELD_LABELS: Record<string, string> = {
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  bio: "Bio",
  credits: "Credits",
  classification: "Data classification",
  created_at: "Account created",
  last_sign_in_at: "Last sign-in",
  avatar_url: "Avatar file",
  id: "User ID",
};
const PII_FIELD_ORDER = [
  "full_name",
  "email",
  "phone",
  "bio",
  "credits",
  "classification",
  "created_at",
  "last_sign_in_at",
  "avatar_url",
  "id",
];
const PII_DATE_FIELDS = new Set(["created_at", "last_sign_in_at"]);

function formatPiiValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  if (PII_DATE_FIELDS.has(key)) return formatDate(value as string);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function revealedPiiEntries(revealed: Record<string, unknown>) {
  const seen = new Set<string>();
  const entries: Array<{ key: string; label: string; value: string }> = [];
  const push = (key: string) => {
    if (seen.has(key) || !(key in revealed)) return;
    seen.add(key);
    entries.push({
      key,
      label: PII_FIELD_LABELS[key] ?? key,
      value: formatPiiValue(key, revealed[key]),
    });
  };
  PII_FIELD_ORDER.forEach(push);
  Object.keys(revealed).forEach(push);
  return entries;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-all text-sm font-medium">{value}</div>
    </div>
  );
}
