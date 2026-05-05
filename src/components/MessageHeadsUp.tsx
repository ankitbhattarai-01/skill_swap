import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageCircle, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { playMessageChime } from "@/lib/sounds";
import { cn } from "@/lib/utils";

type IncomingMessage = {
  messageId: string;
  sessionId: string;
  senderId: string;
  text: string;
  senderName: string;
  skillName: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  sender_id: string;
  text: string;
  created_at: string;
};

type SessionPreview = {
  id: string;
  learner_id: string;
  teacher_id: string;
  skills: { name: string } | null;
};

const AUTO_DISMISS_MS = 6000;
const ANIMATION_MS = 300;

export function MessageHeadsUp() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<IncomingMessage[]>([]);
  const [active, setActive] = useState<IncomingMessage | null>(null);
  const [visible, setVisible] = useState(false);
  const [hovering, setHovering] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to new chat messages for sessions the user participates in.
  useEffect(() => {
    if (!user) {
      setQueue([]);
      setActive(null);
      setVisible(false);
      seenRef.current.clear();
      return;
    }

    let alive = true;
    const controller = new AbortController();

    const enqueueMessage = async (msg: MessageRow) => {
      if (!alive || msg.sender_id === user.id || seenRef.current.has(msg.id)) return;
      seenRef.current.add(msg.id);

      const { data: session } = await supabase
        .from("sessions")
        .select("id, learner_id, teacher_id, skills:skill_id(name)")
        .eq("id", msg.session_id)
        .abortSignal(controller.signal)
        .maybeSingle();
      if (!alive || !session) return;

      const sess = session as unknown as SessionPreview;
      if (sess.learner_id !== user.id && sess.teacher_id !== user.id) return;

      const { data: sender } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", msg.sender_id)
        .abortSignal(controller.signal)
        .maybeSingle();
      if (!alive) return;

      setQueue((rs) => [
        ...rs,
        {
          messageId: msg.id,
          sessionId: msg.session_id,
          senderId: msg.sender_id,
          text: msg.text,
          senderName: sender?.full_name ?? "Someone",
          skillName: sess.skills?.name ?? null,
        },
      ]);
    };

    const channel = supabase
      .channel(`message-headsup-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `sender_id=neq.${user.id}`,
        },
        (payload) => void enqueueMessage(payload.new as MessageRow),
      )
      .subscribe();

    return () => {
      alive = false;
      controller.abort();
      void supabase.removeChannel(channel);
    };
  }, [user]);

  // Pull next from queue when nothing is active.
  useEffect(() => {
    if (active || queue.length === 0) return;
    setActive(queue[0]);
    setVisible(false);
    playMessageChime();
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [active, queue]);

  // Auto-dismiss timer.
  useEffect(() => {
    if (!active || !visible || hovering) return;
    dismissTimerRef.current = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [active, visible, hovering]);

  // Teardown after slide-out so the next queued message can take over.
  useEffect(() => {
    if (visible || !active) return;
    const dismissedId = active.messageId;
    teardownTimerRef.current = setTimeout(() => {
      setActive(null);
      setQueue((rs) => rs.filter((m) => m.messageId !== dismissedId));
    }, ANIMATION_MS);
    return () => {
      if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
    };
  }, [visible, active]);

  if (!active) return null;

  const onOpenChat = () => {
    setVisible(false);
    navigate({ to: "/messages", search: { s: active.sessionId } });
  };

  const onDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setVisible(false);
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[99] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={onOpenChat}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          "pointer-events-auto w-full max-w-sm cursor-pointer text-left transform-gpu transition-all ease-out",
          visible ? "translate-y-0 opacity-100 scale-100" : "-translate-y-4 opacity-0 scale-95",
        )}
        style={{ transitionDuration: `${ANIMATION_MS}ms` }}
      >
        <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card/95 px-3 py-2 shadow-xl backdrop-blur-md">
          <div className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-primary/10 text-primary">
            <MessageCircle className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1 text-xs leading-tight">
            <div className="truncate font-semibold text-foreground">{active.senderName}</div>
            <div className="truncate text-muted-foreground">{active.text}</div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="grid h-6 w-6 shrink-0 place-content-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </button>
    </div>
  );
}
