// Friendly error → toast helper.
//
// Why this exists: most routes today do `toast.error(error.message)` where
// `error` is a Postgres / Supabase error. The raw message is usually
// developer-jargon ("new row for relation 'sessions' violates check constraint
// 'sessions_scheduled_at_not_past'") and sometimes leaks constraint names that
// don't help an end user. This helper:
//   1. Maps known DB errors to a single user-facing sentence
//   2. Falls back to the raw .message for unknown errors (same as today, no
//      regression)
//   3. Always logs the original error to the console so debugging stays easy
//
// Use as: toast.error(humanizeError(error)) — drop-in replacement for
// toast.error(error.message).

import { toast } from "sonner";

import { logClientError } from "@/lib/client-logger";

// Accept anything a `catch` block can produce. Narrowing happens inside
// humanizeError — callers should never need to cast.
type AnyError = unknown;

// Patterns that map known constraint / RLS / RPC errors to friendlier copy.
// Order matters — more specific patterns first.
const KNOWN_PATTERNS: Array<{ test: RegExp; message: string }> = [
  // Session FSM (RPC raises)
  {
    test: /Only the counterparty/i,
    message: "Only the other person can accept or reject this request.",
  },
  { test: /Only pending sessions can be accepted/i, message: "This request is no longer pending." },
  { test: /Only pending sessions can be rejected/i, message: "This request is no longer pending." },
  {
    test: /Only accepted or active sessions can be completed/i,
    message: "This session is not ready to be completed.",
  },
  {
    test: /Teachers can only mark complete after the scheduled session ends/i,
    message: "You can only mark this complete after the scheduled session ends.",
  },
  {
    test: /Cannot cancel a session in status/i,
    message: "This session can no longer be cancelled.",
  },
  {
    test: /Learner does not have enough credits/i,
    message: "Not enough credits for this session.",
  },
  {
    test: /Invalid session status transition/i,
    message: "That session change isn't allowed from its current state.",
  },
  {
    test: /Session participants, skill, credits, and duration cannot be changed/i,
    message: "Core session details can't be edited.",
  },
  {
    test: /Session ownership and timestamps cannot be changed/i,
    message: "Sessions can't have their owner or timestamps rewritten.",
  },

  // Schedule (round-3 trigger)
  { test: /Sessions cannot be scheduled in the past/i, message: "Pick a time in the future." },
  {
    test: /Sessions cannot be scheduled more than one year/i,
    message: "Pick a time within the next year.",
  },

  // Messages
  {
    test: /Sharing phone numbers in chat is not allowed/i,
    message: "You can't share phone numbers in chat — keep it on SkillSwap.",
  },
  {
    test: /Sharing external meeting links/i,
    message: "External meeting links aren't allowed in chat.",
  },
  { test: /Sharing email addresses/i, message: "Email addresses aren't allowed in chat." },
  {
    test: /Message ownership and timestamps cannot be changed/i,
    message: "Only message text can be edited.",
  },

  // Reviews
  {
    test: /reviews cannot include phone numbers/i,
    message: "Reviews can't include phone numbers.",
  },
  {
    test: /reviews cannot include external meeting links/i,
    message: "Reviews can't include external meeting links.",
  },
  {
    test: /reviews cannot include email addresses/i,
    message: "Reviews can't include email addresses.",
  },
  { test: /reviews_comment_length/i, message: "Reviews are limited to 500 characters." },

  // Reports
  { test: /You cannot report yourself/i, message: "You can't report yourself." },
  {
    test: /Finish onboarding before submitting reports/i,
    message: "Finish onboarding before submitting reports.",
  },
  {
    test: /You have reached the daily report limit/i,
    message: "You've hit today's report limit. Try again tomorrow.",
  },
  {
    test: /You have already reported this user multiple times/i,
    message:
      "You've already reported this user recently — a moderator will review the existing reports.",
  },
  { test: /Choose something to report/i, message: "Pick something to report." },
  {
    test: /Reported (message|review|session) was not found/i,
    message: "We couldn't find what you tried to report.",
  },

  // Skills (round-2 hardening)
  { test: /Skill name cannot be empty/i, message: "Skill name can't be empty." },
  {
    test: /Skill names cannot contain phone numbers/i,
    message: "Skill names can't contain phone numbers.",
  },
  {
    test: /Skill names cannot contain external meeting links/i,
    message: "Skill names can't contain links.",
  },
  {
    test: /Skill names cannot contain email addresses/i,
    message: "Skill names can't contain email addresses.",
  },
  { test: /skills_name_length/i, message: "Skill name must be 1–60 characters." },
  { test: /skills_category_length/i, message: "Skill category must be 1–40 characters." },

  // Profile
  { test: /profiles_bio_length/i, message: "Bios are limited to 500 characters." },
  { test: /profiles_full_name_length/i, message: "Full name must be 1–80 characters." },
  { test: /profiles_credits_nonnegative/i, message: "Not enough credits." },
  { test: /Only admins can change admin status/i, message: "Only admins can change admin status." },

  // Generic auth
  {
    test: /captcha.*no captcha_token|captcha.*request disallowed/i,
    message:
      "Complete the security check before continuing. If no check appears, add the public CAPTCHA site key to the app environment.",
  },
  {
    test: /captcha/i,
    message: "The security check failed. Please try again.",
  },
  {
    test: /email rate limit exceeded/i,
    message:
      "Too many verification emails were requested. Please wait a few minutes before trying again.",
  },
  { test: /Not authenticated/i, message: "Please log in first." },
  { test: /JWT expired/i, message: "Your session expired — please log in again." },
  {
    test: /(failed to fetch|networkerror|fetch failed|load failed)/i,
    message:
      "Could not reach the login server. Check your internet connection, proxy/VPN, and Supabase URL.",
  },

  // Generic Supabase
  { test: /duplicate key value violates unique constraint/i, message: "That already exists." },
  { test: /violates row-level security policy/i, message: "You don't have permission to do that." },
  { test: /permission denied for/i, message: "You don't have permission to do that." },
];

// Default copy when we have no error object and no fallback was provided.
const GENERIC_FALLBACK = "Something went wrong. Please try again.";

export function humanizeError(error: AnyError, fallback?: string): string {
  // Always log the raw error for debugging. Cheap and invaluable when a user
  // hits something we don't have a friendly mapping for.
  if (typeof console !== "undefined" && error) {
    console.error("[skillswap]", error);
    logClientError(error, "humanizeError");
  }

  // No error object at all — use the caller's fallback if they supplied one,
  // otherwise the generic.
  if (!error) return fallback ?? GENERIC_FALLBACK;

  const raw = typeof error === "string" ? error : (error as { message?: string }).message;

  // No usable .message — use fallback if provided, else generic.
  if (!raw) return fallback ?? GENERIC_FALLBACK;

  for (const { test, message } of KNOWN_PATTERNS) {
    if (test.test(raw)) return message;
  }

  // Unknown error with a message — surface the raw message so existing UX
  // (where we showed Postgres copy verbatim) doesn't regress.
  return raw;
}

// Convenience wrapper: humanize + toast in one call. The optional `fallback`
// is the copy to show when the error has no usable message — e.g. a network
// abort. It's NEVER used to override a real error message.
export function toastError(error: AnyError, fallback?: string) {
  toast.error(humanizeError(error, fallback));
}
