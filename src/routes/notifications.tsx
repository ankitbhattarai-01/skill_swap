import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCheck, Loader2, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageLoading } from "@/components/PageLoading";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/notifications")({
  head: () => ({ meta: [{ title: "Notifications - SkillSwap" }] }),
  component: NotificationsPage,
});

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  metadata: Json;
};

const READ_FILTERS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
] as const;
type ReadFilter = (typeof READ_FILTERS)[number]["value"];

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getSessionId(notification: Notification) {
  if (
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata) &&
    typeof (notification.metadata as Record<string, unknown>).sessionId === "string"
  ) {
    return (notification.metadata as Record<string, string>).sessionId;
  }
  const queryMatch = notification.link?.match(/^\/messages\/?\?s=([^&]+)/);
  if (queryMatch?.[1]) return decodeURIComponent(queryMatch[1]);
  const pathMatch = notification.link?.match(/^\/messages\/([^/?#]+)/);
  return pathMatch?.[1] ?? null;
}

function NotificationsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [clearAllOpen, setClearAllOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/notifications" } });
    }
  }, [authLoading, navigate, user]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("notifications")
        .select("id, type, title, body, link, read_at, created_at, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(200)
        .abortSignal(controller.signal);
      if (!alive) return;
      if (error) {
        toast.error(error.message);
      } else {
        setNotifications((data ?? []) as Notification[]);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [user]);

  const types = useMemo(
    () => Array.from(new Set(notifications.map((n) => n.type))).sort(),
    [notifications],
  );

  const filtered = useMemo(() => {
    return notifications.filter((n) => {
      if (typeFilter !== "all" && n.type !== typeFilter) return false;
      if (readFilter === "unread" && n.read_at) return false;
      if (readFilter === "read" && !n.read_at) return false;
      return true;
    });
  }, [notifications, typeFilter, readFilter]);

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const markRead = async (notification: Notification) => {
    if (!user || notification.read_at) return;
    const nowIso = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) => (item.id === notification.id ? { ...item, read_at: nowIso } : item)),
    );
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: nowIso })
      .eq("id", notification.id);
    if (error) {
      toast.error(error.message);
      setNotifications((current) =>
        current.map((item) => (item.id === notification.id ? { ...item, read_at: null } : item)),
      );
    }
  };

  const markAllRead = async () => {
    if (!user || unreadCount === 0) return;
    setBusy(true);
    const nowIso = new Date().toISOString();
    const previousState = notifications;
    setNotifications((current) =>
      current.map((item) => (item.read_at ? item : { ...item, read_at: nowIso })),
    );
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: nowIso })
      .eq("user_id", user.id)
      .is("read_at", null);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      setNotifications(previousState);
      return;
    }
    toast.success("All marked as read.");
  };

  const dismiss = async (notification: Notification) => {
    if (!user) return;
    const previousState = notifications;
    setNotifications((current) => current.filter((item) => item.id !== notification.id));
    const { error } = await supabase.from("notifications").delete().eq("id", notification.id);
    if (error) {
      toast.error(error.message);
      setNotifications(previousState);
    }
  };

  const clearAll = async () => {
    if (!user || filtered.length === 0) return;
    // Only clear what the user can see. Previously this deleted every row
    // for the user regardless of which type/read filter was active — easy
    // way to nuke notifications the user didn't intend to lose. Build the
    // query off the same predicates that produced `filtered`.
    setBusy(true);
    const previousState = notifications;
    const idsToDelete = new Set(filtered.map((n) => n.id));
    setNotifications((current) => current.filter((item) => !idsToDelete.has(item.id)));

    let query = supabase.from("notifications").delete().eq("user_id", user.id);
    if (typeFilter !== "all") query = query.eq("type", typeFilter);
    if (readFilter === "unread") query = query.is("read_at", null);
    if (readFilter === "read") query = query.not("read_at", "is", null);
    const { error } = await query;

    setBusy(false);
    setClearAllOpen(false);
    if (error) {
      toast.error(error.message);
      setNotifications(previousState);
      return;
    }
    toast.success(
      typeFilter === "all" && readFilter === "all"
        ? "All notifications cleared."
        : "Cleared notifications in current filter.",
    );
  };

  if (authLoading) return <PageLoading variant="dashboard" />;
  if (!user) return null;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Notifications</h1>
              <p className="text-sm text-muted-foreground">
                {unreadCount > 0
                  ? `${unreadCount} unread of ${notifications.length}`
                  : `${notifications.length} total`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || unreadCount === 0}
              onClick={() => void markAllRead()}
            >
              <CheckCheck className="h-4 w-4" /> Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || filtered.length === 0}
              onClick={() => setClearAllOpen(true)}
            >
              <Trash2 className="h-4 w-4" />{" "}
              {typeFilter === "all" && readFilter === "all" ? "Clear all" : "Clear filtered"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[180px_180px]">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger aria-label="Filter by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {types.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={readFilter} onValueChange={(value) => setReadFilter(value as ReadFilter)}>
            <SelectTrigger aria-label="Filter by read state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {READ_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="mt-5 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass rounded-2xl px-6 py-12 text-center text-sm text-muted-foreground">
            {notifications.length === 0
              ? "No notifications yet."
              : "No notifications match the current filters."}
          </div>
        ) : (
          filtered.map((notification) => {
            const sessionId = getSessionId(notification);
            const isUnread = !notification.read_at;
            return (
              <article
                key={notification.id}
                className={cn(
                  "glass flex flex-wrap items-start justify-between gap-3 rounded-2xl p-4 transition-colors",
                  isUnread && "border-primary/30 ring-1 ring-primary/20",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {isUnread && <span className="h-2 w-2 rounded-full bg-brand-cyan" />}
                    <Badge variant="outline">{notification.type}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(notification.created_at)}
                    </span>
                  </div>
                  <div className="mt-2 font-medium">{notification.title}</div>
                  {notification.body && (
                    <p className="mt-1 text-sm text-muted-foreground">{notification.body}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {sessionId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      onClick={() => void markRead(notification)}
                    >
                      <Link to="/messages" preload="intent" search={{ s: sessionId }}>
                        Open
                      </Link>
                    </Button>
                  ) : notification.link ? (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      onClick={() => void markRead(notification)}
                    >
                      <a href={notification.link}>Open</a>
                    </Button>
                  ) : null}
                  {isUnread && (
                    <Button variant="ghost" size="sm" onClick={() => void markRead(notification)}>
                      Mark read
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Dismiss"
                    onClick={() => void dismiss(notification)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </article>
            );
          })
        )}
      </section>

      <Dialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {typeFilter === "all" && readFilter === "all"
                ? "Clear all notifications?"
                : `Clear ${filtered.length} filtered notification${filtered.length === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {typeFilter === "all" && readFilter === "all"
                ? "This permanently deletes every notification on your account. It cannot be undone."
                : "This permanently deletes only the notifications that match your current filters. It cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearAllOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void clearAll()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Clear all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
