# Session email pipeline setup

This walks through enabling transactional emails for session lifecycle events
(`session_requested`, `session_offered`, `session_accepted`, `session_rejected`,
`session_cancelled`, `session_completed`, `session_rescheduled`) plus the
one-off `welcome` email sent when an account is created (20260725070000) —
the only mail an OAuth signup produces, since Supabase skips its confirmation
email when Google has already verified the address.

The pipeline is:

```
session insert/update                 (or: new row in public.profiles)
    └─ trigger notify_session_lifecycle  →  row in public.notifications
       (welcome: trigger notify_new_user_welcome)
                                                  └─ trigger fanout_session_email
                                                         └─ private.dispatch_session_email
                                                                └─ net.http_post (HMAC-signed)
                                                                       └─ Edge Function send-session-email
                                                                              └─ Gmail SMTP (nodemailer + App Password)
                                                                                     └─ recipient inbox
```

If any step is unconfigured, the rest of the system keeps working —
notifications still land in-app, you just don't get an email.

> History note: the pipeline originally shipped against Resend's HTTP API
> (and migration `20260518000000_session_email_dispatch.sql` still mentions it
> in a comment). The function now sends through Gmail SMTP; the steps below
> reflect the current implementation.

---

## 1. Create a Gmail App Password

1. Use (or create) the Gmail account that will send the emails.
2. Enable 2-Step Verification on the account — App Passwords require it.
3. Go to https://myaccount.google.com/apppasswords and create an app password
   (any name, e.g. "SkillSwap"). Copy the 16-character value — Google only
   shows it once.

> Gmail's normal account password will NOT work for SMTP; it must be an App
> Password. Free Gmail caps sending at roughly 500 recipients/day.

## 2. Set Supabase secrets

These are read by the Edge Function at runtime. Run from PowerShell in the
project root:

```powershell
supabase secrets set `
  GMAIL_USER="youraddress@gmail.com" `
  GMAIL_APP_PASSWORD="the16charapppassword" `
  GMAIL_FROM_NAME="SkillSwap Connect" `
  EMAIL_WEBHOOK_SECRET="paste_a_long_random_string_here" `
  APP_PUBLIC_URL="https://your-deployed-app.example.com"
```

Optionally also set `EMAIL_TIMEZONE` (any IANA zone name) to control how
session times are printed in the email — there's no browser to infer it from,
so it defaults to `Asia/Kathmandu`:

```powershell
supabase secrets set EMAIL_TIMEZONE="Asia/Kathmandu"
```

> `GMAIL_FROM_NAME` affects deliverability more than it looks. A brand name in
> front of a personal `@gmail.com` address is a phishing pattern to Gmail's
> filter — see [Deliverability](#deliverability-why-these-emails-land-in-spam).

Generate the webhook secret with:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

> Keep `EMAIL_WEBHOOK_SECRET` somewhere safe — you need the same value in
> step 4.

## 3. Deploy the Edge Function

```powershell
supabase functions deploy send-session-email
```

Confirm the URL — it'll look like
`https://<project-ref>.supabase.co/functions/v1/send-session-email`.

## 4. Tell Postgres how to call the function

Apply the migration first (if you haven't already):

```powershell
supabase db push
```

Then populate the runtime config row. Run this from the Supabase SQL editor
(it requires service-role privileges; the table is not exposed to anon /
authenticated):

```sql
INSERT INTO private.email_dispatch_config (singleton, target_url, shared_secret)
VALUES (
  TRUE,
  'https://<project-ref>.supabase.co/functions/v1/send-session-email',
  'paste_the_same_EMAIL_WEBHOOK_SECRET_from_step_2'
)
ON CONFLICT (singleton) DO UPDATE
  SET target_url    = EXCLUDED.target_url,
      shared_secret = EXCLUDED.shared_secret,
      updated_at    = now();
```

## 5. Smoke test

Trigger any session event end-to-end (e.g. request a session from one account
to another) and watch:

```powershell
supabase functions logs send-session-email --tail
```

You should see one POST per session\_\* notification with a `{ "sent": true }`
response. If you see `401 Invalid signature`, the secret in step 4 doesn't
match `EMAIL_WEBHOOK_SECRET` from step 2.

## 6. (Optional) Let users opt out

The migration adds a boolean column `profiles.email_notifications_enabled`
(defaults to `true`). To wire it into the profile UI:

```ts
await supabase.from("profiles").update({ email_notifications_enabled: enabled }).eq("id", userId);
```

The Edge Function checks this flag before sending — opted-out users still get
in-app notifications, they just don't get email.

---

## Deliverability: why these emails land in spam

Gmail put the "requested a session" email in spam even though the headers said
`SPF: PASS`, `DKIM: signed-by gmail.com`, `TLS`. That is worth understanding,
because it means **authentication was never the problem** — the message was
correctly signed and still filtered. Gmail rejected it on reputation and shape.

Four things were working against us, in rough order of weight.

### 1. A brand identity on a free personal Gmail address (biggest factor)

The mail goes out as `SkillSwap Connect <utsabkarki1377@gmail.com>`. A company
display name in front of a personal `@gmail.com` mailbox is the exact pattern
consumer phishing uses, so Gmail discounts it heavily. It also means:

- DKIM signs for `gmail.com`, not for us — we accumulate **no domain
  reputation**, ever. The reputation being judged is that of one personal
  mailbox that has never sent templated HTML before.
- We can't publish SPF/DKIM/DMARC records, because we don't own `gmail.com`.
- We can't register in Google Postmaster Tools, so we're blind to our own
  spam rate.

**The real fix is to send from a domain we control** (see below). Everything
else on this list is worth doing, but this is the one that decides the
outcome.

Cheap interim improvement: set `GMAIL_FROM_NAME` to something that matches the
address instead of contradicting it — e.g. `Utsab Karki (SkillSwap Connect)`.
Gmail→Gmail personal mail is trusted far more than Gmail→Gmail brand mail.

### 2. We were declaring ourselves bulk mail

The function used to set a `List-Unsubscribe` header. That header is for
mailing lists, and Gmail rendered it as the "Unsubscribe from this sender"
chip in the screenshot — proof it had bucketed the message as bulk. Once a
message is judged as bulk, it is scored against bulk-sender expectations
(domain reputation, complaint rate, volume history) that a personal Gmail
account cannot satisfy.

These messages are transactional: one recipient, one event on their own
account, no list. The header is now gone, along with the redundant `Reply-To`
that duplicated `From`. The opt-out itself still exists — it's linked in the
footer and enforced by `profiles.email_notifications_enabled`.

### 3. The subject line opened with the recipient's first name

`Dwane, Utsab Karki requested a session` — a bare `Firstname,` opener is the
signature of cold outreach, and it was buying us nothing. Subjects are now
event-first and carry the skill name (`Utsab Karki requested a session: Exam
Strategy`), which is both more useful and more distinct per message.

### 4. There was almost no content

The body was one fragment (`Exam Strategy • 2 credits`), one big dark button,
and a footer — a very high link-to-text ratio with nothing a content
classifier can read as legitimate correspondence. The function now looks the
session up from `metadata.sessionId` and renders real detail (skill, who,
when, length, cost), a plain sentence explaining what happened and what to do,
the destination URL in visible text under the button, and a plain-text part
that carries the same information as the HTML part.

> Note on what we deliberately did **not** add: a hidden preheader block.
> Hiding text with `display:none` so it shows in the inbox preview is a
> standard marketing trick and a well-known spam heuristic.

### The durable fix: send from your own domain

Content and header hygiene shift the odds. They do not override sender
reputation, and no amount of template editing will reliably inbox mail sent
as a brand from a free consumer mailbox. To actually solve it:

1. Register a domain (roughly $1–12/year — `.xyz` and `.site` are cheapest).
2. Sign up for a transactional email provider on its free tier — Resend
   (3,000/month, 100/day), Brevo (300/day), or Mailgun. Note the pipeline
   originally shipped against Resend, so that path is well-trodden here.
3. Add the DNS records the provider gives you: SPF (`TXT`), DKIM
   (`CNAME`/`TXT`), and DMARC (`_dmarc` `TXT`, start at `p=none`). Wait for
   the provider to show the domain verified.
4. Send as `notifications@yourdomain.com` instead of the Gmail address.

This also removes Gmail's ~500 recipients/day cap and gives you real bounce
and complaint reporting.

### If you need it inboxing *now* (demo / assessment)

Per-recipient filter training is immediate and beats every content signal:

- In the recipient's inbox, open the spam folder and click **Not spam**. One
  click permanently changes how that sender is scored for that recipient.
- Add the sending address to the recipient's Google Contacts.
- Or create an explicit rule: Gmail → Settings → Filters and Blocked Addresses
  → Create a new filter → `From: utsabkarki1377@gmail.com` → **Never send it
  to Spam**.

Do this on the accounts you'll be demoing with. It doesn't fix delivery for
new users, which is what the domain move is for.

### One more thing that hurts: the link target

Every link points at `*.vercel.app`. Free-hosting subdomains are abused
constantly and carry poor reputation, and the sending identity and the link
identity don't match. Pointing a custom domain at the Vercel deployment fixes
this at the same time as it fixes the `From` address.

---

## Troubleshooting

| Symptom                                                                 | Likely cause                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No email, no log entry                                                  | Config row missing — re-run step 4                                                                |
| `401 Missing signature headers`                                         | Calling the function directly from the browser/curl. Only the DB trigger is supposed to reach it. |
| `401 Invalid signature`                                                 | `EMAIL_WEBHOOK_SECRET` ≠ `private.email_dispatch_config.shared_secret`                            |
| `404 Recipient email not found`                                         | User was deleted between trigger and dispatch — safe to ignore                                    |
| `502 Email send failed` (logs show `Invalid login: 535`)                | `GMAIL_APP_PASSWORD` wrong/revoked, or 2-Step Verification was turned off                         |
| `502 Email send failed` (logs show `Daily user sending limit exceeded`) | Gmail's daily send cap reached — wait 24h or move to a dedicated provider                         |
| `200 { "skipped": "duplicate_dispatch" }`                               | Normal — a pg_net retry hit the per-notification dedupe in `public.session_email_deliveries`      |

## Delivery log

Every dispatch writes one row to `public.session_email_deliveries`
(migration `20260611120000_session_email_deliveries.sql`), keyed by
notification id — this is also what dedupes retries. To triage from the SQL
editor (service role only; the table is not exposed to clients):

```sql
SELECT notification_id, recipient, status, detail, created_at
FROM public.session_email_deliveries
ORDER BY created_at DESC
LIMIT 50;
```

## Disabling the pipeline

Either delete the config row (fastest) or drop the trigger:

```sql
-- Quick disable, keep wiring:
DELETE FROM private.email_dispatch_config;

-- Full removal:
DROP TRIGGER IF EXISTS notifications_session_email_fanout ON public.notifications;
```
