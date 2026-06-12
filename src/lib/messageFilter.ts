// Anti-circumvention filter for chat messages.
//
// !!!  THIS FILE AND THE DB TRIGGER MUST STAY IN SYNC  !!!
// DB counterpart: `public.check_message_safe()` in
//   supabase/migrations/*_message_safety*.sql
// Client-side detection is the friendly path (shows the inline warning before
// the user hits send). The DB trigger is the authoritative gate — it will
// reject the row even if a stale or modified client lets the text through.
//
// When changing PHONE / EMAIL / URL / ROUGH_LANGUAGE regexes or the
// MEETING_HOSTS list, update the matching SQL constants in the trigger and add
// a migration. Drift here
// means either users see "your message was rejected" toasts with no inline
// hint (rules got stricter server-side), or banned content gets accepted
// silently and we have a moderation hole (rules got stricter client-side).

const MEETING_HOSTS = [
  "zoom.us",
  "zoom.com",
  "zoomgov.com",
  "meet.google.com",
  "g.co",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "skype.com",
  "join.skype.com",
  "whereby.com",
  "jitsi.org",
  "meet.jit.si",
  "hangouts.google.com",
  "discord.gg",
  "discord.com",
  "tencentmeeting.com",
  "voov.com",
  "wherever.video",
];

const PHONE_CANDIDATE = /\+?\d[\d\s.\-()]{6,}\d/g;
const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_REGEX = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[\w\-./?=#&%+~:@]*)?/gi;
const ROUGH_LANGUAGE_REGEX =
  /\b(?:arseholes?|assholes?|bastards?|bitch(?:es)?|bullshits?|cunts?|douchebags?|fuck(?:s|ed|ers?|ing)?|motherfuckers?|pricks?|shit(?:s|ty)?|sluts?|whores?)\b/gi;

// --- Safe-learning conduct rules -------------------------------------------
// Categories below keep chat respectful. Each list groups terms so they are
// easy to tune. Word boundaries (\b) avoid substring false positives, but a
// few entries are still context-sensitive in a technical/learning chat — those
// are marked "FP-prone" so you can drop them if they trip up legitimate talk.

// Bullying / harassment: personal put-downs + toxic phrases aimed at a person.
// FP-prone in tech chat: stupid, dumb, trash, failure, useless ("this test is
// useless", "the build failed", "my code is trash"). Kept because they are
// abusive when directed at a person; remove individually if too aggressive.
const HARASSMENT_REGEX =
  /\b(?:idiots?|stupid|loser(?:s)?|morons?|dumb(?:ass|asses)?|ugly|freaks?|failures?|trash|useless|pathetic|jackass(?:es)?|dimwits?|imbeciles?)\b|\b(?:nobody\s+likes\s+you|every(?:one|body)\s+hates\s+you|you(?:'?re|\s+are)\s+(?:worthless|a\s+joke|pathetic|useless)|you\s+should\s+quit|shut\s+up|go\s+away)\b/gi;

// Hate speech / slurs (racial, religious, homophobic, transphobic, disability,
// ethnic). NEVER echo a matched sample back to the user — see detectViolations,
// which redacts the slur. Common leet substitutions are folded in. A few high
// false-positive terms are deliberately excluded: "chink" (chink in the armor),
// "spook" (ghost/spy), "homo"/"queer" (academic/reclaimed), "dyke" (dike/levee).
const HATE_SPEECH_REGEX =
  /\b(?:n[i1]gg+(?:er|ers|a|as|ah|uh)|f[a4@]gg?(?:ot|ots|s)?|r[e3]t[a4]rd(?:ed|s)?|sp[i1]cs?|k[i1]kes?|g[o0]{2}ks?|w[e3]tbacks?|c[o0]{2}ns?|p[a4]k[i1]s?|b[e3]an[e3]rs?|wops?|d[a4]gos?|towelheads?|tr[a4]nn(?:y|ie|ies)|sh[e3]m[a4]les?|cr[i1]pples?)\b/gi;

// Threats, violence, and self-harm encouragement.
const THREAT_REGEX =
  /\b(?:kys|kill\s+(?:yourself|urself|you|u)|go\s+(?:die|kill\s+yourself)|you\s+should\s+die|hope\s+you\s+die|end\s+your\s+life|neck\s+yourself|drink\s+bleach|slit\s+your)\b|\bi(?:'?ll|\s+will|\s+wanna|\s+want\s+to)\s+(?:kill|hurt|beat|attack|stab|shoot|find|destroy)\s+(?:you|u)\b/gi;

// Sexual / explicit content. FP-prone: "cock" (rooster), "tit"/"tits" (a bird),
// "pussy" (a cat). Bare "sex", "naked", "cum" are excluded (Essex, naked eye,
// magna cum laude). Removable if your audience flags false positives.
const SEXUAL_REGEX =
  /\b(?:p[o0]rn(?:o|os|ography|hub)?|d[i1]ck(?:head|heads|s)?|c[o0]cks?|puss(?:y|ies)|boobs?|tits?|titties|cumshots?|cumming|blow\s*jobs?|hand\s*jobs?|b[o0]ners?|jerk\s*off|jack\s*off|masturbat(?:e|es|ed|ing|ion)|horny|nudes?|send\s+nudes)\b/gi;

export type ViolationKind =
  | "phone"
  | "meeting_link"
  | "email"
  | "rough_language"
  | "harassment"
  | "hate_speech"
  | "threat"
  | "sexual";

// Most-severe-first. describeViolations surfaces the top conduct issue so the
// user sees the strongest, clearest guidance rather than a pile of warnings.
const CONDUCT_SEVERITY: ViolationKind[] = [
  "hate_speech",
  "threat",
  "sexual",
  "harassment",
  "rough_language",
];

export type Violation = {
  kind: ViolationKind;
  sample: string;
};

export function detectViolations(text: string): Violation[] {
  const violations: Violation[] = [];
  if (!text) return violations;

  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      violations.push({ kind: "phone", sample: match[0].trim() });
    }
  }

  for (const match of text.matchAll(URL_REGEX)) {
    const host = match[1].toLowerCase();
    if (MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      violations.push({ kind: "meeting_link", sample: match[0] });
    }
  }

  for (const match of text.matchAll(EMAIL_REGEX)) {
    violations.push({ kind: "email", sample: match[0] });
  }

  for (const match of text.matchAll(ROUGH_LANGUAGE_REGEX)) {
    violations.push({ kind: "rough_language", sample: match[0].trim() });
  }

  for (const match of text.matchAll(HARASSMENT_REGEX)) {
    violations.push({ kind: "harassment", sample: match[0].trim() });
  }

  // Slurs are detected but never echoed back — redact the sample so the
  // matched term cannot surface in a warning, log, or toast.
  if (HATE_SPEECH_REGEX.test(text)) {
    violations.push({ kind: "hate_speech", sample: "[redacted]" });
  }
  HATE_SPEECH_REGEX.lastIndex = 0; // .test() on a /g/ regex is stateful — reset.

  for (const match of text.matchAll(THREAT_REGEX)) {
    violations.push({ kind: "threat", sample: match[0].trim() });
  }

  for (const match of text.matchAll(SEXUAL_REGEX)) {
    violations.push({ kind: "sexual", sample: match[0].trim() });
  }

  return violations;
}

const CONDUCT_MESSAGE: Record<string, string> = {
  hate_speech: "Hate speech and slurs are strictly prohibited. SkillSwap is a space for everyone.",
  threat:
    "Threats and harmful language aren't allowed. If you or someone you know is struggling, please reach out to a trusted person or a local helpline.",
  sexual: "Sexual or explicit content isn't allowed in chat. Keep conversations appropriate.",
  harassment: "Please keep chat kind — insults and put-downs aren't allowed here.",
  rough_language: "Rough language is not allowed in chat. Please keep conversations respectful.",
};

export function describeViolations(violations: Violation[]): string {
  if (violations.length === 0) return "";
  const kinds = new Set(violations.map((v) => v.kind));

  // Conduct issues take priority and are reported one at a time, strongest
  // first — they matter more than the privacy/anti-circumvention rules below.
  for (const kind of CONDUCT_SEVERITY) {
    if (kinds.has(kind)) return CONDUCT_MESSAGE[kind];
  }

  // Privacy / anti-circumvention: phone, meeting links, email.
  const parts: string[] = [];
  if (kinds.has("phone")) parts.push("phone numbers");
  if (kinds.has("meeting_link")) parts.push("meeting links");
  if (kinds.has("email")) parts.push("email addresses");
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
  return `Sharing ${list} in chat is not allowed. Keep conversations on SkillSwap.`;
}
