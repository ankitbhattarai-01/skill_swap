import { supabase } from "@/integrations/supabase/client";

// Client-side capture of a skill-exchange call for AI note generation.
//
// DUAL-SIDED DESIGN: each participant's device records ONLY its own microphone
// with getUserMedia + MediaRecorder. Your own mic is the one thing every
// browser that matters (desktop Chrome/Edge/Firefox, Android Chrome, iOS
// Safari) can capture reliably, so there is no tab capture, no screen picker
// and no Web Audio mixing here anymore. The initiator records their leg; the
// peer's client quietly records its own leg after accepting the consent
// request; both legs are uploaded under {sessionId}/{userId}/ and the Edge
// Function merges them into one set of notes.
//
// echoCancellation stays ON deliberately: it scrubs the remote voice (played
// through this device's speakers) out of the local mic, so each leg contains
// one speaker. That is what lets the Edge Function tell Gemini exactly who is
// talking in each file.

export const AUDIO_BUCKET = "session-audio";

// Mirrors the bucket's file_size_limit in migration 20260718000000 and the
// Edge Function's MAX_AUDIO_BYTES — per leg. Enforced live during capture so a
// long call stops cleanly at the limit instead of failing on upload after the
// fact.
export const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

// 32 kbps mono Opus is plainly good enough for speech transcription and keeps
// ~75 minutes under the size cap. Bumping this shortens the max call length.
const AUDIO_BITS_PER_SECOND = 32_000;

export type SessionNotes = {
  summary: string;
  keyTopics: string[];
  takeaways: string[];
  actionItems: string[];
  questionsRaised: string[];
};

export type SessionNotesRow = {
  session_id: string;
  status: "processing" | "ready" | "failed";
  notes: SessionNotes | null;
  error: string | null;
  generated_at: string | null;
};

export class RecordingError extends Error {}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    pickMimeType() !== ""
  );
}

export type ActiveRecording = {
  /** Resolves with the captured audio once stop() is called or capture ends. */
  stop: () => Promise<{ blob: Blob; durationMs: number }>;
  /** Tear everything down without producing a blob (user cancelled). */
  cancel: () => void;
};

type StartOptions = {
  /** Fired when capture ends on its own — the mic vanished, or the size cap. */
  onAutoStop?: (reason: "capture-ended" | "size-limit") => void;
};

export async function startSessionRecording(options: StartOptions = {}): Promise<ActiveRecording> {
  if (!isRecordingSupported()) {
    throw new RecordingError("This browser can't record audio for notes.");
  }

  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new RecordingError("Microphone access was denied, so nothing was recorded.");
    }
    throw new RecordingError("Could not access the microphone.");
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(micStream, {
    mimeType,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });

  const chunks: Blob[] = [];
  let totalBytes = 0;
  const startedAt = Date.now();
  let settled = false;

  const cleanup = () => {
    micStream.getTracks().forEach((t) => t.stop());
  };

  const stopped = new Promise<{ blob: Blob; durationMs: number }>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        totalBytes += event.data.size;
        // Stop cleanly at the cap rather than letting the upload fail later.
        if (totalBytes >= MAX_AUDIO_BYTES && recorder.state === "recording") {
          options.onAutoStop?.("size-limit");
          recorder.stop();
        }
      }
    });
    recorder.addEventListener("stop", () => {
      cleanup();
      settled = true;
      resolve({
        blob: new Blob(chunks, { type: mimeType.split(";")[0] }),
        durationMs: Date.now() - startedAt,
      });
    });
    recorder.addEventListener("error", () => {
      cleanup();
      settled = true;
      reject(new RecordingError("Recording stopped unexpectedly."));
    });
  });

  // The mic can end on its own — device unplugged, OS-level permission pulled.
  // Treat that as a normal stop so whatever was captured is still usable.
  micStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state === "recording") {
      options.onAutoStop?.("capture-ended");
      recorder.stop();
    }
  });

  // 1s timeslice so `dataavailable` fires continuously, which is what lets the
  // size guard above act mid-recording instead of only at the end.
  recorder.start(1000);

  return {
    stop: () => {
      if (recorder.state === "recording") recorder.stop();
      return stopped;
    },
    cancel: () => {
      if (settled) return;
      // Drop the buffered audio; the `stop` promise is simply never awaited.
      chunks.length = 0;
      if (recorder.state === "recording") recorder.stop();
      else cleanup();
    },
  };
}

async function readFunctionError(error: unknown) {
  const response = (error as { context?: Response }).context;
  if (response && typeof response.text === "function") {
    try {
      const raw = await response.text();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { error?: string; message?: string };
      return parsed.error ?? parsed.message ?? raw;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Uploads one leg of the recording to the private staging bucket. Used by the
 * initiator (who then invokes the Edge Function) AND by the companion side,
 * which uploads its leg and does nothing else — the initiator's invocation
 * picks the peer leg up from the bucket.
 * Path shape is enforced by both the storage policy and the Edge Function:
 * {session_id}/{uploader_user_id}/{uuid}.{ext}
 */
export async function uploadRecordingLeg(input: {
  sessionId: string;
  userId: string;
  blob: Blob;
}): Promise<string> {
  const { sessionId, userId, blob } = input;

  if (blob.size === 0) {
    throw new RecordingError("The recording was empty.");
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    throw new RecordingError("That recording is too long to process.");
  }

  const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
  const path = `${sessionId}/${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });

  if (uploadError) {
    throw new RecordingError(`Could not upload the recording: ${uploadError.message}`);
  }
  return path;
}

/**
 * Uploads the initiator's leg and asks the Edge Function to turn the session's
 * audio into notes. The function collects the peer's leg from the bucket by
 * itself (waiting briefly if it is still uploading), and deletes all audio as
 * soon as it is done — but we do remove our own object if the call never
 * reaches the function.
 */
export async function generateNotesFromRecording(input: {
  sessionId: string;
  userId: string;
  blob: Blob;
  durationMs: number;
}): Promise<{ notes: SessionNotes; legsUsed: number }> {
  const { sessionId, userId, blob, durationMs } = input;

  const path = await uploadRecordingLeg({ sessionId, userId, blob });

  const { data, error } = await supabase.functions.invoke<{
    notes: SessionNotes;
    legsUsed?: number;
  }>("generate-session-notes", { body: { sessionId, audioPath: path, durationMs } });

  if (error) {
    // The function deletes the audio itself, but if it never ran (network
    // failure, cold-start timeout) the object would linger. Best-effort remove.
    await supabase.storage
      .from(AUDIO_BUCKET)
      .remove([path])
      .catch(() => {
        // Storage policy allows this; a failure here is not worth surfacing.
      });
    const functionMessage = await readFunctionError(error);
    throw new RecordingError(functionMessage ?? error.message);
  }

  if (!data?.notes) throw new RecordingError("No notes were returned.");
  // Older deployments of the function don't report a leg count. Assume both
  // sides made it rather than warning about a problem we can't actually see.
  return { notes: data.notes, legsUsed: data.legsUsed ?? 2 };
}

export async function fetchSessionNotes(sessionId: string): Promise<SessionNotesRow | null> {
  const { data, error } = await supabase
    .from("session_notes")
    .select("session_id, status, notes, error, generated_at")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) return null;
  return (data as SessionNotesRow | null) ?? null;
}

/**
 * Which of these sessions already have downloadable notes. Used by the sessions
 * list so the "Notes" button only shows up on cards that can actually produce a
 * PDF — one query for the whole page instead of one per card.
 */
export async function fetchReadySessionNotes(
  sessionIds: string[],
): Promise<Map<string, SessionNotesRow>> {
  const map = new Map<string, SessionNotesRow>();
  if (sessionIds.length === 0) return map;

  const { data, error } = await supabase
    .from("session_notes")
    .select("session_id, status, notes, error, generated_at")
    .in("session_id", sessionIds)
    .eq("status", "ready");

  if (error || !data) return map;
  for (const row of data as SessionNotesRow[]) {
    if (row.notes) map.set(row.session_id, row);
  }
  return map;
}
