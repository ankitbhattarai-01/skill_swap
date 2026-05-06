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
    message: "You can't share phone numbers in chat. Keep it on SkillSwap.",
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
      "You've already reported this user recently. A moderator will review the existing reports.",
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
    message: "The security check didn't go through. Give it another try.",
  },
  {
    test: /email rate limit exceeded/i,
    message:
      "We've sent a lot of emails to this address recently. Please wait a few minutes and try again.",
  },
  {
    test: /for security purposes.*request this (once )?(every|after) \d+ seconds?/i,
    message: "You're going a little fast. Wait a moment before trying again.",
  },
  {
    test: /over_email_send_rate_limit|over_request_rate_limit|too many requests/i,
    message: "Too many attempts in a row. Take a short break and try again.",
  },

  // Password — Supabase auth validators.
  // The complexity error ("Password should contain at least one character of each: ...")
  // is handled specially by humanizePasswordComplexity() so we can list the
  // missing pieces in plain English. Keep these regex patterns only for the
  // simpler / phrased variants.
  {
    test: /password should be at least (\d+) characters?/i,
    message: "Your password needs to be a bit longer. Use at least 8 characters.",
  },
  {
    test: /password is too short/i,
    message: "Your password is a bit short. Use at least 8 characters.",
  },
  {
    test: /password.*(known to be weak|easy to guess|too common|breach|pwned|leaked)/i,
    message: "That password has shown up in known leaks. Please pick something more unique.",
  },
  {
    test: /(weak_password|password is weak)/i,
    message: "That password is a little weak. Try mixing letters, numbers, and a symbol.",
  },
  {
    test: /new password should be different from the old password/i,
    message: "Your new password needs to be different from your current one.",
  },
  {
    test: /same_password|password should be different/i,
    message: "Pick a password you haven't used before on this account.",
  },
  {
    test: /signup requires a valid password|password is required/i,
    message: "Please enter a password to continue.",
  },

  // Email
  {
    test: /(unable to validate email address.*invalid format|invalid_email|email.*not valid)/i,
    message: "That email doesn't look quite right. Double-check the address and try again.",
  },
  {
    test: /(user already registered|email_exists|already been registered|email address.*already)/i,
    message: "An account with this email already exists. Try logging in instead.",
  },
  {
    test: /email not confirmed|email_not_confirmed/i,
    message: "Please verify your email before logging in — check your inbox for the link.",
  },
  {
    test: /(email link is invalid|otp_expired|token has expired|invalid or has expired|expired_token)/i,
    message: "That link has expired or has already been used. Request a fresh one to continue.",
  },
  {
    test: /(invalid login credentials|invalid_credentials|incorrect.*password)/i,
    message: "That email and password don't match. Please double-check and try again.",
  },
  {
    test: /(user_not_found|user not found)/i,
    message: "We couldn't find an account with that email.",
  },
  {
    test: /(signup(s)? (not allowed|disabled|are disabled))/i,
    message: "New sign-ups are paused right now. Please try again later.",
  },
  {
    test: /(anonymous sign-?ins are disabled)/i,
    message: "Guest sign-in isn't available. Please use email or a social login.",
  },
  {
    test: /(invalid refresh token|refresh_token_not_found|refresh_token_already_used)/i,
    message: "Your session expired. Please log in again to continue.",
  },
  {
    test: /(auth session missing|session_not_found)/i,
    message: "We couldn't find your session. Please log in again.",
  },
  {
    test: /(provider is not enabled|provider_disabled)/i,
    message: "That sign-in option isn't available right now.",
  },
  {
    test: /(bad_jwt|invalid jwt)/i,
    message: "Your session is no longer valid. Please log in again.",
  },

  { test: /Not authenticated/i, message: "Please log in to continue." },
  { test: /JWT expired/i, message: "Your session expired. Please log in again." },
  {
    test: /(failed to fetch|networkerror|fetch failed|load failed)/i,
    message: "We couldn't reach the server. Check your internet connection and try again.",
  },

  // Generic Supabase
  { test: /duplicate key value violates unique constraint/i, message: "That already exists." },
  { test: /violates row-level security policy/i, message: "You don't have permission to do that." },
  { test: /permission denied for/i, message: "You don't have permission to do that." },
];

// Default copy when we have no error object and no fallback was provided.
const GENERIC_FALLBACK = "Something went wrong. Please try again.";

// Supabase returns password-complexity errors with the literal character
// classes the password is missing, e.g.
//   "Password should contain at least one character of each:
//    abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789."
// We detect which classes were listed and build a friendly sentence naming
// them in plain English.
function humanizePasswordComplexity(raw: string): string | null {
  if (!/password should (contain )?at least one character of each/i.test(raw)) return null;

  const needs: string[] = [];
  if (/abcdefghijklmnopqrstuvwxyz/.test(raw)) needs.push("a lowercase letter");
  if (/ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(raw)) needs.push("an uppercase letter");
  if (/0123456789/.test(raw)) needs.push("a number");
  // The symbol set is long and varies — detect any common punctuation grouping
  // after the digits, or the literal word "symbol".
  if (/[!@#$%^&*()_+\-=[\]{};:"\\|,.<>/?]{3,}/.test(raw) || /\bsymbol\b/i.test(raw)) {
    needs.push("a symbol");
  }

  if (needs.length === 0) {
    return "Make your password stronger — add a mix of letters, numbers, and symbols.";
  }

  // Join with commas + "and" before the last item.
  const list =
    needs.length === 1
      ? needs[0]
      : needs.slice(0, -1).join(", ") + " and " + needs[needs.length - 1];

  return `Your password needs ${list}.`;
}

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

  // Password complexity gets its own builder because Supabase echoes the
  // literal character classes ("abcdefghij...") instead of plain labels.
  const complexity = humanizePasswordComplexity(raw);
  if (complexity) return complexity;

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
