import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, Check, Loader2, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/UserAvatar";
import { toast } from "sonner";
import { canJoinSession, describeJoinWindow } from "@/lib/sessions";
import { cancelSwap, fetchMySwaps, respondToSwap, type SwapLeg, type SwapPair } from "@/lib/swaps";

// The dashboard surface for direct skill swaps. Swap sessions are deliberately
// kept out of the ordinary session lists (their accept/credit flow differs), so
// this card is where a user accepts, declines, cancels, and joins them.
//
// `refreshKey`: bump to refetch. The dashboard ties it to its sessions
// realtime channel so an incoming proposal appears without a manual refresh.
export function SwapInbox({
  refreshKey = 0,
  onChanged,
}: {
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const [swaps, setSwaps] = useState<SwapPair[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await fetchMySwaps();
    setSwaps(data);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await fetchMySwaps();
      if (alive) setSwaps(data);
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const respond = async (swap: SwapPair, accept: boolean) => {
    setBusyId(swap.swapId);
    try {
      const { error } = await respondToSwap(swap.swapId, accept);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(accept ? "Swap accepted. See you in session!" : "Swap declined.");
      await load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (swap: SwapPair) => {
    setBusyId(swap.swapId);
    try {
      const { error } = await cancelSwap(swap.swapId);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Swap cancelled.");
      await load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  // Nothing to show — stay invisible so the dashboard isn't cluttered.
  if (!swaps || swaps.length === 0) return null;

  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
      <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
        <ArrowLeftRight className="h-3.5 w-3.5" /> Skill swaps
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5">
        {swaps.map((swap) => (
          <SwapCard
            key={swap.swapId}
            swap={swap}
            busy={busyId === swap.swapId}
            onAccept={() => respond(swap, true)}
            onDecline={() => respond(swap, false)}
            onCancel={() => cancel(swap)}
          />
        ))}
      </div>
    </section>
  );
}

function SwapCard({
  swap,
  busy,
  onAccept,
  onDecline,
  onCancel,
}: {
  swap: SwapPair;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
}) {
  const pending = swap.status === "pending";
  const incoming = swap.direction === "incoming";

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/40 bg-card/60 p-4 transition-all hover:-translate-y-0.5 hover:border-brand-purple/40 hover:shadow-md hover:shadow-brand-purple/5">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-brand-purple/10 to-brand-cyan/10 opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative flex flex-col gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: swap.otherUserId }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
        >
          <UserAvatar
            name={swap.otherName}
            url={swap.otherAvatarUrl}
            className="h-11 w-11 shrink-0 ring-2 ring-background"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm md:text-base font-semibold truncate leading-tight">
              {swap.otherName}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              {pending
                ? incoming
                  ? "Wants to swap skills with you"
                  : "Waiting for them to respond"
                : "Swap confirmed"}
            </p>
          </div>
        </Link>

        <div className="relative grid grid-cols-2 gap-2">
          <LegPanel
            label="You teach"
            leg={swap.iTeach}
            showActions={!pending}
            busy={busy}
            onCancel={onCancel}
          />
          <LegPanel
            label="You learn"
            leg={swap.theyTeach}
            showActions={!pending}
            busy={busy}
            onCancel={onCancel}
          />
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-card shadow-sm">
            <ArrowLeftRight className="h-3 w-3 text-brand-purple" />
          </div>
        </div>

        {pending && (
          <div className="flex items-center gap-2">
            {incoming ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 rounded-full"
                  onClick={onDecline}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  Decline
                </Button>
                <Button
                  variant="hero"
                  size="sm"
                  className="flex-1 rounded-full"
                  onClick={onAccept}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Accept
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="flex-1 rounded-full"
                onClick={onCancel}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// One side of the exchange. When the swap is confirmed each panel carries its
// own Join (that leg's video session) and Cancel. Cancelling either leg
// cancels the whole swap — the pair only exists together.
function LegPanel({
  label,
  leg,
  showActions,
  busy,
  onCancel,
}: {
  label: string;
  leg: SwapLeg;
  showActions: boolean;
  busy: boolean;
  onCancel: () => void;
}) {
  const joinable = canJoinSession(leg.scheduledAt, leg.durationMinutes);
  const window = describeJoinWindow(leg.scheduledAt, leg.durationMinutes);
  const whenText = leg.scheduledAt
    ? new Date(leg.scheduledAt).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Time to be set";

  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-secondary/40 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-semibold">{leg.skillName}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{whenText}</p>
      {showActions && (
        <div className="mt-auto flex items-center gap-1.5 pt-3">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onCancel}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            Cancel
          </Button>
          {joinable ? (
            <Button variant="hero" size="sm" className="flex-1 rounded-full" asChild>
              <Link to="/video/$sessionId" params={{ sessionId: leg.sessionId }}>
                <Video className="h-3.5 w-3.5" />
                Join
              </Link>
            </Button>
          ) : (
            <Button variant="hero" size="sm" className="flex-1 rounded-full" disabled>
              <Video className="h-3.5 w-3.5" />
              {window ?? "Join"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
