import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

const DETAILS_MAX = 1000;

const REPORT_REASONS = [
  { value: "harassment_or_abuse", label: "Harassment or abuse" },
  { value: "spam", label: "Spam" },
  { value: "inappropriate_content", label: "Inappropriate content" },
  { value: "contact_off_platform", label: "Trying to take contact off SkillSwap" },
  { value: "no_show_or_unresponsive", label: "No-show or unresponsive" },
  { value: "scam_or_fraud", label: "Scam or fraud" },
  { value: "impersonation", label: "Impersonation" },
  { value: "other", label: "Other" },
] as const;

type ReportReason = (typeof REPORT_REASONS)[number]["value"];

export function ReportDialog({
  reportedUserId,
  sessionId,
  messageId,
  reviewId,
  label = "Report",
  open: controlledOpen,
  onOpenChange,
}: {
  reportedUserId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  reviewId?: string | null;
  label?: string;
  // When both `open` and `onOpenChange` are provided the dialog is fully
  // controlled and the trigger button is omitted — used by callers (e.g.
  // message-bubble menu) that open the report flow from their own UI.
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}) {
  const { user } = useAuth();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = isControlled ? onOpenChange : setUncontrolledOpen;
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [saving, setSaving] = useState(false);

  const submitReport = async () => {
    if (!user) return toast.error("Please log in to report something.");
    if (!reportedUserId && !sessionId && !messageId && !reviewId)
      return toast.error("Nothing to report.");
    if (!reason) return toast.error("Pick a reason for the report.");
    if (details.length > DETAILS_MAX) {
      return toast.error(`Details must be ${DETAILS_MAX} characters or fewer.`);
    }

    setSaving(true);
    const { error } = await supabase.from("reports").insert({
      reported_user_id: reportedUserId ?? null,
      session_id: sessionId ?? null,
      message_id: messageId ?? null,
      review_id: reviewId ?? null,
      reason,
      details: details.trim() || null,
    });
    setSaving(false);

    if (error) return toast.error(error.message);
    toast.success("Report submitted. Our team will review it.");
    setReason("");
    setDetails("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <Flag className="h-4 w-4" />
            {label}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="glass-strong border-white/10">
        <DialogHeader>
          <DialogTitle>Submit report</DialogTitle>
          <DialogDescription>
            Reports go to a moderator. Misuse (false or repeat reports) can affect your account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="report-reason">Reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as ReportReason)}>
              <SelectTrigger id="report-reason" className="glass border-white/10 h-11">
                <SelectValue placeholder="Pick a reason" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-details">Details (optional)</Label>
            <Textarea
              id="report-details"
              value={details}
              onChange={(event) => setDetails(event.target.value.slice(0, DETAILS_MAX))}
              placeholder="What happened? Be specific."
              className="glass border-white/10 min-h-28"
              maxLength={DETAILS_MAX}
            />
            <div className="text-right text-[11px] text-muted-foreground">
              {details.length}/{DETAILS_MAX}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="hero" onClick={submitReport} disabled={saving || !reason}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
