import { useEffect, useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { playRequestSentChime } from "@/lib/sounds";
import { toast } from "sonner";
import { SESSION_DURATIONS, type SessionDuration } from "@/lib/sessions";
import { fetchSwapMatch, proposeSwap, type SwapMatch, type SwapSkillOption } from "@/lib/swaps";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  otherUserId: string;
  // Optional pre-known name, just for the title before the match loads.
  otherName?: string;
  onProposed?: () => void;
};

// Lets the signed-in user offer a direct skill swap to `otherUserId`: pick one
// skill to teach them and one of theirs to learn, a free time for each, and
// send. Both become free (no-credit) pending sessions the recipient accepts.
export function SwapProposalDialog({
  open,
  onOpenChange,
  otherUserId,
  otherName,
  onProposed,
}: Props) {
  const { user } = useAuth();
  const [match, setMatch] = useState<SwapMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [mySkill, setMySkill] = useState<SwapSkillOption | null>(null);
  const [theirSkill, setTheirSkill] = useState<SwapSkillOption | null>(null);
  const [myDuration, setMyDuration] = useState<SessionDuration>(60);
  const [theirDuration, setTheirDuration] = useState<SessionDuration>(60);

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
    setMyDuration(60);
    setTheirDuration(60);
    setMyWhen(null);
    setMyWhenValid(false);
    setTheirWhen(null);
    setTheirWhenValid(false);
    (async () => {
      const m = await fetchSwapMatch(otherUserId);
      if (!alive) return;
      setMatch(m);
      setMySkill(m?.iCanTeach[0] ?? null);
      setTheirSkill(m?.theyCanTeach[0] ?? null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [open, otherUserId]);

  const hasOverlap = Boolean(match && match.iCanTeach.length && match.theyCanTeach.length);

  // The same two people attend both sessions, so the legs can't overlap in
  // time — you can't teach and learn at once. Standard interval check:
  // [startA, endA) intersects [startB, endB).
  const legsClash =
    !!myWhen &&
    !!theirWhen &&
    myWhen.getTime() < theirWhen.getTime() + theirDuration * 60_000 &&
    theirWhen.getTime() < myWhen.getTime() + myDuration * 60_000;

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
        myDuration,
        myScheduledAt: myWhen.toISOString(),
        theirSkillId: theirSkill.skillId,
        theirDuration,
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
      <DialogContent className="w-[calc(100%-2rem)] max-w-md max-h-[90vh] overflow-hidden rounded-2xl border-white/10 glass-strong p-0 gap-0">
        <div className="pointer-events-none absolute inset-0 gradient-hero opacity-80" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.22),transparent_55%)] dark:hidden" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_15%_85%,rgba(16,185,129,0.10),transparent_55%)]" />

        <div className="relative max-h-[90vh] space-y-3.5 overflow-y-auto p-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
                <ArrowLeftRight className="h-4 w-4 text-brand-purple" />
              </div>
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-snug">
              A direct swap is two free sessions. No credits change hands. You each teach the other
              one skill.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !hasOverlap ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-muted-foreground">
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
                duration={myDuration}
                onDuration={setMyDuration}
                teacherId={user?.id}
                when={myWhen}
                onWhen={setMyWhen}
                onWhenValid={setMyWhenValid}
                active={open}
              />

              {/* They teach you */}
              <SwapLegEditor
                heading="They teach you"
                tone="purple"
                options={match!.theyCanTeach}
                selected={theirSkill}
                onSelect={setTheirSkill}
                duration={theirDuration}
                onDuration={setTheirDuration}
                teacherId={otherUserId}
                when={theirWhen}
                onWhen={setTheirWhen}
                onWhenValid={setTheirWhenValid}
                active={open}
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

function SwapLegEditor({
  heading,
  tone,
  options,
  selected,
  onSelect,
  duration,
  onDuration,
  teacherId,
  when,
  onWhen,
  onWhenValid,
  active,
}: {
  heading: string;
  tone: "cyan" | "purple";
  options: SwapSkillOption[];
  selected: SwapSkillOption | null;
  onSelect: (s: SwapSkillOption) => void;
  duration: SessionDuration;
  onDuration: (d: SessionDuration) => void;
  teacherId?: string;
  when: Date | null;
  onWhen: (d: Date | null) => void;
  onWhenValid: (v: boolean) => void;
  active: boolean;
}) {
  const accent = tone === "cyan" ? "text-brand-cyan" : "text-brand-purple";
  const selectedRing =
    tone === "cyan"
      ? "border-brand-cyan/60 bg-brand-cyan/10"
      : "border-brand-purple/60 bg-brand-purple/10";
  // Reset the chosen time when the duration changes (a different length may no
  // longer fit the previously valid slot).
  const durationKey = useMemo(() => duration, [duration]);
  useEffect(() => {
    onWhen(null);
    onWhenValid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationKey]);

  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
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
                  : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.08]",
              )}
            >
              {opt.name}
            </button>
          );
        })}
      </div>

      {/* Duration */}
      <div className="grid grid-cols-3 gap-2">
        {SESSION_DURATIONS.map((value) => {
          const isSel = value === duration;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onDuration(value)}
              className={cn(
                "rounded-lg border px-2 py-1.5 text-center text-xs font-semibold transition-all",
                isSel
                  ? selectedRing
                  : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.08]",
              )}
            >
              {value} min
            </button>
          );
        })}
      </div>

      {/* When (constrained to the teacher's free windows) */}
      <TeacherSlotPicker
        teacherId={teacherId}
        durationMinutes={duration}
        value={when}
        onChange={onWhen}
        onValidityChange={onWhenValid}
        active={active}
      />
    </div>
  );
}
