import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateNotesFromRecording,
  isRecordingSupported,
  RecordingError,
  startSessionRecording,
  uploadRecordingLeg,
  type ActiveRecording,
  type SessionNotes,
} from "@/lib/session-notes";
import { useRecordingAnnouncer } from "@/lib/recording-signal";
import { emitRecordingStop, useRecordingStopSignal } from "@/lib/recording-consent";
import { toast } from "sonner";

export type NotesRecorderStatus = "idle" | "recording" | "processing" | "ready" | "failed";

// If the asker accepted-then-cancelled and never actually started recording,
// the companion capture bails out after this long instead of sitting on the
// mic for the rest of the call.
const COMPANION_ARM_TIMEOUT_MS = 45_000;

export type SessionNotesRecorder = {
  status: NotesRecorderStatus;
  /** True while audio is actively being captured as the INITIATOR. */
  isActive: boolean;
  elapsedMs: number;
  notes: SessionNotes | null;
  supported: boolean;
  /**
   * Begins capture as the initiator. Called by the recorder component once the
   * other participant has accepted the consent request.
   */
  begin: () => Promise<void>;
  stopAndGenerate: () => Promise<void>;
  /** True while this client is quietly recording its own mic as the PEER. */
  companionActive: boolean;
  /**
   * Begins the silent companion capture of this device's own mic. Called from
   * the click on "Allow" in the consent dialog (a clean user gesture for the
   * mic permission prompt). No-ops when recording isn't supported here — the
   * initiator then records alone and notes come from one leg.
   */
  beginCompanion: () => Promise<void>;
  /** Stops the companion capture and uploads its leg (no notes generation). */
  flushCompanion: () => Promise<void>;
};

/**
 * Owns the record -> upload -> generate lifecycle for one call, in BOTH roles:
 *
 * - Initiator: records own mic, and on stop emits a 'stop' signal, uploads its
 *   leg, and invokes the Edge Function (which merges whatever legs exist).
 * - Companion: after accepting consent, records own mic silently; on the
 *   initiator's 'stop' signal (or on leaving the call) it stops and uploads
 *   its leg, and nothing more.
 *
 * This lives in the video ROUTE rather than inside the recorder component so
 * the route can flush a running recording when the call ends, before it
 * navigates away — navigating first would unmount the component and throw the
 * captured audio away.
 */
export function useSessionNotesRecorder(input: {
  sessionId: string;
  userId: string | undefined;
  displayName: string;
  /** The recording banner name from useRecordingWatcher — non-null while the
   *  peer announces an active recording. Arms the companion capture. */
  peerRecordingName: string | null;
}): SessionNotesRecorder {
  const { sessionId, userId, displayName, peerRecordingName } = input;

  const [status, setStatus] = useState<NotesRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notes, setNotes] = useState<SessionNotes | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  // Guards against the double-stop that happens when the user clicks Stop and
  // the call's hangup handler also fires.
  const finishingRef = useRef<Promise<void> | null>(null);

  const [companionActive, setCompanionActive] = useState(false);
  const companionRef = useRef<ActiveRecording | null>(null);
  // Set once the initiator's recording banner has actually appeared. A flush
  // without this (and without a genuine stop signal) means the asker never
  // started, so the leg is discarded rather than uploaded.
  const companionArmedRef = useRef(false);
  const companionUploadedRef = useRef(false);
  const companionFlushRef = useRef<Promise<void> | null>(null);
  const companionArmTimerRef = useRef<number | null>(null);

  const supported = isRecordingSupported();
  const isActive = status === "recording";

  // Tell the other participant we are recording, and keep telling them.
  // Only the initiator announces; the companion side's capture was consented
  // to explicitly in the dialog and mirrors the initiator's banner lifetime.
  useRecordingAnnouncer({ sessionId, userId, displayName, active: isActive });

  useEffect(() => {
    if (!isActive) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const begin = useCallback(async () => {
    if (!userId) return;
    try {
      const recording = await startSessionRecording({
        onAutoStop: (reason) => {
          toast.info(
            reason === "size-limit"
              ? "Recording hit the length limit. Generating notes from what was captured."
              : "The microphone went away. Generating notes from what was captured.",
          );
          // The capture already stopped itself; flush it through the same path.
          void stopAndGenerateRef.current();
        },
      });
      recordingRef.current = recording;
      // Drop notes from an earlier take so nothing stale is shown while the
      // new recording runs.
      setNotes(null);
      setStatus("recording");
      toast.success("Recording for AI notes. Both sides' microphones are being captured.");
    } catch (error) {
      setStatus("idle");
      toast.error(error instanceof RecordingError ? error.message : "Could not start recording.");
    }
  }, [userId]);

  const stopAndGenerate = useCallback(async () => {
    if (finishingRef.current) return finishingRef.current;
    const recording = recordingRef.current;
    if (!recording || !userId) return;

    // Fire-and-forget: the peer's companion recorder stops and uploads its leg
    // in parallel with our own stop + upload, so the Edge Function usually
    // finds both legs on its first look.
    void emitRecordingStop(sessionId).catch(() => {
      // The function waits for the peer leg only briefly; a lost stop signal
      // just means single-leg notes.
    });

    const run = (async () => {
      setStatus("processing");
      try {
        const { blob, durationMs } = await recording.stop();
        recordingRef.current = null;
        const generated = await generateNotesFromRecording({
          sessionId,
          userId,
          blob,
          durationMs,
        });
        setNotes(generated);
        setStatus("ready");
        toast.success("Session notes are ready.");
      } catch (error) {
        recordingRef.current = null;
        setStatus("failed");
        toast.error(
          error instanceof RecordingError || error instanceof Error
            ? error.message
            : "Could not generate notes.",
        );
      } finally {
        finishingRef.current = null;
      }
    })();

    finishingRef.current = run;
    return run;
  }, [sessionId, userId]);

  // onAutoStop fires from inside startSessionRecording, before stopAndGenerate
  // is in scope; a ref keeps that callback pointed at the latest version.
  const stopAndGenerateRef = useRef(stopAndGenerate);
  stopAndGenerateRef.current = stopAndGenerate;

  // ── Companion side ─────────────────────────────────────────────────────────

  const clearCompanionArmTimer = useCallback(() => {
    if (companionArmTimerRef.current != null) {
      window.clearTimeout(companionArmTimerRef.current);
      companionArmTimerRef.current = null;
    }
  }, []);

  // `force` marks flushes triggered by a genuine stop signal (or the size
  // cap): the initiator definitely recorded, so upload even if the banner
  // never made it here. A hangup flush without either signal discards instead.
  const flushCompanionInternal = useCallback(
    async (force: boolean) => {
      if (companionFlushRef.current) return companionFlushRef.current;
      const recording = companionRef.current;
      if (!recording || !userId) return;

      const run = (async () => {
        clearCompanionArmTimer();
        try {
          const { blob } = await recording.stop();
          companionRef.current = null;
          setCompanionActive(false);
          if (companionUploadedRef.current) return;
          if (!force && !companionArmedRef.current) return;
          if (blob.size === 0) return;
          companionUploadedRef.current = true;
          await uploadRecordingLeg({ sessionId, userId, blob });
        } catch {
          companionRef.current = null;
          setCompanionActive(false);
          toast.error("Couldn't save your side of the recording. Notes will use the other side.");
        } finally {
          companionFlushRef.current = null;
        }
      })();

      companionFlushRef.current = run;
      return run;
    },
    [sessionId, userId, clearCompanionArmTimer],
  );

  const flushCompanionRef = useRef(flushCompanionInternal);
  flushCompanionRef.current = flushCompanionInternal;

  const beginCompanion = useCallback(async () => {
    if (!userId || !supported) return;
    if (companionRef.current || recordingRef.current) return;
    try {
      const recording = await startSessionRecording({
        // Size cap or vanished mic: keep what we have. Upload now — waiting
        // for the stop signal would risk losing it to a closed tab.
        onAutoStop: () => void flushCompanionRef.current(true),
      });
      companionRef.current = recording;
      companionArmedRef.current = false;
      companionUploadedRef.current = false;
      setCompanionActive(true);
      companionArmTimerRef.current = window.setTimeout(() => {
        if (!companionArmedRef.current && companionRef.current) {
          companionRef.current.cancel();
          companionRef.current = null;
          setCompanionActive(false);
        }
      }, COMPANION_ARM_TIMEOUT_MS);
    } catch {
      // Mic denied or capture failed. Consent still stands — the initiator
      // records their leg and the notes just come from one side.
      toast.info("Your microphone couldn't be captured, so notes will use the other side only.");
    }
  }, [userId, supported]);

  // The initiator's banner is the proof their recording actually started.
  useEffect(() => {
    if (companionActive && peerRecordingName) companionArmedRef.current = true;
  }, [companionActive, peerRecordingName]);

  // The initiator stopped (or their call ended): flush our leg.
  useRecordingStopSignal({
    sessionId,
    selfUserId: userId,
    onPeerStop: () => void flushCompanionRef.current(true),
  });

  const flushCompanion = useCallback(() => flushCompanionInternal(false), [flushCompanionInternal]);

  // Never leave the microphone running if the page goes away mid-recording.
  // Audio buffered so far is discarded, which is the right call: an unmount
  // means the user navigated off without the route's flush, so nobody is
  // waiting on this leg.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
      companionRef.current?.cancel();
      companionRef.current = null;
      if (companionArmTimerRef.current != null) {
        window.clearTimeout(companionArmTimerRef.current);
      }
    };
  }, []);

  return {
    status,
    isActive,
    elapsedMs,
    notes,
    supported,
    begin,
    stopAndGenerate,
    companionActive,
    beginCompanion,
    flushCompanion,
  };
}
