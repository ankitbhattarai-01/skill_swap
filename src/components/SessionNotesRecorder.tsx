import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionNotesRecorder as SessionNotesRecorderState } from "@/lib/use-session-notes-recorder";
import { Circle, Loader2, Sparkles } from "lucide-react";

function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

type Props = {
  recorder: SessionNotesRecorderState;
  disabled?: boolean;
};

export function SessionNotesRecorder({ recorder, disabled }: Props) {
  const [consentChecked, setConsentChecked] = useState(false);
  const { status, elapsedMs, supported, consentOpen, setConsentOpen } = recorder;

  if (!supported) return null;

  return (
    <>
      {/* 'ready' is included so a second stretch of the same call can be
          recorded — the notes are regenerated from the newer audio. */}
      {status === "idle" || status === "failed" || status === "ready" ? (
        <Button variant="outline" onClick={recorder.requestStart} disabled={disabled}>
          <Sparkles className="h-4 w-4" />
          {status === "failed" ? "Retry AI Notes" : status === "ready" ? "Record again" : "AI Notes"}
        </Button>
      ) : null}

      {status === "recording" ? (
        <Button variant="destructive" onClick={() => void recorder.stopAndGenerate()}>
          <Circle className="h-3 w-3 animate-pulse fill-current" />
          Stop &amp; Summarize
          <span className="ml-1 tabular-nums opacity-80">{formatElapsed(elapsedMs)}</span>
        </Button>
      ) : null}

      {status === "processing" ? (
        <Button variant="outline" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          Generating notes…
        </Button>
      ) : null}

      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record this session for AI notes?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-1 text-sm">
                <p>
                  SkillSwap will capture the call audio, turn it into structured study notes, and
                  then delete the recording. Only the notes are kept.
                </p>
                <ul className="space-y-1.5 text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-purple/60" />
                    <span>
                      The other participant sees a “recording in progress” banner for the whole
                      call.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-purple/60" />
                    <span>The audio is deleted as soon as the notes are generated.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-purple/60" />
                    <span>Both of you can download the notes as a PDF afterwards.</span>
                  </li>
                </ul>
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-100">
                  In the share dialog, pick <strong>This Tab</strong> and turn on{" "}
                  <strong>Also share tab audio</strong>. Without it only your own voice is recorded.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 p-3 text-sm">
            <Checkbox
              checked={consentChecked}
              onCheckedChange={(value) => setConsentChecked(value === true)}
              className="mt-0.5"
            />
            <span>I have my session partner’s agreement to record this call for AI notes.</span>
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="hero"
              disabled={!consentChecked}
              onClick={() => {
                setConsentOpen(false);
                setConsentChecked(false);
                void recorder.begin();
              }}
            >
              <Sparkles className="h-4 w-4" />
              Start recording
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
