import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/UserAvatar";
import { MessageBubble } from "@/components/MessageBubble";
import { ReportDialog } from "@/components/ReportDialog";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { signAvatarUrls } from "@/lib/avatars";
import { cn } from "@/lib/utils";
import { ArrowLeft, Loader2, MessageCircle, MessagesSquare, Search, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { describeViolations, detectViolations } from "@/lib/messageFilter";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/messages")({
  validateSearch: (s: Record<string, unknown>): { u?: string; s?: string } => ({
    u: typeof s.u === "string" && s.u.length > 0 ? s.u : undefined,
    s: typeof s.s === "string" && s.s.length > 0 ? s.s : undefined,
  }),
  head: () => ({ meta: [{ title: "Messages | SkillSwap" }] }),
  component: MessagesIndexPage,
});

type SessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  status: string;
  credits: number;
  duration_minutes: number;
  skill_name: string | null;
  created_at: string;
  scheduled_at: string | null;
};

type MessagePreview = {
  text: string;
  created_at: string;
  sender_id: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  sender_id: string | null;
  text: string;
  created_at: string;
  edited_at: string | null;
};

const HIDDEN_MESSAGES_KEY = (userId: string) => `skillswap.hidden_messages.${userId}`;
const LAST_OPENED_KEY = (userId: string) => `skillswap.last_opened.${userId}`;

function loadHiddenMessageIds(userId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_MESSAGES_KEY(userId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistHiddenMessageIds(userId: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIDDEN_MESSAGES_KEY(userId), JSON.stringify(Array.from(ids)));
  } catch {
    // ignore quota / privacy mode errors
  }
}

function loadLastOpened(userId: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAST_OPENED_KEY(userId));
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function persistLastOpened(userId: string, map: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_OPENED_KEY(userId), JSON.stringify(map));
  } catch {
    // ignore quota / privacy mode errors
  }
}

const OPEN_STATUSES = new Set(["accepted", "active"]);
const CHAT_MESSAGE_PAGE_SIZE = 50;

type ThreadItem = {
  otherUserId: string;
  otherName: string;
  otherAvatar: string | null;
  sessions: SessionRow[]; // ascending by created_at — chronological so Session 1 is oldest
  activeSession: SessionRow | null;
  latestSession: SessionRow;
  lastMessage: MessagePreview | null;
};

type FilterKey = "all" | "active" | "closed";
type RoleTab = "teaching" | "learning";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "closed", label: "Closed" },
];

function formatPreviewTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSessionDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusLabel(status: string): string {
  if (status === "accepted") return "Upcoming";
  if (status === "active") return "Active";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  if (status === "rejected") return "Rejected";
  if (status === "pending_review") return "Pending review";
  if (status === "disputed") return "Disputed";
  return status;
}

function MessagesIndexPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();

  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [roleTab, setRoleTab] = useState<RoleTab>("teaching");
  const [lastOpened, setLastOpened] = useState<Record<string, string>>({});

  const [chatMessages, setChatMessages] = useState<MessageRow[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [reportingMessageId, setReportingMessageId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const allSessionIdsRef = useRef<Set<string>>(new Set());
  const selectedRef = useRef<string | null>(null);
  const selectedSessionIdsRef = useRef<Set<string>>(new Set());

  const selectedUserId = search.u ?? null;

  useEffect(() => {
    if (!user) return;
    setHiddenIds(loadHiddenMessageIds(user.id));
    setLastOpened(loadLastOpened(user.id));
  }, [user]);

  const markOpened = useCallback(
    (otherUserId: string) => {
      if (!user) return;
      setLastOpened((prev) => {
        const next = { ...prev, [otherUserId]: new Date().toISOString() };
        persistLastOpened(user.id, next);
        return next;
      });
    },
    [user],
  );

  const hideMessageForMe = useCallback(
    (messageId: string) => {
      if (!user) return;
      setHiddenIds((prev) => {
        if (prev.has(messageId)) return prev;
        const next = new Set(prev);
        next.add(messageId);
        persistHiddenMessageIds(user.id, next);
        return next;
      });
      toast.success("Hidden from your view");
    },
    [user],
  );

  const editMessage = useCallback(async (messageId: string, nextText: string) => {
    if (messageId.startsWith("temp-")) {
      const reason = "Wait for the message to send before editing.";
      toast.error(reason);
      throw new Error(reason);
    }
    const violations = detectViolations(nextText);
    if (violations.length > 0) {
      const reason = describeViolations(violations);
      toast.error(reason);
      throw new Error(reason);
    }
    const { error } = await supabase
      .from("messages")
      .update({ text: nextText })
      .eq("id", messageId);
    if (error) {
      toast.error(error.message);
      throw error;
    }
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, text: nextText, edited_at: new Date().toISOString() } : m,
      ),
    );
  }, []);

  const unsendMessage = useCallback(async (messageId: string) => {
    if (messageId.startsWith("temp-")) {
      toast.error("Wait for the message to send before unsending.");
      return;
    }
    const { error } = await supabase.from("messages").delete().eq("id", messageId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
    toast.success("Message unsent");
  }, []);

  // Keep refs in sync with state for realtime handlers.
  useEffect(() => {
    const all = new Set<string>();
    for (const t of threads) for (const s of t.sessions) all.add(s.id);
    allSessionIdsRef.current = all;
  }, [threads]);

  useEffect(() => {
    selectedRef.current = selectedUserId;
  }, [selectedUserId]);

  useEffect(() => {
    document.body.classList.add("messages-page-open");
    return () => {
      document.body.classList.remove("messages-page-open");
    };
  }, []);

  // Mobile viewport adjustments — unchanged from earlier.
  useEffect(() => {
    document.body.classList.toggle("messages-chat-open", Boolean(selectedUserId));
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const syncMobileViewport = () => {
      if (!selectedUserId || !viewport || window.matchMedia("(min-width: 768px)").matches) {
        root.style.removeProperty("--mobile-chat-height");
        root.style.removeProperty("--mobile-chat-top");
        return;
      }
      root.style.setProperty("--mobile-chat-height", `${viewport.height}px`);
      root.style.setProperty("--mobile-chat-top", `${viewport.offsetTop}px`);
    };

    syncMobileViewport();
    viewport?.addEventListener("resize", syncMobileViewport);
    viewport?.addEventListener("scroll", syncMobileViewport);
    window.addEventListener("orientationchange", syncMobileViewport);

    return () => {
      document.body.classList.remove("messages-chat-open");
      viewport?.removeEventListener("resize", syncMobileViewport);
      viewport?.removeEventListener("scroll", syncMobileViewport);
      window.removeEventListener("orientationchange", syncMobileViewport);
      root.style.removeProperty("--mobile-chat-height");
      root.style.removeProperty("--mobile-chat-top");
    };
  }, [selectedUserId]);

  // Auth gate
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/messages" } });
    }
  }, [authLoading, navigate, user]);

  // Load threads: fetch sessions, group by other user, hydrate avatars + last message.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const controller = new AbortController();

    (async () => {
      setLoadingList(true);

      try {
        const { data: sessionsData } = await supabase
          .from("sessions")
          .select(
            "id, learner_id, teacher_id, status, credits, duration_minutes, created_at, scheduled_at, skills:skill_id(name)",
          )
          .or(`learner_id.eq.${user.id},teacher_id.eq.${user.id}`)
          .neq("status", "pending")
          .order("updated_at", { ascending: false })
          .limit(100)
          .abortSignal(controller.signal);

        if (!alive) return;

        // Fetched newest-activity-first so the inbox is bounded to 100 rows;
        // flip back to chronological so the thread-grouping logic below (which
        // treats sessions[last] as the latest) still works.
        const rawSessions = (
          (sessionsData ?? []) as unknown as Array<
            Omit<SessionRow, "skill_name"> & { skills: { name: string } | null }
          >
        )
          .slice()
          .reverse();

        const sessionsByOther = new Map<string, SessionRow[]>();
        for (const s of rawSessions) {
          const otherUserId = s.learner_id === user.id ? s.teacher_id : s.learner_id;
          if (!otherUserId) continue;
          const row: SessionRow = {
            id: s.id,
            learner_id: s.learner_id,
            teacher_id: s.teacher_id,
            status: s.status,
            credits: s.credits,
            duration_minutes: s.duration_minutes,
            created_at: s.created_at,
            scheduled_at: s.scheduled_at,
            skill_name: s.skills?.name ?? null,
          };
          const arr = sessionsByOther.get(otherUserId) ?? [];
          arr.push(row);
          sessionsByOther.set(otherUserId, arr);
        }

        const otherUserIds = Array.from(sessionsByOther.keys());
        const profileMap = new Map<
          string,
          { full_name: string | null; avatar_url: string | null }
        >();
        const avatarPaths: (string | null)[] = [];
        if (otherUserIds.length) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("id, full_name, avatar_url")
            .in("id", otherUserIds)
            .abortSignal(controller.signal);
          for (const p of profiles ?? []) {
            profileMap.set(p.id, { full_name: p.full_name, avatar_url: p.avatar_url });
            avatarPaths.push(p.avatar_url);
          }
        }

        const baseThreads: ThreadItem[] = otherUserIds.map((otherUserId) => {
          const sessions = (sessionsByOther.get(otherUserId) ?? []).slice();
          const activeSession =
            [...sessions].reverse().find((s) => OPEN_STATUSES.has(s.status)) ?? null;
          const latestSession = sessions[sessions.length - 1];
          const profile = profileMap.get(otherUserId);
          const trimmedName = profile?.full_name?.trim();
          const idFragment =
            typeof otherUserId === "string" && otherUserId.length > 0
              ? otherUserId.slice(0, 4)
              : "anon";
          return {
            otherUserId,
            otherName: trimmedName || `User ${idFragment}`,
            otherAvatar: null,
            sessions,
            activeSession,
            latestSession,
            lastMessage: null,
          };
        });

        if (!alive) return;
        setThreads(baseThreads);
        setLoadingList(false);

        const allSessionIds = rawSessions.map((s) => s.id);
        const [avatarResult, messageResult] = await Promise.allSettled([
          signAvatarUrls(avatarPaths),
          allSessionIds.length
            ? supabase
                .from("messages")
                .select("id, session_id, sender_id, text, created_at")
                .in("session_id", allSessionIds)
                .order("created_at", { ascending: false })
                // Sidebar preview cap only — the active thread has its own paginated query.
                .limit(Math.min(allSessionIds.length * 5, 200))
                .abortSignal(controller.signal)
            : Promise.resolve({ data: [] }),
        ]);
        if (!alive) return;

        const signedAvatarMap =
          avatarResult.status === "fulfilled" ? avatarResult.value : new Map<string, string>();

        // Map: sessionId → latest message (used to find each thread's last message).
        const lastMsgBySession = new Map<string, MessagePreview>();
        const msgs = messageResult.status === "fulfilled" ? (messageResult.value.data ?? []) : [];
        for (const m of msgs) {
          if (!lastMsgBySession.has(m.session_id)) {
            lastMsgBySession.set(m.session_id, {
              text: m.text,
              created_at: m.created_at,
              sender_id: m.sender_id,
            });
          }
        }

        const hydrated = baseThreads.map((t) => {
          const profile = profileMap.get(t.otherUserId);
          let last: MessagePreview | null = null;
          for (const s of t.sessions) {
            const m = lastMsgBySession.get(s.id);
            if (m && (!last || m.created_at > last.created_at)) last = m;
          }
          return {
            ...t,
            otherAvatar: profile?.avatar_url
              ? (signedAvatarMap.get(profile.avatar_url) ?? null)
              : null,
            lastMessage: last,
          };
        });

        hydrated.sort((a, b) =>
          (b.lastMessage?.created_at ?? b.latestSession.created_at).localeCompare(
            a.lastMessage?.created_at ?? a.latestSession.created_at,
          ),
        );
        setThreads(hydrated);
      } catch (error) {
        if (!alive) return;
        if (error instanceof Error && error.name === "AbortError") return;
        setThreads([]);
        setLoadingList(false);
        toast.error(error instanceof Error ? error.message : "Could not load messages");
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [user]);

  // Backwards-compat: if a deep link arrives as ?s=<sessionId>, resolve to ?u=<otherUserId>.
  useEffect(() => {
    if (!user || !search.s) return;
    if (search.u) return;
    const found = threads.find((t) => t.sessions.some((s) => s.id === search.s));
    if (found) {
      void navigate({
        to: "/messages",
        search: { u: found.otherUserId },
        replace: true,
      });
    }
  }, [user, search.s, search.u, threads, navigate]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.otherUserId === selectedUserId) ?? null,
    [threads, selectedUserId],
  );

  // Track session IDs of selected thread for realtime routing.
  useEffect(() => {
    selectedSessionIdsRef.current = new Set(selectedThread?.sessions.map((s) => s.id) ?? []);
  }, [selectedThread]);

  // Auto-switch tab to where the selected thread lives.
  useEffect(() => {
    if (!selectedThread || !user) return;
    const tab: RoleTab =
      selectedThread.latestSession.teacher_id === user.id ? "teaching" : "learning";
    setRoleTab((prev) => (prev === tab ? prev : tab));
  }, [selectedThread, user]);

  // Pagination state for the chat scroller. hasMoreMessages tracks whether
  // a prior fetch returned a full page (=> there may be more) or fewer rows
  // (=> we've reached the start of the thread).
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // Stable key over the selected thread's session IDs. Depending on this
  // (instead of the whole `selectedThread` object) keeps the chat-load effect
  // from refiring when only `lastMessage` updates — otherwise every realtime
  // INSERT would re-sort threads, hand us a new `selectedThread` reference,
  // and trigger a skeleton-flicker + scroll-reset on every send.
  const selectedSessionIdsKey = useMemo(() => {
    if (!selectedThread) return "";
    return selectedThread.sessions.map((s) => s.id).join(",");
  }, [selectedThread]);

  // Load chat: most-recent page of messages across all sessions in the
  // selected thread. Older pages arrive via loadEarlierMessages below.
  useEffect(() => {
    if (!selectedUserId || !user) {
      setChatMessages([]);
      setHasMoreMessages(false);
      return;
    }
    const sessionIds = selectedSessionIdsKey ? selectedSessionIdsKey.split(",") : [];
    if (sessionIds.length === 0) {
      setChatMessages([]);
      setHasMoreMessages(false);
      return;
    }
    markOpened(selectedUserId);
    let alive = true;
    const controller = new AbortController();

    (async () => {
      setChatLoading(true);
      setHasMoreMessages(false);
      const { data, error } = await supabase
        .from("messages")
        .select("id, session_id, sender_id, text, created_at, edited_at")
        .in("session_id", sessionIds)
        .order("created_at", { ascending: false })
        .limit(CHAT_MESSAGE_PAGE_SIZE)
        .abortSignal(controller.signal);
      if (!alive) return;
      if (error) {
        toast.error(error.message);
        setChatMessages([]);
        setHasMoreMessages(false);
      } else {
        const rows = (data ?? []) as MessageRow[];
        // Fetched newest-first for the page cap, then reverse to keep chronological render.
        setChatMessages(rows.slice().reverse());
        // A full-page response means there may be older rows beyond this page.
        setHasMoreMessages(rows.length >= CHAT_MESSAGE_PAGE_SIZE);
      }
      setChatLoading(false);
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [selectedUserId, selectedSessionIdsKey, user, markOpened]);

  // Cursor-paginated fetch for older messages. Uses the oldest currently-
  // loaded created_at as the cursor and prepends the returned page. Dedup
  // by id keeps this safe against a realtime INSERT that races with the
  // older-page fetch on the boundary.
  const loadEarlierMessages = useCallback(async () => {
    if (!selectedThread || !user || loadingEarlier || !hasMoreMessages) return;
    const sessionIds = selectedThread.sessions.map((s) => s.id);
    if (sessionIds.length === 0) return;
    const oldest = chatMessages[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    const { data, error } = await supabase
      .from("messages")
      .select("id, session_id, sender_id, text, created_at, edited_at")
      .in("session_id", sessionIds)
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: false })
      .limit(CHAT_MESSAGE_PAGE_SIZE);
    setLoadingEarlier(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const rows = (data ?? []) as MessageRow[];
    setHasMoreMessages(rows.length >= CHAT_MESSAGE_PAGE_SIZE);
    if (rows.length === 0) return;
    const earlier = rows.slice().reverse();
    setChatMessages((prev) => {
      const existing = new Set(prev.map((m) => m.id));
      const merged = [...earlier.filter((m) => !existing.has(m.id)), ...prev];
      return merged;
    });
  }, [chatMessages, hasMoreMessages, loadingEarlier, selectedThread, user]);

  // Stable key over the user's session IDs. Drives realtime channel resub.
  const sessionIdsKey = useMemo(() => {
    const all: string[] = [];
    for (const t of threads) for (const s of t.sessions) all.push(s.id);
    return all.sort().join(",");
  }, [threads]);

  useEffect(() => {
    if (!user) return;
    if (!sessionIdsKey) return;
    const filter = `session_id=in.(${sessionIdsKey})`;
    const channel = supabase
      .channel(`user-messages-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter },
        (payload) => {
          const msg = payload.new as MessageRow;
          if (!allSessionIdsRef.current.has(msg.session_id)) return;

          setThreads((prev) => {
            const next = prev.map((t) => {
              if (!t.sessions.some((s) => s.id === msg.session_id)) return t;
              return {
                ...t,
                lastMessage: {
                  text: msg.text,
                  created_at: msg.created_at,
                  sender_id: msg.sender_id,
                },
              };
            });
            next.sort((a, b) =>
              (b.lastMessage?.created_at ?? b.latestSession.created_at).localeCompare(
                a.lastMessage?.created_at ?? a.latestSession.created_at,
              ),
            );
            return next;
          });

          if (selectedSessionIdsRef.current.has(msg.session_id)) {
            setChatMessages((prev) => {
              // Already present by real id → echo is a duplicate, no-op.
              if (prev.some((m) => m.id === msg.id)) return prev;
              // Locate an optimistic temp- row for the same session/sender/text
              // within a 30-second window of the echo. If present, replace it
              // so the bubble's id flips from temp- → real and any subsequent
              // edit/unsend actions hit the right row.
              const echoMs = Date.parse(msg.created_at);
              const tempIndex = prev.findIndex(
                (m) =>
                  m.id.startsWith("temp-") &&
                  m.session_id === msg.session_id &&
                  m.sender_id === msg.sender_id &&
                  m.text === msg.text &&
                  Math.abs(Date.parse(m.created_at) - echoMs) < 30_000,
              );
              if (tempIndex >= 0) {
                const next = prev.slice();
                next[tempIndex] = msg;
                return next;
              }
              return [...prev, msg];
            });
            if (selectedRef.current) markOpened(selectedRef.current);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter },
        (payload) => {
          const msg = payload.new as MessageRow;
          if (!allSessionIdsRef.current.has(msg.session_id)) return;

          if (selectedSessionIdsRef.current.has(msg.session_id)) {
            setChatMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
          }

          setThreads((prev) =>
            prev.map((t) => {
              if (!t.sessions.some((s) => s.id === msg.session_id)) return t;
              if (t.lastMessage && t.lastMessage.created_at === msg.created_at) {
                return {
                  ...t,
                  lastMessage: {
                    text: msg.text,
                    created_at: msg.created_at,
                    sender_id: msg.sender_id,
                  },
                };
              }
              return t;
            }),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages", filter },
        (payload) => {
          const old = payload.old as Partial<MessageRow>;
          if (!old.id) return;
          if (old.session_id && !allSessionIdsRef.current.has(old.session_id)) return;
          if (old.session_id && selectedSessionIdsRef.current.has(old.session_id)) {
            setChatMessages((prev) => prev.filter((m) => m.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, sessionIdsKey, markOpened]);

  useEffect(() => {
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [chatMessages.length]);

  useEffect(() => {
    if (!selectedUserId) return;
    window.setTimeout(() => {
      const scroller = messageScrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, 0);
  }, [selectedUserId]);

  const isUnread = useCallback(
    (t: ThreadItem) => {
      if (!user || !t.lastMessage) return false;
      if (t.lastMessage.sender_id === user.id) return false;
      const opened = lastOpened[t.otherUserId];
      if (!opened) return true;
      return t.lastMessage.created_at > opened;
    },
    [lastOpened, user],
  );

  const teachingThreads = useMemo(
    () => threads.filter((t) => t.latestSession.teacher_id === user?.id),
    [threads, user],
  );
  const learningThreads = useMemo(
    () => threads.filter((t) => t.latestSession.learner_id === user?.id),
    [threads, user],
  );

  const teachingUnread = useMemo(
    () => teachingThreads.filter(isUnread).length,
    [teachingThreads, isUnread],
  );
  const learningUnread = useMemo(
    () => learningThreads.filter(isUnread).length,
    [learningThreads, isUnread],
  );

  const filtered = useMemo(() => {
    let list = roleTab === "teaching" ? teachingThreads : learningThreads;
    if (filter === "active") list = list.filter((t) => t.activeSession !== null);
    else if (filter === "closed") list = list.filter((t) => t.activeSession === null);
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter(
      (t) =>
        t.otherName.toLowerCase().includes(q) ||
        t.sessions.some((s) => s.skill_name?.toLowerCase().includes(q)) ||
        t.lastMessage?.text.toLowerCase().includes(q),
    );
  }, [teachingThreads, learningThreads, roleTab, query, filter]);

  const visibleChatMessages = useMemo(
    () => chatMessages.filter((m) => !hiddenIds.has(m.id)),
    [chatMessages, hiddenIds],
  );

  // Map session ID → its 1-based index within the selected thread (for divider labels).
  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!selectedThread) return map;
    selectedThread.sessions.forEach((s, i) => map.set(s.id, i + 1));
    return map;
  }, [selectedThread]);

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionRow>();
    if (!selectedThread) return map;
    for (const s of selectedThread.sessions) map.set(s.id, s);
    return map;
  }, [selectedThread]);

  const reportingSessionId = useMemo(() => {
    if (!reportingMessageId) return null;
    const msg = chatMessages.find((m) => m.id === reportingMessageId);
    return msg?.session_id ?? null;
  }, [reportingMessageId, chatMessages]);

  const sendMessage = async () => {
    if (!user || !selectedThread || !text.trim()) return;
    const active = selectedThread.activeSession;
    if (!active) {
      toast.error("No active session. Book one to keep chatting.");
      return;
    }
    const trimmed = text.trim();
    const violations = detectViolations(trimmed);
    if (violations.length > 0) {
      toast.error(describeViolations(violations));
      return;
    }
    // Optimistic insert: paint the bubble before the DB round-trip so the
    // chat feels instant. The temp id is replaced when the realtime echo
    // arrives (see the INSERT handler above, which matches temp rows by
    // session_id + sender_id + text + created_at).
    const tempId = `temp-${
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }`;
    const optimisticCreatedAt = new Date().toISOString();
    const optimisticRow: MessageRow = {
      id: tempId,
      session_id: active.id,
      sender_id: user.id,
      text: trimmed,
      created_at: optimisticCreatedAt,
      edited_at: null,
    };
    setChatMessages((prev) => [...prev, optimisticRow]);
    setText("");
    if (composerRef.current) {
      composerRef.current.style.height = "auto";
    }
    setSending(true);
    const { data, error } = await supabase
      .from("messages")
      .insert({
        session_id: active.id,
        sender_id: user.id,
        text: trimmed,
      })
      .select("id, session_id, sender_id, text, created_at, edited_at")
      .single();
    setSending(false);
    if (error) {
      // Roll back the optimistic row and restore the composer text so the
      // user can retry without retyping.
      setChatMessages((prev) => prev.filter((m) => m.id !== tempId));
      setText(trimmed);
      toast.error(error.message);
      return;
    }
    // Server confirmed — replace the temp row with the persisted one if the
    // realtime echo hasn't already done so.
    const persisted = (data ?? null) as MessageRow | null;
    if (persisted) {
      setChatMessages((prev) => {
        if (prev.some((m) => m.id === persisted.id)) {
          return prev.filter((m) => m.id !== tempId);
        }
        return prev.map((m) => (m.id === tempId ? persisted : m));
      });
    }
  };

  const selectThread = (otherUserId: string | null) => {
    void navigate({ to: "/messages", search: { u: otherUserId ?? undefined } });
  };

  if (authLoading || (loadingList && threads.length === 0)) {
    return <PageLoading variant="messages" />;
  }
  // Auth resolved but no user — the redirect effect is about to fire.
  // Without this gate, the empty messages shell would render for a tick
  // before /login takes over.
  if (!user) return null;

  const activeSession = selectedThread?.activeSession ?? null;
  const headerSession = activeSession ?? selectedThread?.latestSession ?? null;
  const headerTeaching = headerSession?.teacher_id === user?.id;

  return (
    <div className="flex h-[calc(100dvh_-_118px_-_6rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] min-h-[32rem] flex-col overflow-hidden md:h-[calc(100dvh_-_6rem)] md:min-h-[36rem]">
      <main
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6",
          selectedUserId &&
            "mobile-chat-shell max-md:z-50 max-md:!m-0 max-md:!max-w-none max-md:overflow-hidden max-md:!p-0 max-md:bg-background",
        )}
      >
        <div
          className={cn(
            "glass flex min-h-0 flex-1 overflow-hidden md:rounded-3xl",
            selectedUserId
              ? "h-full rounded-none border-0 shadow-none md:rounded-3xl md:border md:shadow-card"
              : "rounded-3xl",
          )}
        >
          {/* INBOX PANE */}
          <aside
            className={cn(
              "w-full md:w-[360px] md:shrink-0 md:border-r border-border/60 flex-col bg-muted/30 dark:bg-background/40",
              selectedUserId ? "hidden md:flex" : "flex",
            )}
          >
            <div className="animate-fade-up relative overflow-hidden border-b border-border/60 px-5 pt-5 pb-4">
              <div className="absolute inset-0 gradient-hero pointer-events-none opacity-70 dark:hidden" />
              <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
              <div className="relative flex items-start gap-3">
                <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 ring-1 ring-brand-purple/25 transition-transform hover:scale-105">
                  <MessagesSquare className="h-5 w-5 text-brand-purple" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-2xl font-bold tracking-tight">
                    <span className="gradient-brand-text">Messages</span>
                  </h1>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Your skill swap conversations
                  </p>
                </div>
              </div>
            </div>

            <div
              className="animate-fade-up px-4 pt-3 pb-2 grid grid-cols-2 gap-2"
              style={{ animationDelay: "60ms" }}
            >
              {(
                [
                  { key: "teaching", label: "Teaching", unread: teachingUnread },
                  { key: "learning", label: "Learning", unread: learningUnread },
                ] as { key: RoleTab; label: string; unread: number }[]
              ).map((t) => {
                const active = roleTab === t.key;
                const activeClass =
                  t.key === "teaching"
                    ? "border-brand-cyan/40 bg-brand-cyan/15 text-brand-cyan shadow-glow-blue"
                    : "border-brand-purple/40 bg-brand-purple/15 text-brand-purple shadow-glow";
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setRoleTab(t.key)}
                    className={cn(
                      "relative inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all duration-200 active:scale-95",
                      active
                        ? activeClass
                        : "border-white/10 bg-white/5 text-muted-foreground hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10 hover:text-foreground",
                    )}
                  >
                    <span>{t.label}</span>
                    {t.unread > 0 && (
                      <span
                        className={cn(
                          "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold",
                          active
                            ? "bg-white/15 text-current"
                            : "bg-brand-purple/25 text-brand-purple",
                        )}
                      >
                        {t.unread > 99 ? "99+" : t.unread}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="animate-fade-up px-4 pb-3" style={{ animationDelay: "120ms" }}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, skill, or message"
                  className="glass h-10 rounded-full border-white/10 pl-9 transition-all focus-visible:border-brand-purple/40"
                />
              </div>
            </div>

            <div
              className="animate-fade-up flex flex-wrap gap-1.5 px-4 pb-3"
              style={{ animationDelay: "180ms" }}
            >
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-all duration-200 active:scale-95",
                    filter === f.key
                      ? "border-brand-purple/40 bg-brand-purple/15 text-brand-purple"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10 hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-1">
              {filtered.length === 0 ? (
                <div
                  className="animate-fade-up mx-2 mt-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center text-sm text-muted-foreground"
                  style={{ animationDelay: "240ms" }}
                >
                  {query || filter !== "all" ? (
                    "No matches"
                  ) : (
                    <>
                      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-purple/15">
                        <MessageCircle className="h-5 w-5 text-brand-purple" />
                      </div>
                      <div>No conversations yet.</div>
                      <div className="mt-1 text-xs">
                        Accept a session request to start chatting.
                      </div>
                    </>
                  )}
                </div>
              ) : (
                filtered.map((t, idx) => {
                  const isSelected = t.otherUserId === selectedUserId;
                  const unread = isUnread(t);
                  const subline = t.activeSession
                    ? `Active: ${t.activeSession.skill_name ?? "skill"} · ${t.activeSession.duration_minutes} min`
                    : `Last: ${t.latestSession.skill_name ?? "skill"} · ${statusLabel(t.latestSession.status)}`;
                  const previewMine = t.lastMessage?.sender_id === user?.id;
                  const messagePreview = t.lastMessage
                    ? `${previewMine ? "You: " : ""}${t.lastMessage.text}`
                    : `${t.sessions.length} session${t.sessions.length === 1 ? "" : "s"} · no messages yet`;
                  return (
                    <button
                      key={t.otherUserId}
                      onClick={() => selectThread(t.otherUserId)}
                      style={{ animationDelay: `${240 + Math.min(idx, 9) * 30}ms` }}
                      className={cn(
                        "animate-fade-up group my-1 flex w-full items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.98]",
                        isSelected
                          ? "border-brand-purple/30 bg-brand-purple/10 shadow-glow"
                          : "hover:-translate-y-0.5 hover:border-white/10 hover:bg-white/[0.04]",
                      )}
                    >
                      <UserAvatar
                        name={t.otherName}
                        url={t.otherAvatar}
                        className="h-11 w-11 shrink-0 ring-1 ring-white/10 transition-all group-hover:scale-105 group-hover:ring-white/20"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={cn(
                                "truncate text-sm",
                                unread ? "font-bold text-foreground" : "font-semibold",
                              )}
                            >
                              {t.otherName}
                            </span>
                            {unread && (
                              <span className="h-2 w-2 shrink-0 rounded-full bg-brand-purple shadow-glow" />
                            )}
                          </div>
                          {t.lastMessage && (
                            <span
                              className={cn(
                                "shrink-0 text-[11px]",
                                unread
                                  ? "font-semibold text-brand-purple"
                                  : "text-muted-foreground",
                              )}
                            >
                              {formatPreviewTime(t.lastMessage.created_at)}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground/80">
                          {subline}
                        </div>
                        <div
                          className={cn(
                            "truncate text-xs",
                            unread ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {messagePreview}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* CHAT PANE */}
          <section
            className={cn(
              "h-full min-h-0 flex-1 flex-col min-w-0 bg-background/80 md:bg-transparent",
              selectedUserId ? "flex" : "hidden md:flex",
            )}
          >
            {selectedThread ? (
              <>
                <div
                  key={selectedThread.otherUserId}
                  className="animate-fade-up relative sticky top-0 z-10 flex shrink-0 items-center gap-3 overflow-hidden border-b border-white/10 bg-background/95 px-3 py-3 backdrop-blur-xl sm:px-5 md:bg-background/40"
                >
                  <div className="absolute inset-0 gradient-hero pointer-events-none opacity-60 dark:hidden" />
                  <div className="absolute inset-0 bg-[radial-gradient(at_90%_50%,rgba(167,139,250,0.14),transparent_60%)] pointer-events-none dark:hidden" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative -ml-1 h-10 w-10 rounded-full transition-transform hover:-translate-x-0.5 active:scale-95 md:hidden"
                    onClick={() => selectThread(null)}
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <UserAvatar
                    name={selectedThread.otherName}
                    url={selectedThread.otherAvatar}
                    className="relative h-11 w-11 shrink-0 ring-2 ring-white/10 transition-transform hover:scale-105"
                  />
                  <div className="relative min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold">{selectedThread.otherName}</span>
                      {headerSession && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1",
                            headerTeaching
                              ? "bg-brand-cyan/15 text-brand-cyan ring-brand-cyan/30"
                              : "bg-brand-purple/15 text-brand-purple ring-brand-purple/30",
                          )}
                        >
                          {headerTeaching ? "Teaching" : "Learning"}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {activeSession
                        ? `${activeSession.skill_name ?? "Skill"} · ${activeSession.duration_minutes} min · ${statusLabel(activeSession.status)}`
                        : `${selectedThread.sessions.length} session${selectedThread.sessions.length === 1 ? "" : "s"} · no active session`}
                    </div>
                  </div>
                </div>

                <div
                  ref={messageScrollerRef}
                  className="mobile-message-scroll min-h-0 flex-1 basis-0 space-y-3 overflow-y-scroll bg-gradient-to-b from-background to-secondary/25 p-4 sm:p-5 md:bg-none"
                >
                  {chatLoading ? (
                    <ChatBubbleSkeletons />
                  ) : visibleChatMessages.length === 0 ? (
                    <div className="text-center text-sm text-muted-foreground py-12">
                      {chatMessages.length === 0
                        ? "No messages yet. Say hi!"
                        : "All messages in this chat are hidden from your view."}
                    </div>
                  ) : (
                    <>
                      {hasMoreMessages && (
                        <div className="animate-fade-up flex justify-center py-2">
                          <button
                            type="button"
                            onClick={() => void loadEarlierMessages()}
                            disabled={loadingEarlier}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-purple/30 hover:bg-brand-purple/10 hover:text-brand-purple active:scale-95 disabled:opacity-60 disabled:hover:translate-y-0"
                          >
                            {loadingEarlier && <Loader2 className="h-3 w-3 animate-spin" />}
                            Load earlier messages
                          </button>
                        </div>
                      )}
                      {visibleChatMessages.map((msg, idx) => {
                        const mine = msg.sender_id === user?.id;
                        const prev = visibleChatMessages[idx - 1];
                        const isFirstOfRun = !prev || prev.sender_id !== msg.sender_id;
                        const showDivider = !prev || prev.session_id !== msg.session_id;
                        const session = sessionById.get(msg.session_id);
                        const sessionIdx = sessionIndexMap.get(msg.session_id);
                        return (
                          <Fragment key={msg.id}>
                            {showDivider && session && (
                              <div className="flex select-none items-center gap-3 py-2">
                                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                                  Session {sessionIdx ?? "?"} · {session.skill_name ?? "Skill"} ·{" "}
                                  {formatSessionDate(session.scheduled_at ?? session.created_at)} ·{" "}
                                  {statusLabel(session.status)}
                                </span>
                                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/15 to-transparent" />
                              </div>
                            )}
                            <MessageBubble
                              message={msg}
                              mine={mine}
                              otherName={selectedThread.otherName}
                              otherAvatar={selectedThread.otherAvatar}
                              showAvatar={!mine && (isFirstOfRun || showDivider)}
                              onEdit={editMessage}
                              onUnsend={unsendMessage}
                              onDeleteForMe={hideMessageForMe}
                              onReport={setReportingMessageId}
                            />
                          </Fragment>
                        );
                      })}
                    </>
                  )}
                  <div ref={bottomRef} />
                </div>

                {activeSession ? (
                  <form
                    data-mobile-message-composer
                    className="animate-fade-up sticky bottom-0 flex shrink-0 items-end gap-2 border-t border-border/60 bg-background/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur-xl sm:p-4 md:bg-background/40"
                    style={{ animationDelay: "80ms" }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendMessage();
                    }}
                  >
                    <textarea
                      ref={composerRef}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                      placeholder={`Message about ${activeSession.skill_name ?? "the session"}...`}
                      rows={1}
                      className="glass min-h-[2.75rem] max-h-40 min-w-0 flex-1 resize-none rounded-2xl border border-white/10 px-4 py-2.5 text-sm leading-relaxed outline-none transition-all focus-visible:border-brand-purple/40 focus-visible:ring-2 focus-visible:ring-brand-purple/30"
                    />
                    <Button
                      variant="hero"
                      type="submit"
                      size="icon"
                      className="h-11 w-11 shrink-0 rounded-full transition-all duration-200 hover:scale-105 hover:shadow-glow active:scale-95 disabled:opacity-50 disabled:hover:scale-100 disabled:hover:shadow-none"
                      disabled={sending || !text.trim()}
                    >
                      {sending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                      )}
                    </Button>
                  </form>
                ) : (
                  <div
                    data-mobile-message-composer
                    className="animate-fade-up sticky bottom-0 shrink-0 border-t border-white/10 bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-sm text-muted-foreground backdrop-blur-xl md:bg-background/40"
                    style={{ animationDelay: "80ms" }}
                  >
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-400">
                      Read-only
                    </span>
                    <span className="ml-2">
                      No active session. Book another session with{" "}
                      <span className="font-medium text-foreground/80">
                        {selectedThread.otherName}
                      </span>{" "}
                      to keep the conversation going.
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="relative flex flex-1 items-center justify-center overflow-hidden p-10 text-center">
                <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
                <div className="absolute inset-0 bg-[radial-gradient(at_50%_30%,rgba(167,139,250,0.18),transparent_60%)] pointer-events-none dark:hidden" />
                <div className="relative">
                  <div className="animate-fade-up mx-auto mb-5 inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-brand-purple/15 ring-1 ring-brand-purple/25 shadow-glow transition-transform hover:scale-105">
                    <MessageCircle className="h-9 w-9 text-brand-purple" />
                  </div>
                  <h2
                    className="animate-fade-up text-2xl font-bold tracking-tight"
                    style={{ animationDelay: "80ms" }}
                  >
                    Select a <span className="gradient-brand-text">conversation</span>
                  </h2>
                  <p
                    className="animate-fade-up mx-auto mt-2 max-w-sm text-sm text-muted-foreground"
                    style={{ animationDelay: "160ms" }}
                  >
                    Pick a chat from the inbox to keep your skill swaps moving. Conversations appear
                    here once a session request is accepted.
                  </p>
                  <div
                    className="animate-fade-up mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground"
                    style={{ animationDelay: "240ms" }}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-brand-purple" />
                    Tip: switch between Teaching and Learning above
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      {selectedThread && (
        <ReportDialog
          open={reportingMessageId !== null}
          onOpenChange={(next) => {
            if (!next) setReportingMessageId(null);
          }}
          messageId={reportingMessageId}
          sessionId={reportingSessionId ?? selectedThread.latestSession.id}
          reportedUserId={selectedThread.otherUserId}
        />
      )}
    </div>
  );
}

function ChatBubbleSkeletons() {
  // Six alternating bubble placeholders so opening a thread never shows a
  // centered spinner — the chat pane keeps a consistent message-list shape.
  return (
    <>
      <div className="flex justify-end">
        <Skeleton className="h-12 w-2/5 rounded-2xl" />
      </div>
      <div className="flex items-end gap-2">
        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
        <Skeleton className="h-12 w-1/2 rounded-2xl" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-16 w-3/5 rounded-2xl" />
      </div>
      <div className="flex items-end gap-2">
        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
        <Skeleton className="h-14 w-2/5 rounded-2xl" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/3 rounded-2xl" />
      </div>
      <div className="flex items-end gap-2">
        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
        <Skeleton className="h-12 w-1/2 rounded-2xl" />
      </div>
    </>
  );
}
