import { useEffect, useState } from "react";
import { ShieldAlert, ShieldX, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type StrikeSummary = {
  kind: string;
  suspension_expires_at: string | null;
  active_strike_weight: number;
  next_strike_expires_at: string | null;
};

type Tone = "info" | "warning" | "danger";

export function StrikeIndicator() {
  const [summary, setSummary] = useState<StrikeSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void supabase
      .rpc("my_strike_summary")
      .abortSignal(controller.signal)
      .then(({ data }) => {
        if (!alive) return;
        const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
        setSummary(row as StrikeSummary | null);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  if (!summary || summary.active_strike_weight === 0) return null;

  const { tone, Icon, title, body } = describeStrike(summary);

  const toneRing =
    tone === "danger"
      ? "bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 ring-1 ring-rose-500/30"
      : tone === "warning"
        ? "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 ring-1 ring-amber-500/30 dark:text-amber-400"
        : "bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 ring-1 ring-sky-500/30 dark:text-sky-400";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="View account strikes"
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
            toneRing,
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                tone === "danger"
                  ? "bg-rose-500"
                  : tone === "warning"
                    ? "bg-amber-500"
                    : "bg-sky-500",
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                tone === "danger"
                  ? "bg-rose-500"
                  : tone === "warning"
                    ? "bg-amber-500"
                    : "bg-sky-500",
              )}
            />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-strong w-80 p-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
              tone === "danger"
                ? "bg-rose-500/15 text-rose-500"
                : tone === "warning"
                  ? "bg-amber-500/15 text-amber-500"
                  : "bg-sky-500/15 text-sky-500",
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 space-y-1">
            <div className="text-sm font-semibold">{title}</div>
            <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function describeStrike(s: StrikeSummary): {
  tone: Tone;
  Icon: typeof ShieldAlert;
  title: string;
  body: string;
} {
  if (s.kind === "permanent") {
    return {
      tone: "danger",
      Icon: ShieldX,
      title: "Account suspended",
      body: "Your account has reached the permanent-strike threshold. Contact support if you believe this is in error.",
    };
  }
  if (s.kind === "full") {
    return {
      tone: "danger",
      Icon: ShieldAlert,
      title: "Cannot accept new sessions",
      body: `Suspension ends ${formatDate(s.suspension_expires_at)}. Existing sessions still work.`,
    };
  }
  if (s.kind === "teaching_only") {
    return {
      tone: "warning",
      Icon: ShieldAlert,
      title: "Teaching paused",
      body: `You can't accept new teaching requests until ${formatDate(s.suspension_expires_at)}. You can still learn.`,
    };
  }
  return {
    tone: "info",
    Icon: AlertTriangle,
    title: `${s.active_strike_weight} active strike${s.active_strike_weight === 1 ? "" : "s"}`,
    body: s.next_strike_expires_at
      ? `Avoid late cancellations and no-shows to keep your account in good standing. Next strike expires ${formatDate(s.next_strike_expires_at)}.`
      : "Avoid late cancellations and no-shows to keep your account in good standing.",
  };
}

function formatDate(iso: string | null) {
  if (!iso) return "soon";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "soon";
  }
}
