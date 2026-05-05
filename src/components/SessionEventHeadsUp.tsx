import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarX, CheckCircle2, HandHeart, Trophy, X, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { consumeSelfAction } from "@/lib/self-action";
import { cn } from "@/lib/utils";

type SessionEventType =
  | "session_cancelled"
  | "session_rejected"
  | "session_accepted"
  | "session_completed"
  | "session_offered";

type SessionEvent = {
  notificationId: string;
  type: SessionEventType;
  title: string;
  body: string | null;
  link: string | null;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: { sessionId?: string } | null;
};

const ANIMATION_MS = 300;
const AUTO_DISMISS_MS = 6000;

const RELEVANT_TYPES = new Set<SessionEventType>([
  "session_cancelled",
  "session_rejected",
  "session_accepted",
  "session_completed",
  "session_offered",
]);

function styleFor(type: SessionEventType) {
  switch (type) {
    case "session_cancelled":
    case "session_rejected":
      return {
        Icon: type === "session_cancelled" ? CalendarX : XCircle,
        wrap: "border-border/60 bg-card/95 text-foreground",
        icon: "bg-muted text-muted-foreground",
        dismiss: "text-muted-foreground hover:bg-accent hover:text-foreground",
      };
    case "session_accepted":
      return {
        Icon: CheckCircle2,
        wrap: "border-emerald-500/30 bg-gradient-to-r from-emerald-600/95 to-teal-600/95 text-white",
        icon: "bg-white/15",
        dismiss: "text-white/70 hover:bg-white/10 hover:text-white",
      };
    case "session_completed":
      return {
        Icon: Trophy,
        wrap: "border-amber-500/30 bg-gradient-to-r from-amber-500/95 to-orange-500/95 text-white",
        icon: "bg-white/15",
        dismiss: "text-white/70 hover:bg-white/10 hover:text-white",
      };
    case "session_offered":
      return {
        Icon: HandHeart,
        wrap: "border-white/15 bg-gradient-to-r from-brand-purple/95 to-brand-cyan/95 text-white",
        icon: "bg-white/15",
        dismiss: "text-white/70 hover:bg-white/10 hover:text-white",
      };
  }
}

export function SessionEventHeadsUp() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<SessionEvent[]>([]);
  const [active, setActive] = useState<SessionEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [hovering, setHovering] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) {
      setQueue([]);
      setActive(null);
      setVisible(false);
      seenRef.current.clear();
      return;
    }
    const channel = supabase
      .channel(`session-events-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const n = payload.new as NotificationRow;
          if (!RELEVANT_TYPES.has(n.type as SessionEventType)) return;
          if (seenRef.current.has(n.id)) return;
          seenRef.current.add(n.id);
          const sid = n.metadata?.sessionId;
          if (sid && consumeSelfAction(sid, n.type)) return;
          setQueue((rs) => [
            ...rs,
            {
              notificationId: n.id,
              type: n.type as SessionEventType,
              title: n.title,
              body: n.body,
              link: n.link,
            },
          ]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user]);

  useEffect(() => {
    if (active || queue.length === 0) return;
    setActive(queue[0]);
    setVisible(false);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [active, queue]);

  useEffect(() => {
    if (!active || !visible || hovering) return;
    dismissTimerRef.current = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [active, visible, hovering]);

  useEffect(() => {
    if (visible || !active) return;
    const dismissedId = active.notificationId;
    teardownTimerRef.current = setTimeout(() => {
      setActive(null);
      setQueue((rs) => rs.filter((e) => e.notificationId !== dismissedId));
    }, ANIMATION_MS);
    return () => {
      if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
    };
  }, [visible, active]);

  if (!active) return null;

  const s = styleFor(active.type);
  const Icon = s.Icon;

  const onClick = () => {
    setVisible(false);
    if (active.link?.startsWith("/")) {
      navigate({ to: active.link });
    }
  };
  const onDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setVisible(false);
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[98] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          "pointer-events-auto w-full max-w-sm cursor-pointer text-left transform-gpu transition-all ease-out",
          visible ? "translate-y-0 opacity-100 scale-100" : "-translate-y-4 opacity-0 scale-95",
        )}
        style={{ transitionDuration: `${ANIMATION_MS}ms` }}
      >
        <div
          className={cn(
            "flex items-center gap-2 rounded-2xl border px-3 py-2 shadow-xl backdrop-blur-md",
            s.wrap,
          )}
        >
          <div className={cn("grid h-7 w-7 shrink-0 place-content-center rounded-full", s.icon)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1 text-xs leading-tight">
            <div className="truncate font-semibold">{active.title}</div>
            {active.body && <div className="truncate opacity-90">{active.body}</div>}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "grid h-6 w-6 shrink-0 place-content-center rounded-full transition-colors",
              s.dismiss,
            )}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </button>
    </div>
  );
}
