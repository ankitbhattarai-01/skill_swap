import { useEffect, useState } from "react";
import { Loader2, GitBranch, CalendarIcon, Clock } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const TIME_STEP_MIN = 10;

function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Pattern = "one_shot" | "mini" | "daily" | "weekly";

const PATTERN_OPTIONS: {
  value: Pattern;
  label: string;
  description: string;
  defaultCount: number;
  maxCount: number;
}[] = [
  {
    value: "one_shot",
    label: "Just one session",
    description: "A single session, no recurrence.",
    defaultCount: 1,
    maxCount: 1,
  },
  {
    value: "mini",
    label: "A few sessions",
    description: "2-3 sessions, one per week.",
    defaultCount: 3,
    maxCount: 3,
  },
  {
    value: "daily",
    label: "Daily for N days",
    description: "Daily sessions for a focused sprint (max 14).",
    defaultCount: 7,
    maxCount: 14,
  },
  {
    value: "weekly",
    label: "Weekly for N weeks",
    description: "Once a week for ongoing mastery (max 12).",
    defaultCount: 8,
    maxCount: 12,
  },
];

function defaultStartLocal() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TrackProposalDialog({
  open,
  onOpenChange,
  teacherId,
  teacherName,
  skillId,
  skillName,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teacherId: string;
  teacherName: string;
  skillId: string;
  skillName: string;
  onProposed?: () => void;
}) {
  const [pattern, setPattern] = useState<Pattern>("weekly");
  const [count, setCount] = useState(8);
  const [duration, setDuration] = useState<30 | 60 | 90>(60);
  const [goal, setGoal] = useState("");
  const [firstStart, setFirstStart] = useState(defaultStartLocal());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const opt = PATTERN_OPTIONS.find((o) => o.value === pattern)!;
    setCount(opt.defaultCount);
  }, [open, pattern]);

  const currentOption = PATTERN_OPTIONS.find((o) => o.value === pattern)!;
  const firstStartDate = firstStart ? new Date(firstStart) : null;

  const submit = async () => {
    if (goal.trim().length < 4) {
      toast.error("Add a goal (at least 4 characters)");
      return;
    }
    if (count < 1 || count > currentOption.maxCount) {
      toast.error(`Pick a count between 1 and ${currentOption.maxCount}`);
      return;
    }
    const startDate = new Date(firstStart);
    if (Number.isNaN(startDate.getTime()) || startDate.getTime() <= Date.now()) {
      toast.error("First session must be in the future");
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("propose_track", {
      p_teacher_id: teacherId,
      p_skill_id: skillId,
      p_goal: goal.trim(),
      p_pattern: pattern,
      p_planned_count: count,
      p_default_duration_minutes: duration,
      p_first_start_at: startDate.toISOString(),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Track proposed to ${teacherName}`);
    onOpenChange(false);
    setGoal("");
    onProposed?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-3xl border-white/10 glass-strong p-0 gap-0">
        {/* Full-coverage brand wash — matches Session Request dialog. */}
        <div className="pointer-events-none absolute inset-0 gradient-hero opacity-80" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.22),transparent_55%)] dark:hidden" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_15%_85%,rgba(16,185,129,0.10),transparent_55%)]" />

        <div className="relative space-y-5 p-6">
          <DialogHeader className="space-y-2">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl gradient-brand-soft">
                <GitBranch className="h-5 w-5 text-brand-cyan" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-xl leading-tight">
                  Propose a learning track
                </DialogTitle>
                <DialogDescription className="mt-1">
                  Wrap multiple{" "}
                  <span className="font-medium text-foreground">{skillName}</span> sessions toward
                  one goal. Each session still uses normal credits, the track itself is free.
                  Either side can end it any time.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Goal */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Goal
              </p>
              <span className="text-[11px] text-muted-foreground">{goal.length}/500</span>
            </div>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value.slice(0, 500))}
              placeholder="e.g. Build a Flask API end-to-end, including deployment"
              rows={2}
              className="resize-none rounded-xl border-white/10 bg-white/5 focus-visible:border-brand-purple/40 focus-visible:ring-brand-purple/30"
            />
          </div>

          {/* Pattern */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pattern
            </p>
            <Select value={pattern} onValueChange={(v) => setPattern(v as Pattern)}>
              <SelectTrigger className="h-auto rounded-xl border-white/10 bg-white/5 px-3 py-2.5 hover:border-brand-purple/40 hover:bg-white/[0.08]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-white/10">
                {PATTERN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{currentOption.description}</p>
          </div>

          {pattern !== "one_shot" && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Number of sessions
              </p>
              <Input
                type="number"
                min={1}
                max={currentOption.maxCount}
                value={count}
                onChange={(e) =>
                  setCount(
                    Math.min(currentOption.maxCount, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                className="rounded-xl border-white/10 bg-white/5 hover:border-brand-purple/40 hover:bg-white/[0.08] focus-visible:border-brand-purple/40 focus-visible:ring-brand-purple/30"
              />
            </div>
          )}

          {/* Session length — matches Request-dialog duration buttons */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Session length
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[30, 60, 90].map((d) => {
                const selected = d === duration;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d as 30 | 60 | 90)}
                    className={cn(
                      "rounded-2xl border px-3 py-3.5 text-center transition-all",
                      selected
                        ? "border-brand-purple/60 bg-brand-purple/10 shadow-glow"
                        : "border-white/10 bg-white/5 hover:border-brand-purple/30 hover:bg-white/[0.08]",
                    )}
                  >
                    <div className="text-lg font-bold leading-none">{d} min</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* First session at */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              First session at
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-sm outline-none transition-colors hover:border-brand-purple/40 hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-brand-purple/40"
                  >
                    <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                    {firstStartDate && !Number.isNaN(firstStartDate.getTime()) ? (
                      <span>
                        {firstStartDate.toLocaleDateString(undefined, {
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
                  className="w-auto overflow-hidden rounded-2xl border border-white/10 bg-popover/95 p-0 shadow-glow backdrop-blur-xl"
                  align="start"
                >
                  <Calendar
                    className="bg-transparent"
                    mode="single"
                    selected={firstStartDate ?? undefined}
                    onSelect={(day) => {
                      if (!day) return;
                      const merged = new Date(day);
                      const base = firstStartDate ?? new Date();
                      merged.setHours(base.getHours(), base.getMinutes(), 0, 0);
                      setFirstStart(formatLocal(merged));
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
                  firstStartDate && !Number.isNaN(firstStartDate.getTime())
                    ? `${String(firstStartDate.getHours()).padStart(2, "0")}:${String(firstStartDate.getMinutes()).padStart(2, "0")}`
                    : ""
                }
                onValueChange={(val) => {
                  const [hh, mm] = val.split(":").map(Number);
                  const base = firstStartDate ?? new Date();
                  const merged = new Date(base);
                  merged.setHours(hh, mm, 0, 0);
                  setFirstStart(formatLocal(merged));
                }}
              >
                <SelectTrigger className="h-auto min-w-[120px] rounded-xl border-white/10 bg-white/5 px-3 py-2.5 text-sm hover:border-brand-purple/40 hover:bg-white/[0.08]">
                  <span className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <SelectValue placeholder="Time" />
                  </span>
                </SelectTrigger>
                <SelectContent className="max-h-64 rounded-xl border-white/10">
                  {Array.from({ length: (24 * 60) / TIME_STEP_MIN }).map((_, i) => {
                    const total = i * TIME_STEP_MIN;
                    const h = Math.floor(total / 60);
                    const m = total % 60;
                    const v = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                    const period = h < 12 ? "AM" : "PM";
                    const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
                    return (
                      <SelectItem key={v} value={v}>
                        {`${hh}:${String(m).padStart(2, "0")} ${period}`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Subsequent sessions auto-scheduled every{" "}
              {currentOption.value === "daily" ? "day" : "week"}. The teacher accepts each one
              individually 48h before it starts.
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="hero" size="lg" onClick={submit} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send proposal
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
