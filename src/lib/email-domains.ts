// Allow-list of email providers accepted at signup. We restrict to mainstream
// consumer mailboxes so that disposable / temp-mail services (mailinator,
// 10minutemail, guerrillamail, tempmail, etc.) can't be used to spin up
// throwaway accounts. Existing users with other domains can still log in --
// this check only gates new signups.
export const ALLOWED_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "icloud.com",
  "me.com",
  "mac.com",
]);

export function extractEmailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1) return null;
  return trimmed.slice(at + 1);
}

export function isAllowedSignupEmail(email: string): boolean {
  const domain = extractEmailDomain(email);
  return domain !== null && ALLOWED_EMAIL_DOMAINS.has(domain);
}

export function allowedDomainsLabel(): string {
  return "Gmail, Outlook/Hotmail, Yahoo, or iCloud";
}
