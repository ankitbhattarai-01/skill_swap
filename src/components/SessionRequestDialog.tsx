import { useEffect, useMemo, useState } from "react";
import { Loader2, CalendarIcon, GitBranch, Plus, X } from "lucide-react";
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
import { DurationSelector } from "@/components/DurationSelector";
import { cn } from "@/lib/utils";
import { computeSessionCredits, type SessionDuration } from "@/lib/sessions";

// At most this many sessions a learner can book in one go.
const MAX_SESSIONS = 7;

// A multi-session request: same duration for every session, plus the explicit
// start time the learner picked for each one (each constrained to the teacher's
// free windows). 1–MAX_SESSIONS entries. Each becomes an ordinary pending
// session the teacher accepts individually.
export type MultiSessionParams = {
  durationMinutes: SessionDuration;
  startTimes: string[];
};

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
  // Multi-session support. When allowMultiSession is true a "Just one /
  // Multiple sessions" toggle appears; choosing multiple lets the learner
  // hand-pick a free slot for each session and routes confirm to
  // onConfirmMulti. Single-session callers omit these.
  allowMultiSession?: boolean;
  teacherName?: string;
  onConfirmMulti?: (params: MultiSessionParams) => void | Promise<void>;
};

// Fallback start for the unconstrained picker only (no teacher supplied, so
// there are no "best times" to snap to): tomorrow, on the hour. When a teacher
// IS supplied we open with no time at all and let TeacherSlotPicker fill in its
// first suggested slot, so the default always matches the first "Best times"
// chip instead of an arbitrary +24h.
function defaultSchedule(): Date {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

function slotLabel(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  allowMultiSession = false,
  teacherName,
  onConfirmMulti,
}: Props) {
  const multiEnabled = allowMultiSession && !!onConfirmMulti;
  const [duration, setDuration] = useState<SessionDuration>(60);
  const [multi, setMulti] = useState(false);

  // Single-session state.
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [scheduleValid, setScheduleValid] = useState(false);

  // Multi-session state: the slots already added to the plan, plus the
  // currently-drafted slot in the picker (the next one to add).
  const [slots, setSlots] = useState<Date[]>([]);
  const [draft, setDraft] = useState<Date | null>(null);
  const [draftValid, setDraftValid] = useState(false);

  useEffect(() => {
    if (open) {
      setDuration(60);
      setMulti(false);
      setScheduledAt(teacherId ? null : defaultSchedule());
      setScheduleValid(false);
      setSlots([]);
      setDraft(null);
      setDraftValid(false);
    }
  }, [open, teacherId]);

  // Changing duration can shift which teacher slots fit, so a fresh plan is
  // simplest and avoids holding now-invalid times. Clearing the single-session
  // pick likewise lets the picker re-snap to the first suggestion for the new
  // duration — a 20-min class may open an earlier slot than a 60-min one.
  useEffect(() => {
    if (multi) setSlots([]);
    if (!teacherId) return;
    setScheduledAt(null);
    setScheduleValid(false);
    setDraft(null);
    setDraftValid(false);
  }, [duration]); // eslint-disable-line react-hooks/exhaustive-deps

  const excludeTimes = useMemo(() => slots.map((s) => s.getTime()), [slots]);
  const cost = computeSessionCredits(creditsPerHour, duration);
  // In multi mode the learner commits to every session up front, so the cost
  // that matters is the whole plan, not one session. We block booking a plan
  // they can't cover — otherwise later sessions would just fail on accept.
  const totalCost = multi ? cost * slots.length : cost;
  const insufficient =
    availableCredits != null &&
    availableCredits >= 0 &&
    totalCost > 0 &&
    totalCost > availableCredits;

  const canAddSlot =
    draft != null &&
    draftValid &&
    slots.length < MAX_SESSIONS &&
    !slots.some((s) => s.getTime() === draft.getTime());

  const addSlot = () => {
    if (!canAddSlot || !draft) return;
    setSlots((prev) => [...prev, draft].sort((a, b) => a.getTime() - b.getTime()));
    // Constrained pickers auto-advance to the next free day via preferAfter;
    // without teacher windows there's no auto-fill, so nudge the draft to the
    // same time next day ourselves.
    if (!teacherId) {
      const next = new Date(draft);
      next.setDate(next.getDate() + 1);
      setDraft(next);
    }
  };

  const removeSlot = (time: number) => {
    setSlots((prev) => prev.filter((s) => s.getTime() !== time));
  };

  const submitDisabled =
    busy || insufficient || (multi ? slots.length < 1 : !scheduleValid || !scheduledAt);

  const submit = () => {
    if (multi) {
      if (slots.length < 1) return;
      void onConfirmMulti?.({
        durationMinutes: duration,
        startTimes: slots.map((s) => s.toISOString()),
      });
      return;
    }
    if (!scheduleValid || !scheduledAt) return;
    void onConfirm(duration, scheduledAt.toISOString());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Surface colour comes from DialogContent — only layout is set here. */}
      <DialogContent className="max-h-[90vh] max-w-[460px] gap-0 overflow-hidden p-0">
        <div className="dialog-scroll relative max-h-[90vh] space-y-3.5 overflow-y-auto p-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
                {multi ? (
                  <GitBranch className="h-4 w-4 text-brand-cyan" />
                ) : (
                  <CalendarIcon className="h-4 w-4 text-brand-purple" />
                )}
              </div>
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-snug">
              {multi ? (
                <>
                  Pick a free time for each{" "}
                  <span className="font-medium text-foreground">{skillName}</span> session (up to{" "}
                  {MAX_SESSIONS}). The teacher accepts each one; credits transfer per session.
                </>
              ) : (
                <>
                  Pick a time for your{" "}
                  <span className="font-medium text-foreground">{skillName}</span> session. Credits
                  transfer when it's completed.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {/* How many sessions — only when the caller opts in */}
          {multiEnabled && (
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: false, label: "Just one" },
                { value: true, label: "Multiple" },
              ].map((opt) => {
                const selected = multi === opt.value;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setMulti(opt.value)}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-center text-sm font-medium transition-all",
                      selected
                        ? "border-brand-purple/60 bg-brand-purple/10 shadow-glow"
                        : "border-border bg-muted hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Duration */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Duration {multi && <span className="font-normal normal-case">· every class</span>}
            </p>
            <DurationSelector
              value={duration}
              onChange={setDuration}
              creditsPerHour={creditsPerHour}
            />
          </div>

          {/* Single session: one time picker. */}
          {!multi && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
          )}

          {/* Multi session: a running list of chosen classes + a picker to add
              the next one (constrained to free, not-yet-taken slots). */}
          {multi && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Your sessions
                </p>
                <span className="text-[10px] text-muted-foreground">
                  {slots.length}/{MAX_SESSIONS}
                </span>
              </div>

              {slots.length > 0 && (
                <ul className="space-y-1.5">
                  {slots.map((s, i) => (
                    <li
                      key={s.getTime()}
                      className="flex items-center justify-between gap-2 rounded-lg border border-brand-cyan/20 bg-brand-cyan/[0.06] px-2.5 py-1.5"
                    >
                      <span className="inline-flex items-center gap-2 text-xs">
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-cyan/15 text-[10px] font-semibold text-brand-cyan">
                          {i + 1}
                        </span>
                        <span className="font-medium">{slotLabel(s)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeSlot(s.getTime())}
                        className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        aria-label="Remove session"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {slots.length < MAX_SESSIONS ? (
                <div className="space-y-2">
                  <TeacherSlotPicker
                    teacherId={teacherId}
                    durationMinutes={duration}
                    value={draft}
                    onChange={setDraft}
                    onValidityChange={setDraftValid}
                    active={open && multi}
                    excludeTimes={excludeTimes}
                    preferAfter={slots.length > 0 ? slots[slots.length - 1].getTime() : null}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full rounded-lg border-brand-cyan/30 bg-brand-cyan/[0.06] text-brand-cyan hover:bg-brand-cyan/[0.12]"
                    onClick={addSlot}
                    disabled={!canAddSlot}
                  >
                    <Plus className="h-4 w-4" />
                    Add this session
                  </Button>
                </div>
              ) : (
                <p className="rounded-lg border border-border bg-muted px-3 py-2 text-center text-[11px] text-muted-foreground">
                  Max of {MAX_SESSIONS} sessions reached. Remove one to swap a time.
                </p>
              )}
            </div>
          )}

          {/* Cost summary */}
          <div className="relative flex items-center justify-between gap-3 overflow-hidden rounded-xl border border-border px-3 py-2.5">
            <div className="absolute inset-0 gradient-brand-soft opacity-80 pointer-events-none" />
            <div className="relative">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Total
              </p>
              <p className="mt-0.5 text-lg font-bold leading-none">
                <span className="gradient-brand-text">{totalCost}</span>{" "}
                <span className="text-xs font-medium text-muted-foreground">
                  {totalCost === 1 ? "credit" : "credits"}
                </span>
              </p>
              {multi && slots.length > 0 && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {slots.length} × {cost} cr per session
                </p>
              )}
            </div>
            {availableCredits != null && (
              <div className="relative text-right">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Balance
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-sm font-semibold",
                    insufficient ? "text-destructive" : "text-foreground",
                  )}
                >
                  {availableCredits}
                </p>
              </div>
            )}
          </div>
          {insufficient && (
            <p className="text-[11px] text-destructive">
              {multi
                ? `This plan needs ${totalCost} credits but you have ${availableCredits}. Remove a session, pick a shorter duration, or earn more by teaching.`
                : "Not enough credits. Pick a shorter duration or earn more by teaching."}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="hero" onClick={submit} disabled={submitDisabled}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {multi
                ? slots.length > 0
                  ? `Request ${slots.length} ${slots.length === 1 ? "session" : "sessions"}`
                  : "Add a session"
                : confirmLabel}
            </Button>
          </DialogFooter>
          {multi && teacherName && (
            <p className="-mt-1 text-center text-[10px] text-muted-foreground">
              Sent to {teacherName} for approval.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
