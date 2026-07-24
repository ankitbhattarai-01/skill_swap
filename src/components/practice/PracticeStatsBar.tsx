import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Flame, X } from "lucide-react";
import { DIFFICULTY_LABEL, DIFFICULTY_TONE, type PracticeLevel } from "@/lib/practice";

// The sticky bar over the solving view: which skill + difficulty is in play, the
// running session tally (solved / attempted / accuracy / streak), and an exit
// back to the picker.

type Props = {
  skillName: string;
  level: PracticeLevel;
  solved: number;
  attempted: number;
  streak: number;
  onExit: () => void;
};

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="text-center">
      <div className={cn("text-lg font-bold leading-none tabular-nums md:text-xl", className)}>
        {value}
      </div>
      <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

export function PracticeStatsBar({ skillName, level, solved, attempted, streak, onExit }: Props) {
  const tone = DIFFICULTY_TONE[level];
  const accuracy = attempted > 0 ? Math.round((solved / attempted) * 100) : 0;

  return (
    <div className="sticky top-[calc(118px+env(safe-area-inset-top))] z-20 rounded-2xl border border-border/60 glass-strong px-4 py-3 md:top-20">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight md:text-lg">
              {skillName}
            </h1>
            <span
              className={cn(
                "mt-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                tone.chip,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
              {DIFFICULTY_LABEL[level]}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 md:gap-6">
          <Stat label="Solved" value={String(solved)} className="text-brand-cyan" />
          <Stat label="Attempts" value={String(attempted)} />
          <Stat label="Accuracy" value={`${accuracy}%`} />
          <Stat
            label="Streak"
            value={streak > 0 ? `${streak}🔥` : "0"}
            className={streak > 0 ? "text-brand-yellow" : undefined}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={onExit}
            className="h-9 gap-1.5 rounded-xl text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
            <span className="hidden sm:inline">Exit</span>
          </Button>
        </div>
      </div>
      {/* Flame accent is decorative reinforcement of the streak stat on wider
          screens where the emoji alone can read as noise. */}
      {streak >= 3 && (
        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-yellow">
          <Flame className="h-3.5 w-3.5" />
          {streak} in a row — keep it going!
        </div>
      )}
    </div>
  );
}
