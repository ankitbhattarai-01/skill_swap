import { useEffect, useState } from "react";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TeacherSlotPicker } from "@/components/TeacherSlotPicker";
import { SlotPickerSkeleton } from "@/components/SlotPickerSkeleton";
import { DurationSelector } from "@/components/DurationSelector";
import { cn } from "@/lib/utils";
import { prefetchAvailability } from "@/lib/availability-cache";
import { useAuth } from "@/lib/auth-context";
import { playRequestSentChime } from "@/lib/sounds";
import { toast } from "sonner";
import { type SessionDuration } from "@/lib/sessions";
import { fetchSwapMatch, proposeSwap, type SwapMatch, type SwapSkillOption } from "@/lib/swaps";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  otherUserId: string;
  // Optional pre-known name, just for the title before the match loads.
  otherName?: string;
  // When the dialog is opened from a suggestion that named specific skills
  // ("Swap Figma for Guitar"), pre-select those legs instead of the first
  // overlap, so what the user clicked matches what opens. Id wins when the
  // caller has one; the name is the fallback (matched case-insensitively), and
  // an unmatched hint falls back to the first option.
  preferMySkillName?: string;
  preferMySkillId?: string;
  preferTheirSkillName?: string;
  preferTheirSkillId?: string;
  onProposed?: () => void;
};

// How long the form will wait for the (already in-flight) calendar warm-up
// before giving up and rendering anyway. Long enough to absorb a normal RPC,
// short enough that a stalled one can't hold the whole panel hostage — the
// pickers still have their own chip skeleton for that case.
const WARM_WAIT_MS = 1200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Picks the option identified by `id`, else the one whose name matches `name`
// (case-insensitive), else the first option, else null. Id first because skill
// names are not unique enough to trust ("Guitar" vs "Guitar (Acoustic)").
function pickSkill(options: SwapSkillOption[], name?: string, id?: string): SwapSkillOption | null {
  if (id) {
    const byId = options.find((o) => o.skillId === id);
    if (byId) return byId;
  }
  if (name) {
    const match = options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return options[0] ?? null;
}

// Lets the signed-in user offer a direct skill swap to `otherUserId`: pick one
// skill to teach them and one of theirs to learn, a free time for each, and
// send. Both become free (no-credit) pending sessions the recipient accepts.
export function SwapProposalDialog({
  open,
  onOpenChange,
  otherUserId,
  otherName,
  preferMySkillName,
  preferMySkillId,
  preferTheirSkillName,
  preferTheirSkillId,
  onProposed,
}: Props) {
  const { user } = useAuth();
  const [match, setMatch] = useState<SwapMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [mySkill, setMySkill] = useState<SwapSkillOption | null>(null);
  const [theirSkill, setTheirSkill] = useState<SwapSkillOption | null>(null);
  // One length for the whole swap — both sessions run equally long, so there's
  // nothing to negotiate per leg.
  const [duration, setDuration] = useState<SessionDuration>(60);

  const [myWhen, setMyWhen] = useState<Date | null>(null);
  const [myWhenValid, setMyWhenValid] = useState(false);
  const [theirWhen, setTheirWhen] = useState<Date | null>(null);
  const [theirWhenValid, setTheirWhenValid] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setMatch(null);
    setMySkill(null);
    setTheirSkill(null);
    setDuration(60);
    setMyWhen(null);
    setMyWhenValid(false);
    setTheirWhen(null);
    setTheirWhenValid(false);
    // Both calendars are needed no matter which skills the match turns out to
    // contain, and their ids are known before any of this resolves — so they go
    // out now, alongside the match query. Previously they could not start until
    // the match had landed, because the pickers that request them only mount
    // once `loading` flips: the dialog paid match latency *then* calendar
    // latency, and showed a fresh skeleton for the second wait.
    const warm = prefetchAvailability([user?.id, otherUserId]);
    (async () => {
      const m = await fetchSwapMatch(otherUserId, user?.id);
      if (!alive) return;
      // Hold the skeleton for whatever is left of the warm-up rather than
      // revealing a form whose pickers immediately re-skeleton themselves.
      // It costs nothing on the common path — the calendar RPC is the faster
      // of the two and has usually already resolved by here.
      await Promise.race([warm, sleep(WARM_WAIT_MS)]);
      if (!alive) return;
      setMatch(m);
      setMySkill(pickSkill(m?.iCanTeach ?? [], preferMySkillName, preferMySkillId));
      setTheirSkill(pickSkill(m?.theyCanTeach ?? [], preferTheirSkillName, preferTheirSkillId));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [
    open,
    otherUserId,
    user?.id,
    preferMySkillName,
    preferMySkillId,
    preferTheirSkillName,
    preferTheirSkillId,
  ]);

  const hasOverlap = Boolean(match && match.iCanTeach.length && match.theyCanTeach.length);

  // The same two people attend both sessions, so the legs can't overlap in
  // time — you can't teach and learn at once. Standard interval check:
  // [startA, endA) intersects [startB, endB).
  const legsClash =
    !!myWhen &&
    !!theirWhen &&
    myWhen.getTime() < theirWhen.getTime() + duration * 60_000 &&
    theirWhen.getTime() < myWhen.getTime() + duration * 60_000;

  const canSubmit =
    !busy &&
    hasOverlap &&
    !!mySkill &&
    !!theirSkill &&
    !!myWhen &&
    myWhenValid &&
    !!theirWhen &&
    theirWhenValid &&
    !legsClash;

  const submit = async () => {
    if (!user || !mySkill || !theirSkill || !myWhen || !theirWhen) return;
    setBusy(true);
    try {
      const { error } = await proposeSwap({
        recipientId: otherUserId,
        mySkillId: mySkill.skillId,
        myDuration: duration,
        myScheduledAt: myWhen.toISOString(),
        theirSkillId: theirSkill.skillId,
        theirDuration: duration,
        theirScheduledAt: theirWhen.toISOString(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      playRequestSentChime();
      toast.success(`Swap proposed to ${match?.otherName ?? "them"}. They'll accept each side.`);
      onProposed?.();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const title = `Swap with ${match?.otherName ?? otherName ?? "this student"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `dialog-anchored` (styles.css) pins the top edge instead of centring
          on the panel's own height. The height here genuinely varies — one
          skill chip or five, three suggestions or an error line — and centred,
          every one of those differences moves the title and the buttons. The
          scroll region takes its bound from the panel rather than restating a
          vh of its own, so the two can't disagree. */}
      <DialogContent className="dialog-anchored max-w-md gap-0 overflow-hidden p-0">
        <div className="dialog-scroll relative space-y-3.5 overflow-y-auto p-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
                <ArrowLeftRight className="h-4 w-4 text-brand-purple" />
              </div>
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-snug">
              You each teach the other one skill. Two sessions, no credits change hands.
            </DialogDescription>
          </DialogHeader>

          {/* One length for both legs — a swap trades equal time. Nothing the
              fetch returns changes this row, so it renders for real from the
              first frame instead of as a placeholder that has to be swapped
              out: same element before and after, therefore no drift. */}
          {(loading || hasOverlap) && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted px-3 py-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Session length
                </p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Both sessions run this long.
                </p>
              </div>
              <DurationSelector variant="inline" value={duration} onChange={setDuration} />
            </div>
          )}

          {loading ? (
            <SwapFormSkeleton
              mySkillLabel={preferMySkillName}
              theirSkillLabel={preferTheirSkillName}
            />
          ) : !hasOverlap ? (
            <div className="rounded-xl border border-dashed border-border bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
              {match && match.iCanTeach.length === 0 && match.theyCanTeach.length === 0
                ? "No swap match yet. You'd each need to teach a skill the other wants to learn."
                : match && match.iCanTeach.length === 0
                  ? "They don't want to learn any skill you teach yet, so there's nothing to swap."
                  : "You don't want to learn any skill they teach yet. Add it to your learning list to swap."}
            </div>
          ) : (
            <>
              {/* You teach them */}
              <SwapLegEditor
                heading="You teach them"
                tone="cyan"
                options={match!.iCanTeach}
                selected={mySkill}
                onSelect={setMySkill}
                duration={duration}
                teacherId={user?.id}
                when={myWhen}
                onWhen={setMyWhen}
                onWhenValid={setMyWhenValid}
                active={open}
              />

              {/* They teach you. Excludes the first leg's time range so its
                  suggestions and auto-filled pick can't clash with it — the
                  exclusion is one-directional to keep the two auto-fills from
                  endlessly dodging each other. */}
              <SwapLegEditor
                heading="They teach you"
                tone="purple"
                options={match!.theyCanTeach}
                selected={theirSkill}
                onSelect={setTheirSkill}
                duration={duration}
                teacherId={otherUserId}
                when={theirWhen}
                onWhen={setTheirWhen}
                onWhenValid={setTheirWhenValid}
                active={open}
                excludeInterval={
                  myWhen
                    ? { start: myWhen.getTime(), end: myWhen.getTime() + duration * 60_000 }
                    : null
                }
              />

              {legsClash && (
                <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-500 dark:text-amber-400">
                  These two sessions overlap in time — you can&apos;t teach and learn at once. Pick
                  times that don&apos;t clash.
                </p>
              )}
            </>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="hero" onClick={submit} disabled={!canSubmit}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Propose swap
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Stand-in for the two leg cards while the swap match is fetched — same
// wrappers, same paddings, same font sizes as the real ones, so the swap to
// loaded content is a repaint rather than a reflow. (The length row above is
// not part of this: it doesn't depend on the fetch, so it renders for real.)
//
// One chip per leg, not an arbitrary two: the overwhelming case is a single
// overlapping skill, and when the caller opened the dialog from a suggestion it
// already knows the name — rendering that exact word transparently makes the
// placeholder the width of the chip that replaces it.
function SwapFormSkeleton({
  mySkillLabel,
  theirSkillLabel,
}: {
  mySkillLabel?: string;
  theirSkillLabel?: string;
}) {
  const legs = [
    { tone: "cyan", heading: "You teach them", label: mySkillLabel },
    { tone: "purple", heading: "They teach you", label: theirSkillLabel },
  ] as const;

  return (
    <div className="space-y-3.5" aria-hidden>
      {legs.map(({ tone, heading, label }) => (
        <div key={tone} className="space-y-2 rounded-xl border border-border bg-muted p-3">
          <p
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              tone === "cyan" ? "text-brand-cyan" : "text-brand-purple",
            )}
          >
            {heading}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="animate-pulse rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-transparent">
              {label ?? "Skill"}
            </span>
          </div>
          {/* Legs render the picker in compact mode, so the stand-in must too. */}
          <SlotPickerSkeleton compact />
        </div>
      ))}
    </div>
  );
}

function SwapLegEditor({
  heading,
  tone,
  options,
  selected,
  onSelect,
  duration,
  teacherId,
  when,
  onWhen,
  onWhenValid,
  active,
  excludeInterval,
}: {
  heading: string;
  tone: "cyan" | "purple";
  options: SwapSkillOption[];
  selected: SwapSkillOption | null;
  onSelect: (s: SwapSkillOption) => void;
  duration: SessionDuration;
  teacherId?: string;
  when: Date | null;
  onWhen: (d: Date | null) => void;
  onWhenValid: (v: boolean) => void;
  active: boolean;
  excludeInterval?: { start: number; end: number } | null;
}) {
  const accent = tone === "cyan" ? "text-brand-cyan" : "text-brand-purple";
  const selectedRing =
    tone === "cyan"
      ? "border-brand-cyan/60 bg-brand-cyan/10"
      : "border-brand-purple/60 bg-brand-purple/10";
  // Reset the chosen time when the duration changes (a different length may no
  // longer fit the previously valid slot).
  useEffect(() => {
    onWhen(null);
    onWhenValid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted p-3">
      <p className={cn("text-[10px] font-semibold uppercase tracking-wider", accent)}>{heading}</p>

      {/* Skill */}
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isSel = selected?.skillId === opt.skillId;
          return (
            <button
              key={opt.skillId}
              type="button"
              onClick={() => onSelect(opt)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-all",
                isSel
                  ? selectedRing
                  : "border-border bg-muted hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]",
              )}
            >
              {opt.name}
            </button>
          );
        })}
      </div>

      {/* When: the suggested chips are the choices; "Custom…" opens the full
          date/time picker (still constrained to the teacher's free windows). */}
      <TeacherSlotPicker
        compact
        teacherId={teacherId}
        durationMinutes={duration}
        value={when}
        onChange={onWhen}
        onValidityChange={onWhenValid}
        active={active}
        excludeIntervals={excludeInterval ? [excludeInterval] : undefined}
      />
    </div>
  );
}
