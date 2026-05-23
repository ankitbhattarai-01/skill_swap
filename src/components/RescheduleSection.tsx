import { useEffect, useState } from "react";
import { Calendar, Check, Clock, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  onScheduleChanged,
}: {
  sessionId: string;
  currentUserId: string;
  onScheduleChanged: () => void;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeDraft, setProposeDraft] = useState("");
  const [proposeNote, setProposeNote] = useState("");
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

  const submitPropose = async () => {
    if (!proposeDraft) {
      toast.error("Pick a new date and time");
      return;
    }
    // Match SessionRequestDialog's future-date check. The DB-side RPC will
    // also reject past times, but catching this client-side gives a clearer
    // message and avoids a round-trip. 60s buffer accounts for the user
    // typing the current minute exactly.
    const newScheduledAt = new Date(proposeDraft);
    if (Number.isNaN(newScheduledAt.getTime())) {
      toast.error("Invalid date and time");
      return;
    }
    if (newScheduledAt.getTime() < Date.now() - 60_000) {
      toast.error("The new time has to be in the future");
      return;
    }
    setBusy("propose");
    const { error } = await supabase.rpc("propose_reschedule", {
      p_session_id: sessionId,
      p_new_scheduled_at: newScheduledAt.toISOString(),
      p_note: proposeNote.trim() || null,
    });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule proposed. Waiting for the other party to accept.");
    setProposeOpen(false);
    setProposeDraft("");
    setProposeNote("");
    await loadProposal();
  };

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
    <>
      <Button variant="outline" className="w-full" onClick={() => setProposeOpen(true)}>
        <Calendar className="h-4 w-4" />
        Propose reschedule
      </Button>
      <Dialog open={proposeOpen} onOpenChange={setProposeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Propose a new time</DialogTitle>
            <DialogDescription>
              The other party has to accept before the session time changes. Either side can
              propose; both sides have to agree.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium" htmlFor="reschedule-time">
                New date and time
              </label>
              <Input
                id="reschedule-time"
                type="datetime-local"
                value={proposeDraft}
                onChange={(e) => setProposeDraft(e.target.value)}
                // `min` is the browser-side guard; submitPropose enforces it
                // again because users can edit the field manually past `min`.
                min={(() => {
                  const now = new Date();
                  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
                  return now.toISOString().slice(0, 16);
                })()}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="reschedule-note">
                Reason (optional)
              </label>
              <Textarea
                id="reschedule-note"
                value={proposeNote}
                onChange={(e) => setProposeNote(e.target.value.slice(0, 280))}
                placeholder="e.g. conflict with another meeting"
                rows={3}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">{proposeNote.length}/280</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProposeOpen(false)}>
              Cancel
            </Button>
            <Button variant="hero" onClick={submitPropose} disabled={busy === "propose"}>
              {busy === "propose" && <Loader2 className="h-4 w-4 animate-spin" />}
              Send proposal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
