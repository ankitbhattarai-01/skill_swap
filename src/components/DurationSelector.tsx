import { cn } from "@/lib/utils";
import { SESSION_DURATIONS, computeSessionCredits, type SessionDuration } from "@/lib/sessions";

type Tone = "purple" | "cyan";

// One selected-state language shared by every place a session length is picked,
// so the request dialog and the swap (help-offer) dialog read as one system.
const TONE = {
  purple: {
    card: "border-brand-purple/60 bg-brand-purple/10 shadow-glow",
    inline: "border-brand-purple/50 bg-brand-purple/15 text-brand-purple",
    accent: "text-brand-purple",
  },
  cyan: {
    card: "border-brand-cyan/60 bg-brand-cyan/10 shadow-glow",
    inline: "border-brand-cyan/50 bg-brand-cyan/15 text-brand-cyan",
    accent: "text-brand-cyan",
  },
} as const;

type Props = {
  value: SessionDuration;
  onChange: (d: SessionDuration) => void;
  // Selected accent — lets swap legs keep their cyan/purple colour-coding while
  // sharing the same shape and interaction.
  tone?: Tone;
  // "cards" — the prominent 3-up grid (request dialog). "inline" — a compact
  // segmented control that tucks into a header row (swap legs).
  variant?: "cards" | "inline";
  // When provided, each card shows its credit cost. Omit for free swaps.
  creditsPerHour?: number;
  className?: string;
};

export function DurationSelector({
  value,
  onChange,
  tone = "purple",
  variant = "cards",
  creditsPerHour,
  className,
}: Props) {
  const t = TONE[tone];

  if (variant === "inline") {
    return (
      <div
        role="radiogroup"
        aria-label="Session length"
        className={cn("inline-flex items-center gap-1", className)}
      >
        {SESSION_DURATIONS.map((v) => {
          const selected = v === value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(v)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-all",
                selected
                  ? t.inline
                  : "border-border bg-muted text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
              )}
            >
              {v} min
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Session length"
      className={cn("grid grid-cols-3 gap-2", className)}
    >
      {SESSION_DURATIONS.map((v) => {
        const selected = v === value;
        const cost = creditsPerHour != null ? computeSessionCredits(creditsPerHour, v) : null;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(v)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2.5 transition-all",
              selected
                ? t.card
                : "border-border bg-muted hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]",
            )}
          >
            <span className="text-lg font-bold leading-none tabular-nums">
              {v}
              <span className="ml-0.5 text-[10px] font-medium text-muted-foreground">min</span>
            </span>
            {cost != null && (
              <span
                className={cn(
                  "text-[11px] font-medium leading-none",
                  selected ? t.accent : "text-muted-foreground",
                )}
              >
                {cost} cr
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
