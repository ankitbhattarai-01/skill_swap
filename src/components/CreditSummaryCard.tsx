import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

// The stat tile in the /credits hero, shared with /credits/buy so the two pages
// read as one screen. Tones are fixed rather than free-form on purpose: purple
// is always "what you have", emerald "what's coming in", orange "what's going
// out", across both pages.
export type CreditSummaryTone = "balance" | "earned" | "spent";

const TONES: Record<CreditSummaryTone, { value: string; badge: string; hover: string }> = {
  balance: {
    value: "text-brand-purple",
    badge: "bg-brand-purple/15 text-brand-purple ring-1 ring-brand-purple/20",
    hover: "hover:border-brand-purple/30 hover:shadow-glow",
  },
  earned: {
    value: "text-emerald-400",
    badge: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
    hover: "hover:border-brand-cyan/30 hover:shadow-glow-blue",
  },
  spent: {
    value: "text-orange-400",
    badge: "bg-orange-400/15 text-orange-400 ring-1 ring-orange-400/20",
    hover: "hover:border-orange-400/30",
  },
};

export function CreditSummaryCard({
  label,
  value,
  caption,
  tone,
  icon: Icon,
  // Rendered small and ahead of the number, for tiles that show money rather
  // than credits ("Rs 225"). Keeps the big figure the same size on both pages.
  prefix,
  // Defaults to "Credits"; pass null for a tile whose number isn't credits.
  unit = "Credits",
}: {
  label: string;
  value: number | string;
  caption: string;
  tone: CreditSummaryTone;
  icon: LucideIcon;
  prefix?: string;
  unit?: string | null;
}) {
  const toneStyles = TONES[tone];

  return (
    <article
      className={cn(
        "group rounded-2xl border border-white/10 bg-white/5 px-5 py-4 transition-all hover:-translate-y-0.5 sm:px-5 sm:py-5",
        toneStyles.hover,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          <div
            className={cn(
              "mt-2 flex items-baseline gap-1 text-4xl font-bold leading-none sm:text-5xl",
              toneStyles.value,
            )}
          >
            {prefix && <span className="text-sm font-semibold">{prefix}</span>}
            <span className="tabular-nums">{value}</span>
            {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{caption}</p>
        </div>
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            toneStyles.badge,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </article>
  );
}
