import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
    description: "A single session — no recurrence.",
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Propose a learning track</DialogTitle>
          <DialogDescription>
            A track wraps multiple sessions for {skillName}. Each session inside still uses normal
            credits — the track itself is free. Either side can end it any time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Goal</Label>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value.slice(0, 500))}
              placeholder="e.g. Build a Flask API end-to-end, including deployment"
              rows={2}
            />
            <p className="mt-1 text-xs text-muted-foreground">{goal.length}/500</p>
          </div>

          <div>
            <Label>Pattern</Label>
            <Select value={pattern} onValueChange={(v) => setPattern(v as Pattern)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATTERN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">{currentOption.description}</p>
          </div>

          {pattern !== "one_shot" && (
            <div>
              <Label>Number of sessions</Label>
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
              />
            </div>
          )}

          <div>
            <Label>Session length</Label>
            <div className="grid grid-cols-3 gap-2">
              {[30, 60, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d as 30 | 60 | 90)}
                  className={`rounded-xl border px-3 py-2 text-sm ${
                    d === duration
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:border-primary/40"
                  }`}
                >
                  {d} min
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="first-start">First session at</Label>
            <Input
              id="first-start"
              type="datetime-local"
              value={firstStart}
              onChange={(e) => setFirstStart(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Subsequent sessions auto-scheduled every{" "}
              {currentOption.value === "daily" ? "day" : "week"}. The teacher accepts each one
              individually 48h before it starts.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="hero" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Send proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
