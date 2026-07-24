import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lightweight voice narration for the help tour. Uses the browser's built-in
// Web Speech API (no API key, no asset files).
//
// The guide always speaks with one voice: "Google US English". It's the most
// consistent-sounding option available across browsers, so there's no picker.
// If it isn't installed (Google's voices only ship with Chrome), we fall back
// to the closest natural-sounding English voice we can find.

const PREFERRED_VOICE_NAME = "Google US English";

const NATURAL_HINTS = ["(Natural)", "Natural", "Neural", "Online", "Premium", "Enhanced"];

const SAFE_NAMED_VOICES = [
  "Ava",
  "Andrew",
  "Aria",
  "Jenny",
  "Guy",
  "Emma",
  "Samantha",
  "Karen",
  "Daniel",
  "Moira",
  "Tessa",
  "Google US English",
  "Google UK English Female",
  "Google UK English Male",
];

function scoreVoice(v: SpeechSynthesisVoice): number {
  let score = 0;
  const name = v.name;
  if (NATURAL_HINTS.some((hint) => name.includes(hint))) score += 100;
  if (SAFE_NAMED_VOICES.some((named) => name.includes(named))) score += 50;
  if (v.lang?.toLowerCase().startsWith("en-us")) score += 10;
  else if (v.lang?.toLowerCase().startsWith("en")) score += 5;
  if (v.localService) score -= 2;
  if (/desktop/i.test(name)) score -= 30;
  return score;
}

// Google US English if it exists, otherwise the best English voice available.
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const preferred = voices.find((v) => v.name === PREFERRED_VOICE_NAME);
  if (preferred) return preferred;
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : voices;
  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

export type SpeechState = {
  /** id of the card currently being read, or null when nothing is playing */
  speakingId: string | null;
  /** true once the browser has loaded the voice list */
  ready: boolean;
  /** start reading `text` and tag this playback with `id` */
  speak: (id: string, text: string) => void;
  /** stop any current playback */
  stop: () => void;
};

// Add punctuation pauses so even basic voices sound less rushed. Doubling
// commas and adding spaces between sentences forces a longer pause on most
// TTS engines without sounding weird.
function humanize(text: string): string {
  return text
    .replace(/\.\s+/g, ". ... ")
    .replace(/,\s+/g, ", , ")
    .replace(/!\s+/g, "! ... ")
    .replace(/\?\s+/g, "? ... ");
}

export function useSpeech(): SpeechState {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [allVoices, setAllVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ready, setReady] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setReady(false);
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      setAllVoices(voices);
      setReady(true);
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      window.speechSynthesis.cancel();
    };
  }, []);

  const selectedVoice = useMemo(() => pickVoice(allVoices), [allVoices]);

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
    utteranceRef.current = null;
  }, []);

  const buildUtterance = useCallback(
    (text: string) => {
      const u = new SpeechSynthesisUtterance(humanize(text));
      if (selectedVoice) u.voice = selectedVoice;
      // Slightly slower + slightly lower pitch reads more "human" on most
      // engines. Tweaking these helped Google US English sound noticeably
      // less robotic in testing.
      u.rate = 0.92;
      u.pitch = 0.95;
      u.volume = 1;
      return u;
    },
    [selectedVoice],
  );

  const speak = useCallback(
    (id: string, text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();

      const u = buildUtterance(text);
      u.onend = () => {
        if (utteranceRef.current === u) {
          setSpeakingId(null);
          utteranceRef.current = null;
        }
      };
      u.onerror = () => {
        if (utteranceRef.current === u) {
          setSpeakingId(null);
          utteranceRef.current = null;
        }
      };

      utteranceRef.current = u;
      setSpeakingId(id);
      window.speechSynthesis.speak(u);
    },
    [buildUtterance],
  );

  return {
    speakingId,
    ready,
    speak,
    stop,
  };
}
