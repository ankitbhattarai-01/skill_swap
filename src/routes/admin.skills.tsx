import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { GraduationCap, Loader2, Plus, RefreshCw, Search, ShieldX, Trash2 } from "lucide-react";
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
import { Metric } from "@/components/admin/KpiTile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  ADMIN_SKILLS_KEY,
  adminErrorMessage,
  hasAdminPermission,
  useAdminPermissions,
  useAdminSkillsCatalog,
  type AdminSkillRow,
} from "@/lib/admin";

export const Route = createFileRoute("/admin/skills")({
  head: () => ({ meta: [{ title: "Skills - SkillSwap Admin" }] }),
  component: AdminSkillsPage,
});

function AdminSkillsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissionsQuery = useAdminPermissions();
  const permissions = permissionsQuery.data;
  const canRead = hasAdminPermission(permissions, "moderation", "read");
  const canUpdate = hasAdminPermission(permissions, "moderation", "update");
  const canDelete = hasAdminPermission(permissions, "moderation", "delete");
  const catalogQuery = useAdminSkillsCatalog(canRead);
  const skills = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminSkillRow | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin/skills" } });
    }
  }, [authLoading, navigate, user]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ADMIN_SKILLS_KEY(user?.id) });
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setName("");
    setCategory("");
    setTicketRef("");
    setJustification("");
  };

  const closeDelete = () => {
    setDeleteTarget(null);
    setTicketRef("");
    setJustification("");
  };

  const createSkill = async () => {
    if (name.trim().length < 2 || justification.trim().length < 8) {
      toast.error("Skill name (2+ chars) and justification (8+ chars) are required.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("admin_create_skill", {
      p_name: name.trim(),
      p_category: category.trim() ? category.trim() : null,
      p_reason_code: "skills:catalog",
      p_justification: justification.trim(),
      p_ticket_ref: ticketRef.trim() || "n/a",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Skill added.");
    closeCreate();
    await invalidate();
  };

  const deleteSkill = async () => {
    if (!deleteTarget) return;
    if (justification.trim().length < 8) {
      toast.error("Justification (8+ chars) is required.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("admin_delete_skill", {
      p_skill_id: deleteTarget.id,
      p_reason_code: "skills:catalog",
      p_justification: justification.trim(),
      p_ticket_ref: ticketRef.trim() || "n/a",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Skill deleted.");
    closeDelete();
    await invalidate();
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
              <h1 className="text-xl font-semibold">No skills access</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Skills catalog requires moderation read permission.
              </p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          (s.category ?? "").toLowerCase().includes(needle),
      )
    : skills;

  const totalUsage = skills.reduce(
    (sum, s) => sum + s.teaching_count + s.learning_count + s.session_count,
    0,
  );

  const canSubmitCreate = name.trim().length >= 2 && justification.trim().length >= 8;
  const canSubmitDelete = justification.trim().length >= 8;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Skills Catalog</h1>
              <p className="text-sm text-muted-foreground">
                Curate the shared skills list. Deletions are blocked when a skill is in use.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={catalogQuery.isFetching}
              onClick={() => void catalogQuery.refetch()}
              title="Refresh"
            >
              <RefreshCw className={catalogQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
            <Button disabled={!canUpdate} onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Add skill
            </Button>
          </div>
        </div>

        {catalogQuery.isError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load skills catalog: {adminErrorMessage(catalogQuery.error)}
          </div>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Metric label="Skills" value={skills.length} />
          <Metric label="Total references" value={totalUsage} />
          <Metric
            label="Orphaned"
            value={
              skills.filter((s) => s.teaching_count + s.learning_count + s.session_count === 0)
                .length
            }
          />
        </div>
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-card/80 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              placeholder="Search name or category"
              aria-label="Search skills by name or category"
            />
          </div>
          {catalogQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        </div>

        {filtered.length === 0 ? (
          skills.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="No skills in the catalog"
              description="Users normally add skills as they onboard. You can also seed the catalog manually."
              action={
                canUpdate ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    Add first skill
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              title="No skills match the current search"
              action={
                <Button size="sm" variant="ghost" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              }
            />
          )
        ) : (
          <Table className="table-stack-mobile">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Teaching</TableHead>
                <TableHead>Learning</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((skill) => {
                const inUse = skill.teaching_count + skill.learning_count + skill.session_count > 0;
                return (
                  <TableRow key={skill.id}>
                    <TableCell data-label="Name" className="font-medium">
                      {skill.name}
                    </TableCell>
                    <TableCell data-label="Category">
                      {skill.category ? (
                        <Badge variant="outline">{skill.category}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell data-label="Teaching">{skill.teaching_count}</TableCell>
                    <TableCell data-label="Learning">{skill.learning_count}</TableCell>
                    <TableCell data-label="Sessions">{skill.session_count}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canDelete || inUse}
                        title={
                          inUse
                            ? "Skill is in use; clear references before deleting"
                            : "Delete skill"
                        }
                        onClick={() => {
                          setDeleteTarget(skill);
                          setTicketRef("");
                          setJustification("");
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add skill to catalog</DialogTitle>
            <DialogDescription>
              The change is audited. Use sentence case (e.g. "Python", not "python").
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. JavaScript"
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <Label>Category (optional)</Label>
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Programming"
                maxLength={40}
              />
            </div>
            <div className="space-y-2">
              <Label>Ticket reference (optional)</Label>
              <Input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Justification</Label>
              <Textarea
                value={justification}
                rows={3}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why this skill is being added (8+ characters)."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeCreate}>
              Cancel
            </Button>
            <Button disabled={busy || !canSubmitCreate} onClick={() => void createSkill()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && closeDelete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete skill</DialogTitle>
            <DialogDescription>
              This is permanent and recorded in the audit chain. Only orphaned skills can be
              deleted.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-sm">
              <div className="font-medium">{deleteTarget.name}</div>
              {deleteTarget.category && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Category: {deleteTarget.category}
                </div>
              )}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Ticket reference (optional)</Label>
              <Input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Justification</Label>
              <Textarea
                value={justification}
                rows={3}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why this skill is being removed (8+ characters)."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !canSubmitDelete}
              onClick={() => void deleteSkill()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
