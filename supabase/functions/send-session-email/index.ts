// Session lifecycle email dispatcher.
//
// Called by a Postgres AFTER INSERT trigger on `public.notifications` (see
// migration 20260518000000_session_email_dispatch.sql). For every row with a
// `session_*` type the trigger POSTs `{ notificationId }` here, signed with
// HMAC-SHA256 using the shared secret from `private.email_dispatch_config`.
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
  | "session_rescheduled";

const SUPPORTED_TYPES: ReadonlySet<SupportedType> = new Set([
  "session_requested",
  "session_offered",
  "session_accepted",
  "session_rejected",
  "session_cancelled",
  "session_completed",
  "session_rescheduled",
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

function buildSubject(notification: NotificationRow, recipientName: string): string {
  // Personalize with recipient's first name when we have it — Gmail treats
  // first-name subjects as a positive engagement signal. Keep it conversational
  // and avoid bracket-prefixes (Gmail treats unknown-brand brackets as low-rep).
  const namePrefix = recipientName ? `${recipientName}, ` : "";
  const baseTitle = notification.title;

  switch (notification.type) {
    case "session_rejected":
      // Soften "rejected" — same meaning, less alarming for spam classifiers.
      return `${namePrefix}${baseTitle.replace(/ rejected your session$/, " declined your session")}`;
    case "session_cancelled":
      return `Heads-up: ${baseTitle}`;
    case "session_completed":
      return `${baseTitle} — credits transferred`;
    case "session_requested":
    case "session_offered":
    case "session_accepted":
    case "session_rescheduled":
      return `${namePrefix}${baseTitle}`;
    default:
      return baseTitle;
  }
}

function renderTemplate(notification: NotificationRow, recipientName: string): RenderedEmail {
  const subject = buildSubject(notification, recipientName);
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const bodyText = notification.body ?? "";
  const ctaUrl = absoluteLink(notification.link);
  const ctaLabel =
    notification.type === "session_completed"
      ? "View history"
      : notification.type === "session_rejected"
        ? "Find another teacher"
        : "Open session";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
            <tr><td style="padding-bottom:16px;">
              <div style="font-weight:700;font-size:18px;color:#0f172a;">SkillSwap Connect</div>
            </td></tr>
            <tr><td style="padding-bottom:8px;font-size:20px;font-weight:600;line-height:1.3;">
              ${escapeHtml(notification.title)}
            </td></tr>
            <tr><td style="padding-bottom:24px;font-size:15px;line-height:1.5;color:#3f3f46;">
              <p style="margin:0 0 12px 0;">${escapeHtml(greeting)}</p>
              ${bodyText ? `<p style="margin:0;">${escapeHtml(bodyText)}</p>` : ""}
            </td></tr>
            <tr><td style="padding-bottom:24px;">
              <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(ctaLabel)}</a>
            </td></tr>
            <tr><td style="border-top:1px solid #e4e4e7;padding-top:16px;font-size:12px;color:#71717a;line-height:1.5;">
              You're receiving this because you have session notifications enabled.
              Manage your preferences in your <a href="${escapeHtml(absoluteLink("/profile"))}" style="color:#0f172a;">profile</a>.
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    greeting,
    "",
    notification.title,
    bodyText ? `\n${bodyText}` : "",
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    "— SkillSwap Connect",
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
    replyTo: fromAddress,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      // Plain mailto-based List-Unsubscribe. Don't add List-Unsubscribe-Post
      // unless we also provide an HTTPS one-click endpoint — Gmail's filter
      // rejects mail with inconsistent unsubscribe headers (RFC 8058).
      "List-Unsubscribe": `<mailto:${fromAddress}?subject=unsubscribe>`,
    },
  });
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
  const rendered = renderTemplate(notification, recipientName);

  try {
    await sendViaGmail(authUser.user.email, rendered);
  } catch (error) {
    // SMTP errors can include the relay banner, auth method names, etc.
    console.error("[send-session-email] gmail send failed", error);
    await recordOutcome(
      "failed",
      error instanceof Error ? error.message.slice(0, 500) : "smtp send failed",
      authUser.user.email,
    );
    return jsonResponse(502, { error: "Email send failed" });
  }

  await recordOutcome("sent", null, authUser.user.email);
  return jsonResponse(200, { sent: true, to: authUser.user.email });
});
