import { useEffect, useRef, useState } from "react";
import { CalendarClock, Check, Clock, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProposeRescheduleDialog } from "@/components/ProposeRescheduleDialog";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Proposal = {
  id: string;
  proposer_id: string;
  new_scheduled_at: string;
  note: string | null;
};

// Surfaces reschedule controls inline on the dashboard "Up next" card. With a
// pending proposal, the counterparty gets Accept-new-time / Reject and the
// proposer sees a waiting note. With no proposal, it offers a "Propose new
// time" button so either side can kick off a reschedule without opening the
// session Details page.
export function UpNextRescheduleActions({
  sessionId,
  currentUserId,
  teacherId,
  durationMinutes,
  onResolved,
  className,
}: {
  sessionId: string;
  currentUserId: string;
  // Needed by the propose dialog to constrain new times to the teacher's free
  // windows (same rule as the original booking flow).
  teacherId: string;
  durationMinutes: number;
  // Called after a proposal is created/accepted/rejected so the parent can
  // refresh (the session's scheduled_at changes on accept).
  onResolved: () => void | Promise<void>;
  // Layout classes from the parent (the card places this beside the buttons).
  className?: string;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"accept" | "reject" | "withdraw" | null>(null);
  // Keep onResolved in a ref so the realtime effect can call the latest one
  // without re-subscribing on every parent render.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("reschedule_proposals")
      .select("id, proposer_id, new_scheduled_at, note")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setProposal((data as Proposal) ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void load();

    // Live-sync both sides: when the counterparty accepts/rejects/withdraws (or
    // a new proposal is created), refresh so the panel never shows stale state.
    // A reject doesn't touch the sessions row, so this proposal-level feed is
    // the only signal the proposer gets.
    const sync = () => {
      void (async () => {
        await load();
        await onResolvedRef.current();
      })();
    };
    const channel = supabase
      .channel(`reschedule-proposals-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "reschedule_proposals",
          filter: `session_id=eq.${sessionId}`,
        },
        sync,
      )
      .subscribe();

    // Backgrounded tabs can miss realtime events; resync on refocus.
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void load();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      void supabase.removeChannel(channel);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (loading) return null;

  // No pending proposal — offer a way to start one right from the card.
  if (!proposal) {
    return (
      <div
        className={cn("rounded-2xl border border-border/60 bg-card/40 p-4 shadow-sm", className)}
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Need a different time?
        </p>
        <ProposeRescheduleDialog
          sessionId={sessionId}
          teacherId={teacherId}
          durationMinutes={durationMinutes}
          onProposed={load}
          buttonLabel="Propose new time"
          buttonSize="sm"
          buttonClassName="mt-2 w-full"
        />
      </div>
    );
  }

  const isProposer = proposal.proposer_id === currentUserId;
  const newTime = new Date(proposal.new_scheduled_at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const accept = async () => {
    setBusy("accept");
    const { error } = await supabase.rpc("accept_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule accepted. Session time updated.");
    await load();
    await onResolved();
  };

  const reject = async () => {
    setBusy("reject");
    const { error } = await supabase.rpc("reject_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule rejected");
    await load();
    await onResolved();
  };

  const withdraw = async () => {
    setBusy("withdraw");
    const { error } = await supabase.rpc("withdraw_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule withdrawn");
    await load();
    await onResolved();
  };

  if (isProposer) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-brand-purple/25 bg-gradient-to-br from-brand-purple/10 via-card/40 to-brand-cyan/5 p-4 shadow-sm",
          className,
        )}
      >
        <div className="flex items-start gap-3">
          <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl gradient-brand-soft">
            <Clock className="h-4 w-4 text-brand-purple" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-purple">
              Awaiting response
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug text-foreground">{newTime}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              You proposed this. Waiting for the other party to accept.
            </p>
          </div>
        </div>
        <div className="mt-3.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={withdraw}
            disabled={busy !== null}
          >
            {busy === "withdraw" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
            Withdraw
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-brand-purple/30 bg-gradient-to-br from-brand-purple/10 via-card/40 to-brand-cyan/5 p-4 shadow-sm",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl gradient-brand-soft">
          <CalendarClock className="h-4 w-4 text-brand-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-purple">
            New time proposed
          </p>
          <p className="mt-1 text-sm font-semibold leading-snug text-foreground">{newTime}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The other party wants to move this session.
          </p>
          {proposal.note && (
            <p className="mt-1.5 text-xs italic text-muted-foreground">
              &ldquo;{proposal.note}&rdquo;
            </p>
          )}
        </div>
      </div>
      <div className="mt-3.5 flex gap-2">
        <Button
          variant="hero"
          size="sm"
          className="flex-1"
          onClick={accept}
          disabled={busy !== null}
        >
          {busy === "accept" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Accept new time
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={reject}
          disabled={busy !== null}
        >
          {busy === "reject" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <X className="h-4 w-4" />
          )}
          Reject
        </Button>
      </div>
    </div>
  );
}
