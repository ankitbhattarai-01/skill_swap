import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionNotesRecorder as SessionNotesRecorderState } from "@/lib/use-session-notes-recorder";
import type { RecordingConsent } from "@/lib/recording-consent";
import { Check, Circle, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

// Split in two on purpose.
//
// The buttons belong to whatever surface is showing the call (the video page's
// toolbar). The dialogs belong to the CALL, and are rendered once by CallHost:
// the other participant can ask to record while this user is off reading their
// notes on another page, and that prompt still has to reach them. Both halves
// are driven by state that lives in CallProvider, so nothing is lost when the
// video page unmounts.

function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

type ControlsProps = {
  recorder: SessionNotesRecorderState;
  consent: RecordingConsent;
  disabled?: boolean;
};

export function SessionNotesControls({ recorder, consent, disabled }: ControlsProps) {
  const { status, elapsedMs, supported } = recorder;
  if (!supported) return null;

  const startRequest = () => {
    if (!supported) {
      toast.error("This browser can't record audio for notes.");
      return;
    }
    consent.request();
  };

  return (
    <>
      {/* 'ready' is included so a second stretch of the same call can be
          recorded — the notes are regenerated from the newer audio. */}
      {status === "idle" || status === "failed" || status === "ready" ? (
        <Button
          variant="outline"
          onClick={startRequest}
          disabled={disabled || recorder.companionActive}
        >
          <Sparkles className="h-4 w-4" />
          {status === "failed"
            ? "Retry AI Notes"
            : status === "ready"
              ? "Record again"
              : "AI Notes"}
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
    </>
  );
}

type DialogsProps = {
  recorder: SessionNotesRecorderState;
  consent: RecordingConsent;
  /** Display name of the other participant, used in the consent prompts. */
  peerName: string;
};

export function SessionNotesConsentDialogs({ recorder, consent, peerName }: DialogsProps) {
  // `outgoing` leaves "idle" only through request(), and reset() is the only way
  // back, so it is the ask dialog's open state - no second flag to keep in sync.
  const askOpen = consent.outgoing !== "idle";

  const closeAsk = () => consent.reset();

  // Accepting starts this device's own silent mic capture — the click is the
  // user gesture the mic permission prompt hangs off. If capture fails here,
  // the accept still stands and the asker records alone.
  const allowAndRecord = () => {
    consent.accept();
    void recorder.beginCompanion();
  };

  const beginRecording = () => {
    consent.reset();
    void recorder.begin();
  };

  return (
    <>
      {/* Asker side: we've asked the peer and are waiting on their answer. */}
      <Dialog open={askOpen} onOpenChange={(open) => (open ? null : closeAsk())}>
        <DialogContent className="sm:max-w-sm">
          {consent.outgoing === "accepted" ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-emerald-500" />
                  {peerName} is in
                </DialogTitle>
                <DialogDescription className="pt-1">
                  Recording runs on both devices — each side captures its own microphone, so both
                  voices come through clearly. Start whenever you’re ready.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={closeAsk}>
                  Cancel
                </Button>
                <Button variant="hero" onClick={beginRecording}>
                  <Sparkles className="h-4 w-4" />
                  Start recording
                </Button>
              </DialogFooter>
            </>
          ) : consent.outgoing === "declined" ? (
            <>
              <DialogHeader>
                <DialogTitle>Maybe next time</DialogTitle>
                <DialogDescription className="pt-1">
                  {peerName} would rather not record this session.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={closeAsk}>
                  Got it
                </Button>
              </DialogFooter>
            </>
          ) : consent.outgoing === "timeout" ? (
            <>
              <DialogHeader>
                <DialogTitle>No answer yet</DialogTitle>
                <DialogDescription className="pt-1">
                  {peerName} hasn’t responded — they may not be at their screen right now.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={closeAsk}>
                  Close
                </Button>
                <Button variant="hero" onClick={() => consent.request()}>
                  Ask again
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-brand-purple" />
                  Asking {peerName}…
                </DialogTitle>
                <DialogDescription className="pt-1">
                  They’ll get a quick allow-or-decline. Recording only starts once they say yes.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={closeAsk}>
                  Cancel
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Responder side: the peer asked to record. Rendered regardless of local
          recording support — saying yes doesn't require the ability to record.
          Dismissing (Escape / click-away) counts as "not now", the safe default. */}
      <Dialog open={consent.incoming} onOpenChange={(open) => (open ? null : consent.decline())}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-brand-purple" />
              {peerName} wants to record for AI notes
            </DialogTitle>
            <DialogDescription className="pt-1">
              If you allow it, both devices record their own microphone — your browser may ask for
              mic access. SkillSwap turns the audio into study notes, then deletes the recordings.
              You’ll both be able to download the notes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={consent.decline}>
              Not now
            </Button>
            <Button variant="hero" onClick={allowAndRecord}>
              <Check className="h-4 w-4" />
              Allow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
