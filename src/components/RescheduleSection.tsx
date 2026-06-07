import { useEffect, useState } from "react";
import { Check, Clock, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProposeRescheduleDialog } from "@/components/ProposeRescheduleDialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Proposal = {
  id: string;
  session_id: string;
  proposer_id: string;
  old_scheduled_at: string | null;
  new_scheduled_at: string;
  status: string;
  responder_id: string | null;
  responded_at: string | null;
  note: string | null;
  created_at: string;
};

export function RescheduleSection({
  sessionId,
  currentUserId,
  teacherId,
  durationMinutes,
  onScheduleChanged,
}: {
  sessionId: string;
  currentUserId: string;
  // The session's teacher. The new time is constrained to the teacher's free
  // `teach` windows (minus their bookings) regardless of who proposes — the
  // same rule the original booking flow uses.
  teacherId: string;
  durationMinutes: number;
  onScheduleChanged: () => void;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const loadProposal = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("reschedule_proposals")
      .select(
        "id, session_id, proposer_id, old_scheduled_at, new_scheduled_at, status, responder_id, responded_at, note, created_at",
      )
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setProposal((data as Proposal) ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void loadProposal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const accept = async () => {
    if (!proposal) return;
    setBusy("accept");
    const { error } = await supabase.rpc("accept_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule accepted. Session time updated.");
    await loadProposal();
    onScheduleChanged();
  };

  const reject = async () => {
    if (!proposal) return;
    setBusy("reject");
    const { error } = await supabase.rpc("reject_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule rejected");
    await loadProposal();
  };

  const withdraw = async () => {
    if (!proposal) return;
    setBusy("withdraw");
    const { error } = await supabase.rpc("withdraw_reschedule", { p_proposal_id: proposal.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule withdrawn");
    await loadProposal();
  };

  if (loading) return null;

  // Active pending proposal — show appropriate actions per role.
  if (proposal) {
    const isProposer = proposal.proposer_id === currentUserId;
    return (
      <div className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-violet-100">
          <Clock className="h-4 w-4" />
          {isProposer ? "Your reschedule proposal" : "Reschedule proposed"}
        </div>
        <p className="mt-1 text-sm text-violet-100/90">
          New time:{" "}
          <span className="font-medium">
            {new Date(proposal.new_scheduled_at).toLocaleString(undefined, {
              dateStyle: "full",
              timeStyle: "short",
            })}
          </span>
        </p>
        {proposal.note && (
          <p className="mt-2 text-xs italic text-violet-100/80">&ldquo;{proposal.note}&rdquo;</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {isProposer ? (
            <Button size="sm" variant="outline" onClick={withdraw} disabled={busy === "withdraw"}>
              {busy === "withdraw" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4" />
              )}
              Withdraw
            </Button>
          ) : (
            <>
              <Button size="sm" variant="hero" onClick={accept} disabled={busy === "accept"}>
                {busy === "accept" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Accept new time
              </Button>
              <Button size="sm" variant="outline" onClick={reject} disabled={busy === "reject"}>
                {busy === "reject" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                Reject
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  // No active proposal — offer a "Propose reschedule" button.
  return (
    <ProposeRescheduleDialog
      sessionId={sessionId}
      teacherId={teacherId}
      durationMinutes={durationMinutes}
      onProposed={loadProposal}
      buttonClassName="w-full"
    />
  );
}
