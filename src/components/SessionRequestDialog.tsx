import { useEffect, useState } from "react";
import { Loader2, Sparkles, CalendarIcon, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SESSION_DURATIONS, computeSessionCredits, type SessionDuration } from "@/lib/sessions";
import { supabase } from "@/integrations/supabase/client";

const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  for (let h = 6; h < 24; h++) {
    for (const m of [0, 30]) {
      const period = h < 12 ? "AM" : "PM";
      const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
      out.push({
        value: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        label: `${hh}:${String(m).padStart(2, "0")} ${period}`,
      });
    }
  }
  return out;
})();

function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPretty(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
  // When both ids are supplied, the dialog calls compute_intersection_slots
  // to surface quick-pick suggested times based on both parties' weekly
  // availability. Optional — falling back to the manual datetime input.
  learnerId?: string;
  teacherId?: string;
};

function defaultScheduleLocal() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  learnerId,
  teacherId,
}: Props) {
  const [duration, setDuration] = useState<SessionDuration>(60);
  const [scheduledAt, setScheduledAt] = useState<string>("");
  const [suggestedSlots, setSuggestedSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // When the user types in the datetime field or picks a non-first chip, we
  // stop auto-applying the top AI suggestion. Reset on open and when duration
  // changes (since new duration → fresh slot list).
  const [userTouched, setUserTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setDuration(60);
      setScheduledAt(defaultScheduleLocal());
      setUserTouched(false);
    }
  }, [open]);

  // Fetch intersection slots whenever the dialog opens or the duration
  // changes. We refetch on duration because shorter sessions can fit in
  // more places.
  useEffect(() => {
    if (!open || !learnerId || !teacherId) {
      setSuggestedSlots([]);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      setSlotsLoading(true);
      const { data, error } = await supabase
        .rpc("compute_intersection_slots", {
          p_learner_id: learnerId,
          p_teacher_id: teacherId,
          p_duration_minutes: duration,
          p_horizon_days: 7,
          p_max_slots: 3,
        })
        .abortSignal(controller.signal);
      if (!alive) return;
      if (error) {
        // Don't toast — suggestions are nice-to-have, fall back silently.
        setSuggestedSlots([]);
      } else {
        setSuggestedSlots((data ?? []).map((row) => row.proposed_start));
      }
      setSlotsLoading(false);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, learnerId, teacherId, duration]);

  // Auto-fill the schedule with the top AI suggestion so the user doesn't
  // have to click anything for the common case. Held back once the user
  // manually overrides the field (or picks a non-first chip).
  useEffect(() => {
    if (!open || userTouched || suggestedSlots.length === 0) return;
    const d = new Date(suggestedSlots[0]);
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduledAt(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
  }, [open, userTouched, suggestedSlots]);

  const applySuggestedSlot = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduledAt(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
    setUserTouched(true);
  };

  const cost = computeSessionCredits(creditsPerHour, duration);
  const insufficient = availableCredits != null && availableCredits >= 0 && cost > availableCredits;
  const scheduleDate = scheduledAt ? new Date(scheduledAt) : null;
  const scheduleInPast =
    scheduleDate != null &&
    !Number.isNaN(scheduleDate.getTime()) &&
    scheduleDate.getTime() < Date.now();
  const scheduleInvalid =
    !scheduledAt || scheduleDate == null || Number.isNaN(scheduleDate.getTime()) || scheduleInPast;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pick a duration for your {skillName} session. Credits transfer when the session is
            completed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {SESSION_DURATIONS.map((value) => {
            const selected = value === duration;
            const optionCost = computeSessionCredits(creditsPerHour, value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setDuration(value);
                  setUserTouched(false);
                }}
                className={cn(
                  "rounded-xl border px-3 py-3 text-center transition-colors",
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card hover:border-primary/40",
                )}
              >
                <div className="text-base font-semibold">{value} min</div>
                <div className="text-xs text-muted-foreground">
                  {optionCost} {optionCost === 1 ? "credit" : "credits"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          <label htmlFor="session-schedule" className="text-sm font-medium">
            When?
          </label>
          {learnerId && teacherId && (
            <div className="mb-1">
              {slotsLoading ? (
                <p className="text-xs text-muted-foreground">Finding times that work for both…</p>
              ) : suggestedSlots.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Sparkles className="h-3 w-3" /> Suggested:
                  </span>
                  {suggestedSlots.map((iso) => (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => applySuggestedSlot(iso)}
                      className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/20"
                    >
                      {new Date(iso).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No overlapping times in the next week — pick manually or update your availability
                  in profile.
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  id="session-schedule"
                  className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                  {scheduleDate && !Number.isNaN(scheduleDate.getTime()) ? (
                    <span>
                      {scheduleDate.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Pick a date</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto overflow-hidden rounded-2xl border border-border/60 bg-popover p-0 shadow-xl"
                align="start"
              >
                <Calendar
                  className="bg-transparent"
                  mode="single"
                  selected={scheduleDate ?? undefined}
                  onSelect={(day) => {
                    if (!day) return;
                    const base = scheduleDate ?? new Date();
                    const merged = new Date(day);
                    merged.setHours(base.getHours(), base.getMinutes(), 0, 0);
                    setScheduledAt(formatLocal(merged));
                    setUserTouched(true);
                  }}
                  disabled={(date) => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    return date < today;
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Select
              value={
                scheduleDate && !Number.isNaN(scheduleDate.getTime())
                  ? `${String(scheduleDate.getHours()).padStart(2, "0")}:${String(scheduleDate.getMinutes()).padStart(2, "0")}`
                  : ""
              }
              onValueChange={(val) => {
                const [hh, mm] = val.split(":").map(Number);
                const base = scheduleDate ?? new Date();
                const merged = new Date(base);
                merged.setHours(hh, mm, 0, 0);
                setScheduledAt(formatLocal(merged));
                setUserTouched(true);
              }}
            >
              <SelectTrigger className="h-auto min-w-[110px] rounded-xl border-border bg-card px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <SelectValue placeholder="Time" />
                </span>
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl">
                {TIME_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {scheduleDate && (
            <p className="text-xs text-muted-foreground">{formatPretty(scheduleDate)}</p>
          )}
          {scheduleInPast && <p className="text-xs text-destructive">Pick a time in the future.</p>}
        </div>

        <div className="rounded-xl bg-secondary/60 px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Total cost</span>
            <span className="font-semibold">
              {cost} {cost === 1 ? "credit" : "credits"}
            </span>
          </div>
          {availableCredits != null && (
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Your balance</span>
              <span className={cn(insufficient ? "text-destructive" : "text-muted-foreground")}>
                {availableCredits} {availableCredits === 1 ? "credit" : "credits"}
              </span>
            </div>
          )}
          {insufficient && (
            <p className="mt-2 text-xs text-destructive">
              Not enough credits. Pick a shorter duration or earn more by teaching.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="hero"
            onClick={() => {
              if (scheduleInvalid || !scheduleDate) return;
              void onConfirm(duration, scheduleDate.toISOString());
            }}
            disabled={busy || insufficient || scheduleInvalid}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
