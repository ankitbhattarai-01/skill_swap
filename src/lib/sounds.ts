// Web Audio synthesized cues. No asset files — keeps bundle small and avoids
// autoplay-policy headaches: if the user hasn't interacted with the page yet,
// the AudioContext stays "suspended" and calls silently no-op.

let cachedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!cachedCtx) cachedCtx = new Ctor();
  if (cachedCtx.state === "suspended") void cachedCtx.resume();
  return cachedCtx;
}

type ToneSpec = { freq: number; offset: number; dur: number; gain?: number };

function playTones(tones: ToneSpec[]) {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const { freq, offset, dur, gain = 0.16 } of tones) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, now + offset);
      g.gain.linearRampToValueAtTime(gain, now + offset + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, now + offset + dur);
      osc.start(now + offset);
      osc.stop(now + offset + dur);
    }
  } catch {
    // Autoplay blocked or audio not available — silently skip.
  }
}

export function playMessageChime() {
  playTones([
    { freq: 880, offset: 0, dur: 0.18 },
    { freq: 1320, offset: 0.1, dur: 0.24 },
  ]);
}

export function playRequestSentChime() {
  playTones([
    { freq: 660, offset: 0, dur: 0.14 },
    { freq: 880, offset: 0.08, dur: 0.18 },
    { freq: 1175, offset: 0.18, dur: 0.26 },
  ]);
}

export function playCancelChime() {
  playTones([
    { freq: 520, offset: 0, dur: 0.16 },
    { freq: 392, offset: 0.12, dur: 0.28 },
  ]);
}

// Outbound ringback ("calling…") tone played to the *caller* while they wait
// for the other party to pick up. Mirrors a real phone: a short dual-tone
// burst repeating on an interval until stopRingback() is called. Like the
// other cues, it no-ops while the AudioContext is suspended (no interaction).
let ringbackInterval: ReturnType<typeof setInterval> | null = null;

function playRingbackBurst() {
  // Classic ringback pair (440 Hz + 480 Hz), a touch quieter than the
  // incoming-call ring so the caller's own tone isn't startling.
  playTones([
    { freq: 440, offset: 0, dur: 0.9, gain: 0.1 },
    { freq: 480, offset: 0, dur: 0.9, gain: 0.1 },
  ]);
}

export function startRingback() {
  if (ringbackInterval) return;
  playRingbackBurst();
  // ~1s tone + ~3s silence ≈ 4s cadence.
  ringbackInterval = setInterval(playRingbackBurst, 4000);
}

export function stopRingback() {
  if (ringbackInterval) {
    clearInterval(ringbackInterval);
    ringbackInterval = null;
  }
}
