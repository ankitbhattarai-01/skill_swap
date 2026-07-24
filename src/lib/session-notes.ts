import { supabase } from "@/integrations/supabase/client";

// Client-side capture of a skill-exchange call for AI note generation.
//
// WHY TWO STREAMS: tab capture alone is not enough. Jitsi plays the REMOTE
// participant's audio through the tab, so getDisplayMedia picks them up — but
// it deliberately does NOT play your own microphone back (that would be an
// echo loop), so display capture on its own yields a one-sided conversation.
// We therefore capture the mic separately and mix both into a single stream
// with the Web Audio API before handing it to MediaRecorder. Still free, still
// entirely client-side, no server-side recording (Jibri) involved.
//
// BROWSER SUPPORT: tab-audio capture is a Chromium feature. Firefox and Safari
// do not implement it, and even in Chrome the user must pick a *tab* (not a
// window or screen) and tick "Also share tab audio" in the picker. We detect
// the missing audio track and say so explicitly rather than silently producing
// a mic-only recording.

export const AUDIO_BUCKET = "session-audio";

// Mirrors the bucket's file_size_limit in migration 20260718000000 and the
// Edge Function's MAX_AUDIO_BYTES. Enforced live during capture so a long call
// stops cleanly at the limit instead of failing on upload after the fact.
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
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    typeof window.AudioContext === "function" &&
    pickMimeType() !== ""
  );
}

export type ActiveRecording = {
  /** Resolves with the mixed audio once stop() is called or capture ends. */
  stop: () => Promise<{ blob: Blob; durationMs: number }>;
  /** Tear everything down without producing a blob (user cancelled). */
  cancel: () => void;
};

type StartOptions = {
  /** Fired when capture ends on its own — browser "Stop sharing", or the size cap. */
  onAutoStop?: (reason: "shared-stopped" | "size-limit") => void;
};

export async function startSessionRecording(options: StartOptions = {}): Promise<ActiveRecording> {
  if (!isRecordingSupported()) {
    throw new RecordingError(
      "Recording needs Chrome or Edge on desktop. This browser cannot capture tab audio.",
    );
  }

  // Chrome refuses audio-only display capture: requesting { video: false }
  // throws, because there is no picker UI without a visual surface. So we ask
  // for video, then immediately discard the video track and keep only audio.
  let displayStream: MediaStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new RecordingError("Screen share was cancelled, so nothing was recorded.");
    }
    throw new RecordingError("Could not start tab capture.");
  }

  for (const track of displayStream.getVideoTracks()) {
    track.stop();
    displayStream.removeTrack(track);
  }

  const displayAudio = displayStream.getAudioTracks();
  if (displayAudio.length === 0) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new RecordingError(
      'No tab audio was shared. Re-run it, choose the "Chrome Tab" option, and tick "Also share tab audio".',
    );
  }

  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new RecordingError("Microphone access was denied, so your side could not be recorded.");
  }

  // Mix: remote (tab) + local (mic) -> one track for MediaRecorder.
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(displayStream).connect(destination);
  audioContext.createMediaStreamSource(micStream).connect(destination);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(destination.stream, {
    mimeType,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });

  const chunks: Blob[] = [];
  let totalBytes = 0;
  const startedAt = Date.now();
  let settled = false;

  const cleanup = () => {
    displayStream.getTracks().forEach((t) => t.stop());
    micStream.getTracks().forEach((t) => t.stop());
    destination.stream.getTracks().forEach((t) => t.stop());
    void audioContext.close().catch(() => {
      // Context may already be closed — nothing to do.
    });
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

  // The user can end capture from Chrome's own "Stop sharing" bar. Treat that
  // as a normal stop so we still keep whatever was captured up to that point.
  displayAudio[0].addEventListener("ended", () => {
    if (recorder.state === "recording") {
      options.onAutoStop?.("shared-stopped");
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
 * Uploads the recording to the private staging bucket and asks the Edge
 * Function to turn it into notes. The function deletes the raw audio as soon
 * as it is done, so nothing here needs to clean up on the happy path — but we
 * do remove the object ourselves if the call never reaches the function.
 */
export async function generateNotesFromRecording(input: {
  sessionId: string;
  userId: string;
  blob: Blob;
  durationMs: number;
}): Promise<SessionNotes> {
  const { sessionId, userId, blob, durationMs } = input;

  if (blob.size === 0) {
    throw new RecordingError("The recording was empty. Check that tab audio was shared.");
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    throw new RecordingError("That recording is too long to process.");
  }

  const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
  // Path shape is enforced by both the storage policy and the Edge Function:
  // {session_id}/{uploader_user_id}/{uuid}.{ext}
  const path = `${sessionId}/${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });

  if (uploadError) {
    throw new RecordingError(`Could not upload the recording: ${uploadError.message}`);
  }

  const { data, error } = await supabase.functions.invoke<{ notes: SessionNotes }>(
    "generate-session-notes",
    { body: { sessionId, audioPath: path, durationMs } },
  );

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
  return data.notes;
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
