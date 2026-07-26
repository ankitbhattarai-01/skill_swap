// Session lifecycle email dispatcher.
//
// Called by a Postgres AFTER INSERT trigger on `public.notifications` (see
// migration 20260518000000_session_email_dispatch.sql). For every row with a
// `session_*` type — plus `welcome`, added in 20260725070000 — the trigger
// POSTs `{ notificationId }` here, signed with HMAC-SHA256 using the shared
// secret from `private.email_dispatch_config`.
//
// This function:
//   1. Verifies the HMAC signature — refuses anything else, so the function
//      cannot be abused by logged-in users or random callers.
//   2. Loads the notification with the service-role client.
//   3. Looks up the recipient's email and opt-out preference.
//   4. Renders the matching template.
//   5. Sends via Gmail SMTP using nodemailer + an App Password.
//
// Required Supabase secrets (set via `supabase secrets set ...`):
//   GMAIL_USER             - the Gmail address that sends (e.g. utsab@gmail.com)
//   GMAIL_APP_PASSWORD     - 16-char App Password from myaccount.google.com/apppasswords
//   GMAIL_FROM_NAME        - display name shown in inbox (e.g. "SkillSwap Connect")
//   EMAIL_WEBHOOK_SECRET   - matches private.email_dispatch_config.shared_secret
//   APP_PUBLIC_URL         - e.g. "https://skillswap-connect.pages.dev" (no trailing slash)
//   EMAIL_TIMEZONE         - optional IANA zone for rendering session times,
//                            defaults to Asia/Kathmandu
//
// Deliverability note: every message this function sends is transactional —
// it is addressed to one person about one thing that just happened on their
// own account. That shape has to be visible in the headers and the body, or
// Gmail scores it as unsolicited bulk mail. See docs/EMAIL_SETUP.md for the
// full reasoning behind the choices here (no List-Unsubscribe, no name-first
// subject lines, real session detail in the body).

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

type SupportedType =
  | "session_requested"
  // Teacher-initiated offer, awaiting the learner's answer. Same shape as
  // session_requested, opposite direction (20260725050000).
  | "session_offered"
  | "session_accepted"
  | "session_rejected"
  | "session_cancelled"
  | "session_completed"
  | "session_rescheduled"
  // Account created. Fired once per user by the AFTER INSERT trigger on
  // public.profiles (20260725070000) — the only non-session type this
  // function handles, and the only mail an OAuth signup ever produces
  // (Supabase sends no confirmation mail when Google already verified the
  // address).
  | "welcome";

const SUPPORTED_TYPES: ReadonlySet<SupportedType> = new Set([
  "session_requested",
  "session_offered",
  "session_accepted",
  "session_rejected",
  "session_cancelled",
  "session_completed",
  "session_rescheduled",
  "welcome",
]);

type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown> | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email_notifications_enabled: boolean | null;
};

type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

// Everything we can say about the session this notification is about, resolved
// from `metadata.sessionId`. All fields are optional: the notification is the
// source of truth for *what happened*, this is only enrichment, so a deleted
// session or an unapplied migration degrades to a thinner email rather than a
// failed send.
type SessionContext = {
  skillName: string | null;
  whenText: string | null;
  durationText: string | null;
  creditsText: string | null;
  counterpartName: string | null;
  counterpartLabel: string | null;
};

const EMPTY_CONTEXT: SessionContext = {
  skillName: null,
  whenText: null,
  durationText: null,
  creditsText: null,
  counterpartName: null,
  counterpartLabel: null,
};

function readSecret(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function hexEncode(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hexEncode(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)),
  );
  return timingSafeEqualHex(expected, signature.replace(/^sha256=/, ""));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function absoluteLink(path: string | null): string {
  const base = Deno.env.get("APP_PUBLIC_URL")?.replace(/\/$/, "") ?? "";
  if (!path) return base || "#";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Session times are stored as timestamptz and rendered here without a browser
// to supply a locale, so pick the zone explicitly. Deno ships full ICU, so any
// IANA name works; an invalid one falls back to UTC rather than throwing.
const EMAIL_TIMEZONE = Deno.env.get("EMAIL_TIMEZONE")?.trim() || "Asia/Kathmandu";

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: EMAIL_TIMEZONE,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}

function counterpartLabelFor(type: string, recipientIsTeacher: boolean): string {
  switch (type) {
    case "session_requested":
      return "Requested by";
    case "session_offered":
      return "Offered by";
    default:
      return recipientIsTeacher ? "Learner" : "Teacher";
  }
}

// Pull the concrete session facts into the email. Without this the entire body
// is the notification's own one-liner ("Exam Strategy • 2 credits"), which is
// too thin to read as a real transactional message — to a human *and* to a
// content classifier, which sees a couple of words wrapped around a single
// call-to-action link and scores it accordingly.
async function loadSessionContext(
  supabase: ReturnType<typeof createClient>,
  notification: NotificationRow,
): Promise<SessionContext> {
  const meta = notification.metadata ?? {};
  const asId = (value: unknown) => (typeof value === "string" && value ? value : null);
  const sessionId = asId(meta.sessionId);
  if (!sessionId) return EMPTY_CONTEXT;

  const teacherId = asId(meta.teacherId);
  const learnerId = asId(meta.learnerId);
  const recipientIsTeacher = teacherId !== null && notification.user_id === teacherId;
  const counterpartId = recipientIsTeacher
    ? learnerId
    : notification.user_id === learnerId
      ? teacherId
      : null;

  const [sessionResult, counterpartResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("credits, duration_minutes, scheduled_at, skills(name)")
      .eq("id", sessionId)
      .maybeSingle(),
    counterpartId
      ? supabase.from("profiles").select("full_name").eq("id", counterpartId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (sessionResult.error) {
    console.error("[send-session-email] session lookup failed", sessionResult.error);
  }

  const session = sessionResult.data as {
    credits: number | null;
    duration_minutes: number | null;
    scheduled_at: string | null;
    skills: { name: string | null } | { name: string | null }[] | null;
  } | null;

  // PostgREST returns an embedded to-one relation as an object, but older
  // clients and views can hand back a single-element array — accept both.
  const skill = Array.isArray(session?.skills) ? session?.skills[0] : session?.skills;
  const credits = session?.credits ?? null;
  const duration = session?.duration_minutes ?? null;
  const counterpartName =
    (counterpartResult.data as { full_name: string | null } | null)?.full_name ?? null;

  return {
    skillName: skill?.name ?? null,
    whenText: formatWhen(session?.scheduled_at ?? null),
    durationText: duration ? `${duration} minutes` : null,
    creditsText: credits === null ? null : `${credits} ${credits === 1 ? "credit" : "credits"}`,
    counterpartName,
    counterpartLabel: counterpartName
      ? counterpartLabelFor(notification.type, recipientIsTeacher)
      : null,
  };
}

function buildSubject(
  notification: NotificationRow,
  recipientName: string,
  ctx: SessionContext,
): string {
  // Deliberately NOT prefixed with the recipient's first name. "Dwane, Utsab
  // Karki requested a session" is the exact shape of cold bulk outreach, and
  // Gmail weights a bare leading first name accordingly. What actually helps a
  // transactional subject is being specific about the thing itself, so append
  // the skill — it also makes each message's subject distinct, which keeps a
  // run of notifications from looking like one blast.
  const baseTitle = notification.title;
  const skillSuffix =
    ctx.skillName && !baseTitle.toLowerCase().includes(ctx.skillName.toLowerCase())
      ? `: ${ctx.skillName}`
      : "";

  switch (notification.type) {
    case "session_rejected":
      // Soften "rejected" — same meaning, reads less like an alarm.
      return `${baseTitle.replace(/ rejected your session$/, " declined your session")}${skillSuffix}`;
    case "session_completed":
      return `${baseTitle} - credits transferred`;
    case "session_requested":
    case "session_offered":
    case "session_accepted":
    case "session_rescheduled":
    case "session_cancelled":
      return `${baseTitle}${skillSuffix}`;
    case "welcome":
      // Brand first, name second. This is the first mail we ever send this
      // address, so it has to be recognisable in the inbox before it's
      // personal — and a trailing name reads as a greeting rather than as the
      // "Firstname, <pitch>" opener that bulk senders use.
      return recipientName ? `${baseTitle}, ${recipientName}` : baseTitle;
    default:
      return baseTitle;
  }
}

function ctaLabelFor(type: string): string {
  switch (type) {
    case "session_completed":
      return "View history";
    case "session_rejected":
      return "Find another teacher";
    case "welcome":
      return "Get started";
    default:
      return "Open session";
  }
}

// First-session checklist, welcome mail only. Kept short — three concrete
// actions, in the order the app actually asks for them during onboarding.
const WELCOME_STEPS: readonly string[] = [
  "Add the skills you can teach — teaching is how you earn credits.",
  "Tell us what you want to learn so we can suggest people to swap with.",
  "Book your first session. You already have 10 credits to spend.",
];

// One plain sentence saying what happened and what, if anything, is expected of
// the reader. The notification's own `body` is a fragment ("Exam Strategy • 2
// credits") that repeats the detail table below, so it is only used as a
// fallback for types this switch doesn't know about.
function leadParagraph(notification: NotificationRow, ctx: SessionContext): string {
  const who = ctx.counterpartName ?? "Someone on SkillSwap Connect";
  const onSkill = ctx.skillName ? ` on ${ctx.skillName}` : "";

  switch (notification.type) {
    case "session_requested":
      return `${who} would like to book a session with you${onSkill}. Nothing is booked yet — it stays pending until you accept or decline it.`;
    case "session_offered":
      return `${who} has offered to teach you${onSkill}. Accept to lock in the time, or decline if it doesn't suit you.`;
    case "session_accepted":
      return `Your session${onSkill} is confirmed. The video room opens from the session page when it's time to start.`;
    case "session_rescheduled":
      return `The time for your session${onSkill} has changed. The new slot is below — check it still works for you.`;
    case "session_rejected":
      return `${who} isn't able to take this session${onSkill}. No credits were deducted, so you can book someone else whenever you're ready.`;
    case "session_cancelled":
      return `This session${onSkill} has been called off, and any credits held for it have been released.`;
    case "session_completed":
      return `Your session${onSkill} is marked complete and the credits have been transferred. A short review helps the next person choose.`;
    case "welcome":
      return `Your SkillSwap Connect account is ready. SkillSwap is where you trade skills with other people: you teach what you already know, earn credits for it, and spend those credits learning something new.`;
    default:
      return notification.body ?? "";
  }
}

function detailRows(ctx: SessionContext): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (ctx.skillName) rows.push(["Skill", ctx.skillName]);
  if (ctx.counterpartLabel && ctx.counterpartName) {
    rows.push([ctx.counterpartLabel, ctx.counterpartName]);
  }
  if (ctx.whenText) rows.push(["When", ctx.whenText]);
  if (ctx.durationText) rows.push(["Length", ctx.durationText]);
  if (ctx.creditsText) rows.push(["Cost", ctx.creditsText]);
  return rows;
}

function renderTemplate(
  notification: NotificationRow,
  recipientName: string,
  ctx: SessionContext,
): RenderedEmail {
  const subject = buildSubject(notification, recipientName, ctx);
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const lead = leadParagraph(notification, ctx);
  const ctaUrl = absoluteLink(notification.link);
  const ctaLabel = ctaLabelFor(notification.type);
  const isWelcome = notification.type === "welcome";
  const rows = detailRows(ctx);

  const detailsHtml = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px 0;border-collapse:collapse;font-size:15px;line-height:1.5;">
                ${rows
                  .map(
                    ([label, value]) =>
                      `<tr>
                  <td style="padding:6px 16px 6px 0;color:#71717a;white-space:nowrap;vertical-align:top;">${escapeHtml(
                    label,
                  )}</td>
                  <td style="padding:6px 0;color:#18181b;font-weight:600;vertical-align:top;">${escapeHtml(
                    value,
                  )}</td>
                </tr>`,
                  )
                  .join("")}
              </table>`
    : "";

  const stepsHtml = isWelcome
    ? `<ul style="margin:0 0 24px 0;padding-left:20px;font-size:15px;line-height:1.6;color:#3f3f46;">
                ${WELCOME_STEPS.map((step) => `<li style="margin-bottom:6px;">${escapeHtml(step)}</li>`).join("")}
              </ul>`
    : "";

  const footerNote = isWelcome
    ? "You're receiving this because an account was just created with this email address on SkillSwap Connect."
    : "This is an automatic notification about activity on your SkillSwap Connect account. You can turn these emails off in your";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(notification.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
            <tr><td style="padding-bottom:16px;">
              <div style="font-weight:700;font-size:18px;color:#0f172a;">SkillSwap Connect</div>
            </td></tr>
            <tr><td style="padding-bottom:12px;font-size:20px;font-weight:600;line-height:1.3;">
              ${escapeHtml(notification.title)}
            </td></tr>
            <tr><td style="padding-bottom:20px;font-size:15px;line-height:1.6;color:#3f3f46;">
              <p style="margin:0 0 12px 0;">${escapeHtml(greeting)}</p>
              ${lead ? `<p style="margin:0;">${escapeHtml(lead)}</p>` : ""}
            </td></tr>
            <tr><td>
              ${detailsHtml}
              ${stepsHtml}
            </td></tr>
            <tr><td style="padding-bottom:8px;">
              <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(ctaLabel)}</a>
            </td></tr>
            <tr><td style="padding-bottom:24px;font-size:12px;line-height:1.5;color:#71717a;word-break:break-all;">
              Or open this address in your browser:<br />${escapeHtml(ctaUrl)}
            </td></tr>
            <tr><td style="border-top:1px solid #e4e4e7;padding-top:16px;font-size:12px;color:#71717a;line-height:1.5;">
              ${escapeHtml(footerNote)}${
                isWelcome
                  ? ""
                  : ` <a href="${escapeHtml(absoluteLink("/profile"))}" style="color:#0f172a;">profile settings</a>.`
              }
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // The plain-text alternative carries the same information as the HTML part.
  // A text part that is much shorter than its HTML sibling is itself a spam
  // signal, and it's what filters read when they don't want to render markup.
  const text = [
    greeting,
    "",
    notification.title,
    lead ? `\n${lead}` : "",
    rows.length ? `\n${rows.map(([label, value]) => `  ${label}: ${value}`).join("\n")}` : "",
    isWelcome ? `\n${WELCOME_STEPS.map((step) => `  - ${step}`).join("\n")}` : "",
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    "— SkillSwap Connect",
    isWelcome
      ? "You're receiving this because an account was just created with this email address."
      : `Automatic notification about your account. Turn these off: ${absoluteLink("/profile")}`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  return { subject, html, text };
}

// Reuse a single transporter across invocations. Edge Functions keep their
// runtime warm between invocations for a short window, so this saves the
// TLS handshake to Gmail on every email.
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: readSecret("GMAIL_USER"),
      pass: readSecret("GMAIL_APP_PASSWORD"),
    },
  });
  return transporter;
}

async function sendViaGmail(to: string, rendered: RenderedEmail): Promise<void> {
  const fromAddress = readSecret("GMAIL_USER");
  const fromName = Deno.env.get("GMAIL_FROM_NAME")?.trim() || "SkillSwap Connect";

  await getTransporter().sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // No List-Unsubscribe, and no Reply-To duplicating From.
    //
    // List-Unsubscribe was here on the theory that it helps deliverability.
    // It does — for bulk mail. These messages are transactional: one
    // recipient, one thing that just happened on their own account, no
    // mailing list. Declaring an unsubscribe header tells Gmail the opposite,
    // it renders the "Unsubscribe from this sender" chip, and the message is
    // then judged as bulk against a sender with no bulk reputation to lean
    // on. The opt-out still exists and is linked in the footer — it just
    // isn't advertised in the headers as if this were a newsletter.
    //
    // Reply-To identical to From is redundant (replies already go there) and
    // shows up as an extra machine-generated header in Gmail's detail view.
  });
}

// Nodemailer errors carry the useful part outside `.message` — `code` is the
// class of failure (EAUTH, ECONNECTION, ETIMEDOUT, ESOCKET) and `response` is
// Gmail's verbatim SMTP reply. Flatten all of it into one string so a failure
// is diagnosable from `net._http_response` alone, without dashboard access.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  const extra = error as Error & {
    code?: string;
    responseCode?: number;
    response?: string;
    command?: string;
  };
  return [
    extra.code ? `[${extra.code}]` : null,
    extra.responseCode ? `(${extra.responseCode})` : null,
    extra.command ? `cmd=${extra.command}` : null,
    error.message,
    extra.response && extra.response !== error.message ? `| ${extra.response}` : null,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const timestamp = req.headers.get("x-skillswap-timestamp") ?? "";
  const signature = req.headers.get("x-skillswap-signature") ?? "";
  if (!timestamp || !signature) {
    return jsonResponse(401, { error: "Missing signature headers" });
  }

  const rawBody = await req.text();

  let secret: string;
  try {
    secret = readSecret("EMAIL_WEBHOOK_SECRET");
  } catch (error) {
    console.error("[send-session-email] secret read failed", error);
    return jsonResponse(500, { error: "Misconfigured secrets" });
  }

  if (!(await verifySignature(rawBody, timestamp, signature, secret))) {
    return jsonResponse(401, { error: "Invalid signature" });
  }

  let payload: { notificationId?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const notificationId = typeof payload.notificationId === "string" ? payload.notificationId : null;
  if (!notificationId) {
    return jsonResponse(400, { error: "notificationId is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: notification, error: notifError } = await supabase
    .from("notifications")
    .select("id, user_id, type, title, body, link, metadata")
    .eq("id", notificationId)
    .maybeSingle<NotificationRow>();

  if (notifError) {
    console.error("[send-session-email] notification lookup failed", notifError);
    return jsonResponse(500, { error: "Notification lookup failed" });
  }
  if (!notification) {
    return jsonResponse(404, { error: "Notification not found" });
  }
  if (!SUPPORTED_TYPES.has(notification.type as SupportedType)) {
    return jsonResponse(200, { skipped: "unsupported_type", type: notification.type });
  }

  // ── Dedupe + delivery log ─────────────────────────────────────────────────
  // Claim the notification by inserting its delivery row. The PRIMARY KEY on
  // notification_id makes exactly one invocation win — a pg_net retry or a
  // double trigger fire hits the conflict and exits instead of emailing the
  // recipient twice. The row is then updated with the terminal outcome so
  // "did that email actually go out?" is answerable from SQL.
  // Degrades gracefully when the migration hasn't been applied yet: any error
  // other than the unique conflict is logged and dispatch proceeds un-deduped.
  let deliveryLogAvailable = true;
  {
    const { error: claimError } = await supabase
      .from("session_email_deliveries")
      .insert({ notification_id: notification.id, status: "pending" });
    if (claimError) {
      if (claimError.code === "23505") {
        return jsonResponse(200, { skipped: "duplicate_dispatch" });
      }
      deliveryLogAvailable = false;
      console.error("[send-session-email] delivery log unavailable", claimError);
    }
  }
  const recordOutcome = async (
    status: "sent" | "failed" | "skipped",
    detail: string | null,
    recipient: string | null = null,
  ) => {
    if (!deliveryLogAvailable) return;
    const { error } = await supabase
      .from("session_email_deliveries")
      .update({ status, detail, recipient, updated_at: new Date().toISOString() })
      .eq("notification_id", notification.id);
    if (error) console.error("[send-session-email] delivery log update failed", error);
  };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, email_notifications_enabled")
    .eq("id", notification.user_id)
    .maybeSingle<ProfileRow>();

  if (profileError) {
    console.error("[send-session-email] profile lookup failed", profileError);
    await recordOutcome("failed", "profile lookup failed");
    return jsonResponse(500, { error: "Profile lookup failed" });
  }
  if (profile && profile.email_notifications_enabled === false) {
    await recordOutcome("skipped", "user_opted_out");
    return jsonResponse(200, { skipped: "user_opted_out" });
  }

  const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(
    notification.user_id,
  );
  if (authError || !authUser?.user?.email) {
    await recordOutcome("failed", "recipient email not found");
    return jsonResponse(404, { error: "Recipient email not found" });
  }

  const recipientName = profile?.full_name?.split(" ")[0] ?? "";
  const sessionContext = await loadSessionContext(supabase, notification);
  const rendered = renderTemplate(notification, recipientName, sessionContext);

  try {
    await sendViaGmail(authUser.user.email, rendered);
  } catch (error) {
    // SMTP errors can include the relay banner, auth method names, etc.
    console.error("[send-session-email] gmail send failed", error);
    const detail = describeError(error);
    await recordOutcome("failed", detail, authUser.user.email);
    // Echo the detail back to the caller. Only an HMAC-signed request (i.e.
    // the DB trigger) can reach this line, so this leaks nothing publicly —
    // and it lands the real SMTP error in `net._http_response.content`, which
    // is the one place we can read it back with plain SQL.
    return jsonResponse(502, { error: "Email send failed", detail });
  }

  await recordOutcome("sent", null, authUser.user.email);
  return jsonResponse(200, { sent: true, to: authUser.user.email });
});
