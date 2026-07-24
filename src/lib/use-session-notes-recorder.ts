import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateNotesFromRecording,
  isRecordingSupported,
  RecordingError,
  startSessionRecording,
  type ActiveRecording,
  type SessionNotes,
} from "@/lib/session-notes";
import { useRecordingAnnouncer } from "@/lib/recording-signal";
import { toast } from "sonner";

export type NotesRecorderStatus = "idle" | "recording" | "processing" | "ready" | "failed";

export type SessionNotesRecorder = {
  status: NotesRecorderStatus;
  /** True while audio is actively being captured. */
  isActive: boolean;
  elapsedMs: number;
  notes: SessionNotes | null;
  supported: boolean;
  /**
   * Begins capture. Called by the recorder component once the other
   * participant has accepted the consent request, from the click on
   * "Start recording" (getDisplayMedia needs a fresh user gesture).
   */
  begin: () => Promise<void>;
  stopAndGenerate: () => Promise<void>;
};

/**
 * Owns the record -> upload -> generate lifecycle for one call.
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
}): SessionNotesRecorder {
  const { sessionId, userId, displayName } = input;

  const [status, setStatus] = useState<NotesRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notes, setNotes] = useState<SessionNotes | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  // Guards against the double-stop that happens when the user clicks Stop and
  // the call's hangup handler also fires.
  const finishingRef = useRef<Promise<void> | null>(null);

  const supported = isRecordingSupported();
  const isActive = status === "recording";

  // Tell the other participant we are recording, and keep telling them.
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
              : "Tab sharing ended. Generating notes from what was captured.",
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
      toast.success("Recording for AI notes. The other participant has been notified.");
    } catch (error) {
      setStatus("idle");
      toast.error(error instanceof RecordingError ? error.message : "Could not start recording.");
    }
  }, [userId]);

  const stopAndGenerate = useCallback(async () => {
    if (finishingRef.current) return finishingRef.current;
    const recording = recordingRef.current;
    if (!recording || !userId) return;

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

  // Never leave the microphone or tab capture running if the page goes away
  // mid-recording. Audio buffered so far is discarded, which is the right call:
  // an unmount means the user navigated off and is not waiting for notes.
  useEffect(() => {
    return () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
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
  };
}
