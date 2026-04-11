import { useEffect, useState } from "react";
import { AlertTriangle, ShieldAlert, ShieldX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type StrikeSummary = {
  kind: string;
  suspension_expires_at: string | null;
  active_strike_weight: number;
  next_strike_expires_at: string | null;
};

export function StrikeBanner() {
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

  if (summary.kind === "permanent") {
    return (
      <BannerShell tone="danger" icon={<ShieldX className="h-5 w-5" />}>
        <span className="font-medium">Account suspended.</span> Your account has reached the
        permanent-strike threshold. Contact support if you believe this is in error.
      </BannerShell>
    );
  }

  if (summary.kind === "full") {
    return (
      <BannerShell tone="danger" icon={<ShieldAlert className="h-5 w-5" />}>
        <span className="font-medium">You cannot accept new sessions.</span> Suspension ends{" "}
        {formatDate(summary.suspension_expires_at)}. Existing sessions still work.
      </BannerShell>
    );
  }

  if (summary.kind === "teaching_only") {
    return (
      <BannerShell tone="warning" icon={<ShieldAlert className="h-5 w-5" />}>
        <span className="font-medium">Teaching paused.</span> You can&apos;t accept new teaching
        requests until {formatDate(summary.suspension_expires_at)}. You can still learn.
      </BannerShell>
    );
  }

  return (
    <BannerShell tone="info" icon={<AlertTriangle className="h-5 w-5" />}>
      You have <span className="font-medium">{summary.active_strike_weight} active strike(s)</span>.
      Avoid late cancellations and no-shows to keep your account in good standing.
      {summary.next_strike_expires_at && (
        <> Next strike expires {formatDate(summary.next_strike_expires_at)}.</>
      )}
    </BannerShell>
  );
}

function BannerShell({
  tone,
  icon,
  children,
}: {
  tone: "info" | "warning" | "danger";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-900 dark:text-rose-100"
      : tone === "warning"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100"
        : "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100";
  return (
    <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>{children}</div>
    </div>
  );
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
