import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  clearClearedHorizon,
  clearedHorizonKey,
  readClearedHorizon,
  writeClearedHorizon,
} from "@/lib/notifications-horizon";
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

// Chat is conversation-first: every message belongs to a conversation, and
// session_id is optional context (null for direct messages).
type MessagePayload = {
  id: string;
  conversation_id: string;
  session_id: string | null;
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

// Where should a message notification land? New notifications are
// conversation-first and carry the other user's id (?u=); legacy rows carry a
// session id in metadata or in the link path (?s= / /messages/<id>).
function getMessagesLinkTarget(notification: Notification): { u: string } | { s: string } | null {
  const meta =
    notification.metadata &&
    typeof notification.metadata === "object" &&
    !Array.isArray(notification.metadata)
      ? (notification.metadata as Record<string, unknown>)
      : null;
  if (meta && typeof meta.otherUserId === "string") return { u: meta.otherUserId };
  if (meta && typeof meta.sessionId === "string") return { s: meta.sessionId };
  const uMatch = notification.link?.match(/^\/messages\/?\?u=([^&]+)/);
  if (uMatch?.[1]) return { u: decodeURIComponent(uMatch[1]) };
  const sMatch = notification.link?.match(/^\/messages\/?\?s=([^&]+)/);
  if (sMatch?.[1]) return { s: decodeURIComponent(sMatch[1]) };
  const pathMatch = notification.link?.match(/^\/messages\/([^/?#]+)/);
  return pathMatch?.[1] ? { s: pathMatch[1] } : null;
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
  // Ref so clearAll/dismiss (defined outside the loader effect) can update the
  // same Set the realtime/poll handlers read. Without this, deletes only touch
  // DB rows and the fallback poller happily re-injects the same messages on
  // next mount because the in-closure Set never learned about them.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  // Cleared-horizon timestamp (ms epoch). Anything created at-or-before this
  // is filtered out everywhere — DB load, realtime INSERT, fallback poll.
  // This is the durable suppression mechanism; seenMessageIds is the
  // best-effort dedupe for individual dismisses.
  const clearedHorizonRef = useRef(0);

  const unreadCount = notifications.filter((notification) => !notification.read_at).length;

  const markMessagesSeen = useCallback(
    (messageIds: ReadonlyArray<string>) => {
      if (!user || messageIds.length === 0) return;
      let changed = false;
      for (const id of messageIds) {
        if (!seenMessageIdsRef.current.has(id)) {
          seenMessageIdsRef.current.add(id);
          changed = true;
        }
      }
      if (!changed) return;
      window.localStorage.setItem(
        seenMessageKey(user.id),
        JSON.stringify(Array.from(seenMessageIdsRef.current).slice(-200)),
      );
    },
    [user],
  );

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const controller = new AbortController();
    clearedHorizonRef.current = readClearedHorizon(user.id);
    const horizonFilter = (createdAtIso: string) => {
      if (!clearedHorizonRef.current) return true;
      const t = Date.parse(createdAtIso);
      return Number.isFinite(t) ? t > clearedHorizonRef.current : true;
    };

    const cachedNotifications = readCachedNotifications(user.id).filter((n) =>
      horizonFilter(n.created_at),
    );
    if (cachedNotifications.length) setNotifications(cachedNotifications);
    try {
      seenMessageIdsRef.current = new Set<string>(
        JSON.parse(window.localStorage.getItem(seenMessageKey(user.id)) ?? "[]") as string[],
      );
    } catch {
      window.localStorage.removeItem(seenMessageKey(user.id));
      seenMessageIdsRef.current = new Set();
    }

    const loadNotifications = async () => {
      // Don't flash a spinner on top of a populated cache — that's the whole
      // point of the sessionStorage layer. Only show loading when there's
      // truly nothing on screen yet.
      if (!cachedNotifications.length) setLoading(true);
      const { data, error } = await supabase
        .from("notifications")
        .select("id, type, title, body, link, read_at, created_at, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(8)
        .abortSignal(controller.signal);

      if (alive) {
        const rawDbNotifications = error ? [] : ((data ?? []) as Notification[]);
        // Defense in depth: if a previous Clear all's DELETE silently failed
        // (RLS hiccup, expired token), the rows are still in the DB. Hide
        // them anyway — the user has expressed intent that they're gone.
        const dbNotifications = rawDbNotifications.filter((n) => horizonFilter(n.created_at));
        // Record every DB-backed message notification's underlying messageId so
        // the fallback poller won't re-create it after the user dismisses.
        markMessagesSeen(
          dbNotifications.map(getNotificationMessageId).filter((id): id is string => Boolean(id)),
        );
        const fallbackNotifications = readFallbackNotifications(user.id).filter((n) =>
          horizonFilter(n.created_at),
        );
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

    // Cached sender names so a chatty conversation doesn't re-fetch the same
    // profile row for every realtime INSERT.
    const senderNameCache = new Map<string, string | null>();
    const resolveSenderName = async (senderId: string) => {
      if (senderNameCache.has(senderId)) return senderNameCache.get(senderId) ?? null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", senderId)
        .maybeSingle();
      const name = data?.full_name ?? null;
      senderNameCache.set(senderId, name);
      return name;
    };

    const enqueueMessageNotification = (message: MessagePayload, senderName: string | null) => {
      if (!alive) return;
      markMessagesSeen([message.id]);
      const fallback: Notification = {
        id: `message-${message.id}`,
        type: "message",
        title: `${senderName ?? "Someone"} sent you a message`,
        body: message.text,
        // Conversation-first deep link; messages.tsx resolves ?u= directly.
        link: `/messages?u=${encodeURIComponent(message.sender_id)}`,
        read_at: null,
        created_at: message.created_at,
        metadata: {
          otherUserId: message.sender_id,
          conversationId: message.conversation_id,
          sessionId: message.session_id,
          messageId: message.id,
        },
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

    const addMessageNotification = async (message: MessagePayload) => {
      if (!alive || message.sender_id === user.id || seenMessageIdsRef.current.has(message.id))
        return;
      // Suppress anything sent at-or-before the last Clear all. This is the
      // line that actually stops the poller from resurrecting cleared
      // notifications on refresh — the seen-id set alone wasn't enough
      // because legacy DB rows have no `messageId` in metadata, so they
      // never made it into the set.
      if (!horizonFilter(message.created_at)) {
        markMessagesSeen([message.id]);
        return;
      }

      // Realtime RLS only delivers INSERTs for conversations this user
      // participates in, so no participation lookup is needed. Messages are
      // conversation-first (session_id is optional context), which also means
      // direct messages — with no session at all — notify correctly. One
      // cached profile read for the sender name is the only round trip.
      const senderName = await resolveSenderName(message.sender_id);
      if (!alive) return;
      enqueueMessageNotification(message, senderName);
    };

    const pollRecentMessages = async () => {
      const { data: conversations } = await supabase
        .from("conversations")
        .select("id")
        .or(`user_low.eq.${user.id},user_high.eq.${user.id}`)
        // Bound so a heavy user doesn't push an unbounded id list into the
        // .in() below.
        .limit(500);

      if (!alive || !conversations?.length) return;

      const conversationIds = conversations.map((conversation) => conversation.id);
      const { data: messages } = await supabase
        .from("messages")
        .select("id, conversation_id, session_id, sender_id, text, created_at")
        .in("conversation_id", conversationIds)
        .neq("sender_id", user.id)
        .order("created_at", { ascending: false })
        .limit(8);

      // Drop dedupe + horizon misses BEFORE the profile batch so we don't
      // fetch names for messages we'd discard.
      const candidates = ((messages ?? []) as MessagePayload[])
        .filter(
          (message) =>
            !seenMessageIdsRef.current.has(message.id) && horizonFilter(message.created_at),
        )
        .reverse();
      if (!alive || !candidates.length) return;

      // One profiles.in(id) covering every distinct sender — instead of
      // per-message sequential round trips.
      const candidateSenderIds = Array.from(new Set(candidates.map((m) => m.sender_id))).filter(
        (id) => !senderNameCache.has(id),
      );
      if (candidateSenderIds.length) {
        const { data: senderRows } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", candidateSenderIds);
        if (!alive) return;
        for (const row of senderRows ?? []) {
          senderNameCache.set(row.id, row.full_name ?? null);
        }
      }

      for (const message of candidates) {
        enqueueMessageNotification(message, senderNameCache.get(message.sender_id) ?? null);
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
    // One channel with two .on() listeners is half the WebSocket overhead
    // of the previous two-channel setup — same payload, same handlers,
    // single subscribe handshake + heartbeat + reconnect path.
    let bellChannel: RealtimeChannel | null = null;

    try {
      bellChannel = supabase
        .channel(`notifications-bell-${user.id}-${channelSuffix}`)
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
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            // Narrow so we don't broadcast events for the user's own sent
            // messages — cuts realtime chatter on the fallback path roughly
            // in half (PERF-001 in the original audit).
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
      if (bellChannel) void supabase.removeChannel(bellChannel);
    };
    // Depend on user.id only — Supabase rotates the user object reference on
    // every auth event even when the id is unchanged, which previously tore
    // down + re-subscribed the notifications channel 2–4× per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, markMessagesSeen]);

  const clearAll = async () => {
    if (!user || notifications.length === 0) return;
    // Snapshot the state we're optimistically replacing so a failed DELETE
    // restores both UI and the two cache layers (otherwise we'd leave the
    // bell empty while the server still has every row).
    const previous = notifications;
    const previousHorizonIso = window.localStorage.getItem(clearedHorizonKey(user.id));
    // Set the horizon BEFORE deleting so any realtime DELETE callback that
    // re-runs loadNotifications sees the new horizon and filters correctly.
    // Anything created at-or-before this instant is suppressed forever on
    // this device — covers (a) DB rows that survived a failed delete and
    // (b) legacy message notifications whose metadata predates `messageId`,
    // which the seen-id set could not protect against.
    const horizonIso = new Date().toISOString();
    writeClearedHorizon(user.id, horizonIso);
    clearedHorizonRef.current = Date.parse(horizonIso);
    // Belt-and-braces: still mark every cleared message notification's
    // underlying messageId as seen, so the realtime fallback path skips
    // them without paying the timestamp comparison cost.
    markMessagesSeen(
      previous.map(getNotificationMessageId).filter((id): id is string => Boolean(id)),
    );
    setNotifications([]);
    writeFallbackNotifications(user.id, []);
    writeCachedNotifications(user.id, []);
    const { error } = await supabase.from("notifications").delete().eq("user_id", user.id);
    if (error) {
      // Roll back horizon too — if the delete didn't happen the user should
      // see their notifications return on next refresh, not stay hidden.
      if (previousHorizonIso) {
        writeClearedHorizon(user.id, previousHorizonIso);
        clearedHorizonRef.current = Date.parse(previousHorizonIso) || 0;
      } else {
        clearClearedHorizon(user.id);
        clearedHorizonRef.current = 0;
      }
      setNotifications(previous);
      writeFallbackNotifications(user.id, previous);
      writeCachedNotifications(user.id, previous);
      toast.error(error.message);
    }
  };

  const dismiss = async (notification: Notification) => {
    if (!user) return;
    const previous = notifications;
    // Mark the underlying message (whether the dismissed entry was a DB row or
    // a fallback) as seen, so the poller can't resurrect it.
    const messageId = getNotificationMessageId(notification);
    if (messageId) markMessagesSeen([messageId]);
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
        {loading && notifications.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && notifications.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No notifications yet.
          </div>
        )}
        {notifications.length > 0 && (
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
        {notifications.map((notification) => {
          const messageTarget =
            notification.type === "message" ? getMessagesLinkTarget(notification) : null;
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

          return messageTarget ? (
            <DropdownMenuItem key={notification.id} asChild>
              <Link
                to="/messages"
                search={"u" in messageTarget ? { u: messageTarget.u } : { s: messageTarget.s }}
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
