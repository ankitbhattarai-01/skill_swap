import { useState, type ReactNode } from "react";
import { Calendar, Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeacherSlotPicker } from "@/components/TeacherSlotPicker";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Shared "Propose a new time" trigger + dialog. Used both on the session
// Details page (RescheduleSection) and inline on the dashboard "Up next" card
// (UpNextRescheduleActions) so a user can kick off a reschedule from either
// place without navigating. The new time is constrained to the teacher's free
// `teach` windows regardless of who proposes — the same rule the original
// booking flow uses.
export function ProposeRescheduleDialog({
  sessionId,
  teacherId,
  durationMinutes,
  onProposed,
  buttonLabel = "Propose reschedule",
  buttonVariant = "outline",
  buttonSize,
  buttonClassName,
  buttonIcon = <Calendar className="h-4 w-4" />,
}: {
  sessionId: string;
  teacherId: string;
  durationMinutes: number;
  // Called after a proposal is created so the parent can refresh into its
  // pending/awaiting state.
  onProposed: () => void | Promise<void>;
  buttonLabel?: string;
  buttonVariant?: ButtonProps["variant"];
  buttonSize?: ButtonProps["size"];
  buttonClassName?: string;
  buttonIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<Date | null>(null);
  const [valid, setValid] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!date || !valid) {
      toast.error("Pick a time inside the teacher's free window");
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("propose_reschedule", {
      p_session_id: sessionId,
      p_new_scheduled_at: date.toISOString(),
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reschedule proposed. Waiting for the other party to accept.");
    setOpen(false);
    setDate(null);
    setNote("");
    await onProposed();
  };

  return (
    <>
      <Button
        variant={buttonVariant}
        size={buttonSize}
        className={buttonClassName}
        onClick={() => setOpen(true)}
      >
        {buttonIcon}
        {buttonLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
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
              <p className="text-sm font-medium">New date and time</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Only times inside the teacher's free window are shown.
              </p>
              <div className="mt-2">
                <TeacherSlotPicker
                  teacherId={teacherId}
                  durationMinutes={durationMinutes}
                  value={date}
                  onChange={setDate}
                  onValidityChange={setValid}
                  active={open}
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="reschedule-note">
                Reason (optional)
              </label>
              <Textarea
                id="reschedule-note"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 280))}
                placeholder="e.g. conflict with another meeting"
                rows={3}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">{note.length}/280</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="hero" onClick={submit} disabled={busy || !valid || !date}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send proposal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
