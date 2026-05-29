import type { ElementType } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { metricValue } from "@/lib/admin-format";

// Compact metric tile used across admin dashboards (overview, health). Two
// near-identical copies existed before — admin.index typed `value` as
// `unknown` (so it could surface arbitrary JSON values), admin.health typed
// it as `number | undefined`. The shared signature takes `unknown` and runs
// it through `metricValue` so a non-number degrades gracefully to "0".
export type KpiTileTone = "default" | "warn" | "danger";

// Routes a tile may drill into. Constrained to the admin surface so a typo
// can't compile (TanStack Router type-checks `to` against the route tree).
export type KpiTileLink =
  | "/admin"
  | "/admin/users"
  | "/admin/sessions"
  | "/admin/finance"
  | "/admin/reports"
  | "/admin/skills";

export function KpiTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  to,
}: {
  icon: ElementType;
  label: string;
  value: unknown;
  hint?: string;
  tone?: KpiTileTone;
  // When provided, the whole tile becomes a drill-down link to that admin
  // page. Tiles without a matching destination page stay static.
  to?: KpiTileLink;
}) {
  const className = cn(
    "group relative flex min-h-32 flex-col rounded-2xl border bg-card/80 p-4 shadow-sm transition-all",
    to && "hover:-translate-y-0.5 hover:shadow-md hover:border-primary/40",
    tone === "warn" && "border-amber-500/40 bg-amber-500/5",
    tone === "danger" && "border-destructive/40 bg-destructive/5",
    tone === "default" && "border-border/70",
  );

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-medium leading-5 text-muted-foreground">{label}</div>
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground",
            tone === "warn" && "bg-amber-500/15 text-amber-400",
            tone === "danger" && "bg-destructive/15 text-destructive",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-auto pt-4 text-3xl font-semibold tracking-tight">{metricValue(value)}</div>
      {hint && (
        <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {hint}
        </div>
      )}
      {to && (
        <ArrowUpRight className="absolute bottom-4 right-4 h-4 w-4 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
      )}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={className} aria-label={`${label}: view details`}>
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}

// Smaller two-line tile used by admin.finance / admin.access / admin.security
// / admin.sessions / admin.compliance / admin.settings dashboards. Same data
// shape as KpiTile minus the icon and tone — those routes already wrap it in
// their own colored card containers.
export function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{metricValue(value)}</div>
    </div>
  );
}
