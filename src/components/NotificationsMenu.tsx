import { useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Link } from "@tanstack/react-router";
import { Bell, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import type { Json } from "@/integrations/supabase/types";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
  metadata?: Json;
};

type SessionPreview = {
  id: string;
  learner_id: string;
  teacher_id: string;
  skills: { name: string } | null;
};

type MessagePayload = {
  id: string;
  session_id: string;
  sender_id: string;
  text: string;
  created_at: string;
};

const fallbackKey = (userId: string) => `skillswap-fallback-notifications-${userId}`;
const notificationCacheKey = (userId: string) => `skillswap-notifications-${userId}`;
const seenMessageKey = (userId: string) => `skillswap-seen-message-notifications-${userId}`;

function readFallbackNotifications(userId: string) {
  try {
    return JSON.parse(window.localStorage.getItem(fallbackKey(userId)) ?? "[]") as Notification[];
  } catch {
    window.localStorage.removeItem(fallbackKey(userId));
    return [];
  }
}

function writeFallbackNotifications(userId: string, items: Notification[]) {
  window.localStorage.setItem(
    fallbackKey(userId),
    JSON.stringify(items.filter((item) => item.id.startsWith("message-")).slice(0, 8)),
  );
}

function readCachedNotifications(userId: string) {
  try {
    return JSON.parse(
      window.sessionStorage.getItem(notificationCacheKey(userId)) ?? "[]",
    ) as Notification[];
  } catch {
    window.sessionStorage.removeItem(notificationCacheKey(userId));
    return [];
  }
}

function writeCachedNotifications(userId: string, items: Notification[]) {
  try {
    window.sessionStorage.setItem(notificationCacheKey(userId), JSON.stringify(items.slice(0, 8)));
  } catch {
    // Notification cache is only used to avoid count flicker.
  }
}

function getNotificationMessageId(notification: Notification) {
  if (
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata) &&
    typeof notification.metadata.messageId === "string"
  ) {
    return notification.metadata.messageId;
  }
  return notification.id.startsWith("message-") ? notification.id.slice("message-".length) : null;
}

function getNotificationSessionId(notification: Notification) {
  if (
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata) &&
    typeof notification.metadata.sessionId === "string"
  ) {
    return notification.metadata.sessionId;
  }

  const match = notification.link?.match(/^\/messages\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function mergeNotifications(
  fallbackNotifications: Notification[],
  dbNotifications: Notification[],
) {
  const dbMessageIds = new Set(
    dbNotifications
      .map(getNotificationMessageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  return [
    ...fallbackNotifications.filter((notification) => {
      const messageId = getNotificationMessageId(notification);
      return !messageId || !dbMessageIds.has(messageId);
    }),
    ...dbNotifications,
  ].slice(0, 8);
}

export function NotificationsMenu() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);

  const unreadCount = notifications.filter((notification) => !notification.read_at).length;

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const controller = new AbortController();
    const cachedNotifications = readCachedNotifications(user.id);
    if (cachedNotifications.length) setNotifications(cachedNotifications);
    let seenMessageIds = new Set<string>();
    try {
      seenMessageIds = new Set<string>(
        JSON.parse(window.localStorage.getItem(seenMessageKey(user.id)) ?? "[]") as string[],
      );
    } catch {
      window.localStorage.removeItem(seenMessageKey(user.id));
    }

    const loadNotifications = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("notifications")
        .select("id, type, title, body, link, read_at, created_at, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(8)
        .abortSignal(controller.signal);

      if (alive) {
        const dbNotifications = error ? [] : ((data ?? []) as Notification[]);
        const fallbackNotifications = readFallbackNotifications(user.id);
        const merged = mergeNotifications(fallbackNotifications, dbNotifications);
        setNotifications(merged);
        writeCachedNotifications(user.id, merged);
      }
      if (alive) setLoading(false);
    };

    void loadNotifications();

    // Coalesce realtime-triggered reloads. A single user action (mark-read,
    // bulk delete, cascading trigger on session lifecycle) can fire 3+
    // postgres_changes events in <100ms. Without this debounce each event
    // ran its own SELECT — wasted requests + UI flicker. Trailing-edge: only
    // one reload fires once the burst goes quiet for 250ms.
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        if (alive) void loadNotifications();
      }, 250);
    };

    const rememberMessage = (messageId: string) => {
      seenMessageIds.add(messageId);
      window.localStorage.setItem(
        seenMessageKey(user.id),
        JSON.stringify(Array.from(seenMessageIds).slice(-100)),
      );
    };

    const addMessageNotification = async (message: MessagePayload) => {
      if (!alive || message.sender_id === user.id || seenMessageIds.has(message.id)) return;

      const { data: sessionData } = await supabase
        .from("sessions")
        .select("id, learner_id, teacher_id, skills:skill_id(name)")
        .eq("id", message.session_id)
        .maybeSingle();

      if (!alive || !sessionData) return;

      const session = sessionData as unknown as SessionPreview;
      const isParticipant = session.learner_id === user.id || session.teacher_id === user.id;
      if (!isParticipant) return;

      const { data: sender } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", message.sender_id)
        .maybeSingle();

      rememberMessage(message.id);
      const senderName = sender?.full_name ?? "Someone";
      const fallback: Notification = {
        id: `message-${message.id}`,
        type: "message",
        title: `${senderName} sent you a message`,
        body: message.text,
        link: `/messages?s=${encodeURIComponent(message.session_id)}`,
        read_at: null,
        created_at: message.created_at,
        metadata: { sessionId: message.session_id, messageId: message.id },
      };

      setNotifications((current) => {
        if (current.some((notification) => getNotificationMessageId(notification) === message.id)) {
          return current;
        }
        const next = [fallback, ...current].slice(0, 8);
        writeFallbackNotifications(user.id, next);
        writeCachedNotifications(user.id, next);
        return next;
      });
    };

    const pollRecentMessages = async () => {
      const { data: sessions } = await supabase
        .from("sessions")
        .select("id")
        .or(`learner_id.eq.${user.id},teacher_id.eq.${user.id}`);

      if (!alive || !sessions?.length) return;

      const sessionIds = sessions.map((session) => session.id);
      const { data: messages } = await supabase
        .from("messages")
        .select("id, session_id, sender_id, text, created_at")
        .in("session_id", sessionIds)
        .neq("sender_id", user.id)
        .order("created_at", { ascending: false })
        .limit(8);

      for (const message of ((messages ?? []) as MessagePayload[]).reverse()) {
        await addMessageNotification(message);
      }
    };

    // One initial poll on mount so the badge shows recent unread messages even
    // before realtime connects. After that we rely on the realtime channel
    // below; a 5-minute watchdog catches the rare case where the WebSocket
    // dropped silently. Without this gap, every authenticated tab would issue
    // 2 queries every 8 seconds, which adds up fast at any non-trivial scale.
    void pollRecentMessages();
    const pollId = window.setInterval(() => void pollRecentMessages(), 5 * 60 * 1000);

    const channelSuffix =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let notificationsChannel: RealtimeChannel | null = null;
    let messagesChannel: RealtimeChannel | null = null;

    try {
      notificationsChannel = supabase
        .channel(`notifications-${user.id}-${channelSuffix}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${user.id}`,
          },
          () => scheduleReload(),
        )
        .subscribe();

      // Narrow the fallback channel so it doesn't broadcast events for
      // messages the current user just sent. RLS still gates payload
      // visibility for sessions the user isn't part of, but skipping
      // own-sender events also cuts realtime chatter roughly in half
      // (PERF-001 in the audit).
      messagesChannel = supabase
        .channel(`message-notification-fallback-${user.id}-${channelSuffix}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `sender_id=neq.${user.id}`,
          },
          (payload) => void addMessageNotification(payload.new as MessagePayload),
        )
        .subscribe();
    } catch {
      // Polling above still keeps notifications useful if realtime is unavailable.
    }

    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(pollId);
      if (reloadTimer) clearTimeout(reloadTimer);
      if (notificationsChannel) void supabase.removeChannel(notificationsChannel);
      if (messagesChannel) void supabase.removeChannel(messagesChannel);
    };
  }, [user]);

  const clearAll = async () => {
    if (!user || notifications.length === 0) return;
    // Snapshot the state we're optimistically replacing so a failed DELETE
    // restores both UI and the two cache layers (otherwise we'd leave the
    // bell empty while the server still has every row).
    const previous = notifications;
    setNotifications([]);
    writeFallbackNotifications(user.id, []);
    writeCachedNotifications(user.id, []);
    const { error } = await supabase.from("notifications").delete().eq("user_id", user.id);
    if (error) {
      setNotifications(previous);
      writeFallbackNotifications(user.id, previous);
      writeCachedNotifications(user.id, previous);
      toast.error(error.message);
    }
  };

  const dismiss = async (notification: Notification) => {
    if (!user) return;
    const previous = notifications;
    setNotifications((current) => {
      const next = current.filter((item) => item.id !== notification.id);
      writeFallbackNotifications(user.id, next);
      writeCachedNotifications(user.id, next);
      return next;
    });

    // Message-typed notifications are fallback-only (no DB row backing them),
    // so there's nothing to undo if we did roll back — they live entirely in
    // localStorage.
    if (notification.id.startsWith("message-")) return;

    const { error } = await supabase.from("notifications").delete().eq("id", notification.id);
    if (error) {
      setNotifications(previous);
      writeFallbackNotifications(user.id, previous);
      writeCachedNotifications(user.id, previous);
      toast.error(error.message);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${unreadCount} unread notifications`}
          className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-accent"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-cyan px-1 text-[10px] font-bold text-background ring-2 ring-background">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="glass-strong w-80">
        <div className="flex items-center justify-between gap-3 px-2 py-2">
          <div>
            <div className="text-sm font-semibold">Notifications</div>
            <div className="text-xs text-muted-foreground">
              {unreadCount > 0
                ? `${unreadCount} unread`
                : notifications.length > 0
                  ? `${notifications.length} total`
                  : "All caught up"}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={notifications.length === 0}
            title="Clear all"
          >
            <Trash2 className="h-4 w-4" />
            Clear all
          </Button>
        </div>
        <DropdownMenuSeparator />
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && notifications.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No notifications yet.
          </div>
        )}
        {!loading && notifications.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/notifications" className="justify-center text-xs font-medium">
                View all notifications
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {!loading &&
          notifications.map((notification) => {
            const messageSessionId =
              notification.type === "message" ? getNotificationSessionId(notification) : null;
            const content = (
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {!notification.read_at && <span className="h-2 w-2 rounded-full bg-brand-cyan" />}
                  <div className="truncate text-sm font-medium">{notification.title}</div>
                </div>
                {notification.body && (
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {notification.body}
                  </div>
                )}
              </div>
            );

            return messageSessionId ? (
              <DropdownMenuItem key={notification.id} asChild>
                <Link
                  to="/messages"
                  search={{ s: messageSessionId }}
                  onClick={() => void dismiss(notification)}
                >
                  {content}
                </Link>
              </DropdownMenuItem>
            ) : notification.link ? (
              <DropdownMenuItem key={notification.id} asChild>
                <Link to={notification.link} onClick={() => void dismiss(notification)}>
                  {content}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={notification.id} onClick={() => void dismiss(notification)}>
                {content}
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
