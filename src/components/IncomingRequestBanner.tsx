import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { createVideoRoom } from "@/lib/jitsi";
import { toastError } from "@/lib/errors";
import { markSelfAction } from "@/lib/self-action";
import { cn } from "@/lib/utils";
import { useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";

type IncomingRequest = {
  id: string;
  learner_id: string;
  credits: number;
  duration_minutes: number;
  scheduled_at: string | null;
  skill_name: string;
  learner_name: string;
};

type RawRow = {
  id: string;
  learner_id: string;
  credits: number;
  duration_minutes: number;
  scheduled_at: string | null;
  skills: { name: string } | null;
};

// learner_id FK references auth.users not public.profiles, so the learner
// name can't be embedded via the `profiles:learner_id(full_name)` hint —
// PostgREST can't find a direct relationship and the whole query errors
// silently. Fetch sessions, then fetch the learner profiles in one extra
// round trip.
const SELECT = "id, learner_id, credits, duration_minutes, scheduled_at, skills:skill_id(name)";

const AUTO_DISMISS_MS = 8000;
const ANIMATION_MS = 300;

async function hydrateRequests(rows: RawRow[]): Promise<IncomingRequest[]> {
  const learnerIds = Array.from(new Set(rows.map((r) => r.learner_id)));
  const nameByLearner = new Map<string, string>();
  if (learnerIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", learnerIds);
    for (const profile of profiles ?? []) {
      if (profile.full_name) nameByLearner.set(profile.id, profile.full_name);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    learner_id: row.learner_id,
    credits: row.credits,
    duration_minutes: row.duration_minutes,
    scheduled_at: row.scheduled_at,
    skill_name: row.skills?.name ?? "Skill",
    learner_name: nameByLearner.get(row.learner_id) ?? "Someone",
  }));
}

export function IncomingRequestBanner() {
  const { user } = useAuth();
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  // The queue of pending requests, newest first. Dismissed IDs are removed
  // from this queue locally so they don't reappear during the same session.
  const [queue, setQueue] = useState<IncomingRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // The active request is the one currently being shown / animating. We
  // keep it in its own state so we can render it through its slide-out
  // animation even after it leaves the queue.
  const [active, setActive] = useState<IncomingRequest | null>(null);
  const [visible, setVisible] = useState(false);
  const [hovering, setHovering] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load + subscribe.
  useEffect(() => {
    if (!user) {
      setQueue([]);
      setActive(null);
      setVisible(false);
      return;
    }

    let alive = true;
    const controller = new AbortController();

    const fetchPending = async () => {
      const { data, error } = await supabase
        .from("sessions")
        .select(SELECT)
        .eq("teacher_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50)
        .abortSignal(controller.signal);
      if (!alive || error) return;
      const hydrated = await hydrateRequests((data ?? []) as unknown as RawRow[]);
      if (!alive) return;
      setQueue(hydrated);
    };

    void fetchPending();

    const channel = supabase
      .channel(`incoming-requests-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sessions",
          filter: `teacher_id=eq.${user.id}`,
        },
        (payload) => {
          if ((payload.new as { status?: string }).status === "pending") {
            void fetchPending();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sessions",
          filter: `teacher_id=eq.${user.id}`,
        },
        (payload) => {
          const next = payload.new as { id: string; status: string };
          if (next.status !== "pending") {
            setQueue((rs) => rs.filter((r) => r.id !== next.id));
            // If the currently-shown one was acted on elsewhere, dismiss it.
            setActive((curr) => (curr && curr.id === next.id ? null : curr));
          }
        },
      )
      .subscribe();

    return () => {
      alive = false;
      controller.abort();
      void supabase.removeChannel(channel);
    };
  }, [user]);

  // Pull the next request from the queue into the active slot. We only do
  // this when there's no active request currently animating.
  useEffect(() => {
    if (active || queue.length === 0) return;
    setActive(queue[0]);
    setVisible(false);
    // Kick off the slide-in on the next frame so the transition runs.
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [active, queue]);

  // Auto-dismiss timer. Pauses while the user is hovering or while a
  // request is in flight.
  useEffect(() => {
    if (!active || !visible || hovering || busy) return;
    dismissTimerRef.current = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [active, visible, hovering, busy]);

  // When visible flips false, schedule teardown of `active` after the
  // slide-out animation finishes so the next queued request can take over.
  // Also drop the request from the local queue so an auto-dismiss doesn't
  // immediately re-show the same request.
  useEffect(() => {
    if (visible || !active) return;
    const dismissedId = active.id;
    teardownTimerRef.current = setTimeout(() => {
      setActive(null);
      setQueue((rs) => rs.filter((r) => r.id !== dismissedId));
    }, ANIMATION_MS);
    return () => {
      if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
    };
  }, [visible, active]);

  if (!active) return null;

  const close = () => setVisible(false);
  const removeFromQueue = (id: string) => {
    setQueue((rs) => rs.filter((r) => r.id !== id));
  };

  const onAccept = async () => {
    if (!active) return;
    setBusy(active.id);
    try {
      const room = await createVideoRoom({
        sessionId: active.id,
        skillName: active.skill_name,
      });
      const { error } = await supabase.rpc("accept_session", {
        p_session_id: active.id,
        p_meet_link: room.link,
      });
      if (error) return toastError(error);
      markSelfAction(active.id, ["session_accepted"]);
      toast.success(`Accepted — ${active.credits} credits held in escrow`);
      void invalidateCreditBalance();
      removeFromQueue(active.id);
      close();
    } catch (error) {
      toastError(error, "Could not create video room");
    } finally {
      setBusy(null);
    }
  };

  const onReject = async () => {
    if (!active) return;
    setBusy(active.id);
    try {
      const { error } = await supabase.rpc("reject_session", { p_session_id: active.id });
      if (error) return toastError(error);
      markSelfAction(active.id, ["session_rejected"]);
      toast.message("Session rejected");
      void invalidateCreditBalance();
      removeFromQueue(active.id);
      close();
    } finally {
      setBusy(null);
    }
  };

  const onDismiss = () => {
    if (!active) return;
    removeFromQueue(active.id);
    close();
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
      aria-live="polite"
    >
      <div
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          "pointer-events-auto w-full max-w-sm transform-gpu transition-all ease-out",
          visible ? "translate-y-0 opacity-100 scale-100" : "-translate-y-4 opacity-0 scale-95",
        )}
        style={{ transitionDuration: `${ANIMATION_MS}ms` }}
      >
        <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-gradient-to-r from-brand-purple/95 to-brand-cyan/95 px-3 py-2 text-white shadow-xl backdrop-blur-md">
          <div className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-white/15 text-[11px] font-semibold uppercase">
            {active.learner_name.charAt(0)}
          </div>
          <div className="min-w-0 flex-1 text-xs leading-tight">
            <div className="truncate font-semibold">{active.learner_name}</div>
            <div className="truncate opacity-90">wants {active.skill_name}</div>
          </div>
          <button
            type="button"
            onClick={onReject}
            disabled={busy === active.id}
            className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-50"
            aria-label="Reject"
          >
            {busy === active.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy === active.id}
            className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-white text-brand-purple transition-colors hover:bg-white/90 disabled:opacity-50"
            aria-label="Accept"
          >
            {busy === active.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="grid h-6 w-6 shrink-0 place-content-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
