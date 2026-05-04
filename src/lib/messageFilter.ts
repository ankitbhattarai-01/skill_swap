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

export type ViolationKind = "phone" | "meeting_link" | "email" | "rough_language";

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

  return violations;
}

export function describeViolations(violations: Violation[]): string {
  if (violations.length === 0) return "";
  const kinds = new Set(violations.map((v) => v.kind));
  const parts: string[] = [];
  if (kinds.has("phone")) parts.push("phone numbers");
  if (kinds.has("meeting_link")) parts.push("meeting links");
  if (kinds.has("email")) parts.push("email addresses");
  if (kinds.has("rough_language") && parts.length === 0) {
    return "Rough language is not allowed in chat. Please keep conversations respectful.";
  }
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
  if (kinds.has("rough_language")) {
    return `Sharing ${list} or using rough language in chat is not allowed. Keep conversations on SkillSwap and respectful.`;
  }
  return `Sharing ${list} in chat is not allowed. Keep conversations on SkillSwap.`;
}
