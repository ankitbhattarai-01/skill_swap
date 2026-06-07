import { useEffect, useState } from "react";
import { Loader2, CalendarIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TeacherSlotPicker } from "@/components/TeacherSlotPicker";
import { cn } from "@/lib/utils";
import { SESSION_DURATIONS, computeSessionCredits, type SessionDuration } from "@/lib/sessions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  skillName: string;
  creditsPerHour: number;
  availableCredits?: number | null;
  busy?: boolean;
  confirmLabel?: string;
  onConfirm: (duration: SessionDuration, scheduledAt: string) => void | Promise<void>;
  // When supplied, the dialog constrains the date/time picker to the teacher's
  // free `teach` windows (minus their existing bookings). Without it, the
  // picker is unconstrained.
  // learnerId is kept in the signature for callsite compatibility but is
  // no longer used — bookings only check teacher-side availability.
  learnerId?: string;
  teacherId?: string;
};

function defaultSchedule(): Date {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

export function SessionRequestDialog({
  open,
  onOpenChange,
  title,
  skillName,
  creditsPerHour,
  availableCredits,
  busy = false,
  confirmLabel = "Send request",
  onConfirm,
  teacherId,
}: Props) {
  const [duration, setDuration] = useState<SessionDuration>(60);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [scheduleValid, setScheduleValid] = useState(false);

  useEffect(() => {
    if (open) {
      setDuration(60);
      setScheduledAt(defaultSchedule());
    }
  }, [open]);

  const cost = computeSessionCredits(creditsPerHour, duration);
  const insufficient = availableCredits != null && availableCredits >= 0 && cost > availableCredits;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-3xl border-white/10 glass-strong p-0 gap-0">
        {/* Soft brand wash spans the whole dialog — matches Explore / Profile heroes. */}
        <div className="pointer-events-none absolute inset-0 gradient-hero opacity-80" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.22),transparent_55%)] dark:hidden" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_15%_85%,rgba(16,185,129,0.10),transparent_55%)]" />

        <div className="relative space-y-5 p-6">
          <DialogHeader className="space-y-2">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl gradient-brand-soft">
                <CalendarIcon className="h-5 w-5 text-brand-purple" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-xl leading-tight">{title}</DialogTitle>
                <DialogDescription className="mt-1">
                  Pick a time for your{" "}
                  <span className="font-medium text-foreground">{skillName}</span> session. Credits
                  transfer when it's completed.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Duration */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Duration
            </p>
            <div className="grid grid-cols-3 gap-2">
              {SESSION_DURATIONS.map((value) => {
                const selected = value === duration;
                const optionCost = computeSessionCredits(creditsPerHour, value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDuration(value)}
                    className={cn(
                      "rounded-2xl border px-3 py-3.5 text-center transition-all",
                      selected
                        ? "border-brand-purple/60 bg-brand-purple/10 shadow-glow"
                        : "border-white/10 bg-white/5 hover:border-brand-purple/30 hover:bg-white/[0.08]",
                    )}
                  >
                    <div className="text-lg font-bold leading-none">{value} min</div>
                    <div
                      className={cn(
                        "mt-1.5 text-xs",
                        selected ? "text-brand-purple" : "text-muted-foreground",
                      )}
                    >
                      {optionCost} {optionCost === 1 ? "credit" : "credits"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* When */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              When
            </p>
            <TeacherSlotPicker
              teacherId={teacherId}
              durationMinutes={duration}
              value={scheduledAt}
              onChange={setScheduledAt}
              onValidityChange={setScheduleValid}
              active={open}
            />
          </div>

          {/* Cost summary — premium gradient block */}
          <div className="relative overflow-hidden rounded-2xl border border-white/10 p-4">
            <div className="absolute inset-0 gradient-brand-soft opacity-80 pointer-events-none" />
            <div className="relative flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Total cost
                </p>
                <p className="mt-1 text-2xl font-bold leading-none">
                  <span className="gradient-brand-text">{cost}</span>{" "}
                  <span className="text-base font-medium text-muted-foreground">
                    {cost === 1 ? "credit" : "credits"}
                  </span>
                </p>
              </div>
              {availableCredits != null && (
                <div className="text-right">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Your balance
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-sm font-semibold",
                      insufficient ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {availableCredits} {availableCredits === 1 ? "credit" : "credits"}
                  </p>
                </div>
              )}
            </div>
            {insufficient && (
              <p className="relative mt-3 text-xs text-destructive">
                Not enough credits. Pick a shorter duration or earn more by teaching.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="hero"
              size="lg"
              onClick={() => {
                if (!scheduleValid || !scheduledAt) return;
                void onConfirm(duration, scheduledAt.toISOString());
              }}
              disabled={busy || insufficient || !scheduleValid || !scheduledAt}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
