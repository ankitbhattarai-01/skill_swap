import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lightweight voice narration for the help tour. Uses the browser's built-in
// Web Speech API (no API key, no asset files).
//
// Voice quality varies a lot by browser + OS:
// - Edge on Windows exposes "Microsoft Ava Online (Natural)" and friends.
//   These sound essentially human.
// - Chrome on Windows usually only sees "Microsoft David/Zira/Mark Desktop"
//   which are the classic robotic ones, plus "Google US English".
// - macOS/iOS have the Siri voices ("Samantha", "Karen") which are decent.
//
// Because of this, we let the user pick the voice themselves. We just take
// a best guess on first load.

const VOICE_NAME_KEY = "skillswap-help-voice-name";

const NATURAL_HINTS = [
  "(Natural)",
  "Natural",
  "Neural",
  "Online",
  "Premium",
  "Enhanced",
];

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

function pickBestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : voices;
  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

export type VoiceOption = {
  name: string;
  lang: string;
  natural: boolean;
};

export type SpeechState = {
  /** id of the card currently being read, or null when nothing is playing */
  speakingId: string | null;
  /** true once the browser has loaded the voice list */
  ready: boolean;
  /** available English voices the user can pick from */
  voices: VoiceOption[];
  /** name of the currently selected voice */
  selectedVoiceName: string | null;
  /** change to a different voice */
  selectVoice: (name: string) => void;
  /** play a short preview of the currently selected voice */
  previewVoice: () => void;
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
  const [selectedName, setSelectedName] = useState<string | null>(null);
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
      setSelectedName((current) => {
        if (current && voices.some((v) => v.name === current)) return current;
        const saved = window.localStorage.getItem(VOICE_NAME_KEY);
        if (saved && voices.some((v) => v.name === saved)) return saved;
        return pickBestVoice(voices)?.name ?? null;
      });
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      window.speechSynthesis.cancel();
    };
  }, []);

  const englishVoices = useMemo<VoiceOption[]>(() => {
    const english = allVoices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
    return [...english]
      .sort((a, b) => scoreVoice(b) - scoreVoice(a))
      .map((v) => ({
        name: v.name,
        lang: v.lang,
        natural: NATURAL_HINTS.some((hint) => v.name.includes(hint)),
      }));
  }, [allVoices]);

  const selectedVoice = useMemo(
    () => allVoices.find((v) => v.name === selectedName) ?? null,
    [allVoices, selectedName],
  );

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
      // engines. Tweaking these helped Microsoft Zira and Google US English
      // sound noticeably less robotic in testing.
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

  const previewVoice = useCallback(() => {
    speak("__preview", "Hi there! This is how I'll sound as your guide.");
  }, [speak]);

  const selectVoice = useCallback(
    (name: string) => {
      setSelectedName(name);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(VOICE_NAME_KEY, name);
      }
      stop();
    },
    [stop],
  );

  return {
    speakingId,
    ready,
    voices: englishVoices,
    selectedVoiceName: selectedName,
    selectVoice,
    previewVoice,
    speak,
    stop,
  };
}
