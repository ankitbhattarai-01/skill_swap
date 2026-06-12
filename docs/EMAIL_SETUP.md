# Session email pipeline setup

This walks through enabling transactional emails for session lifecycle events
(`session_requested`, `session_accepted`, `session_rejected`, `session_cancelled`,
`session_completed`). The pipeline is also ready to handle `session_rescheduled`
the moment a notification of that type starts being inserted — no extra wiring
needed.

The pipeline is:

```
session insert/update
    └─ trigger notify_session_lifecycle  →  row in public.notifications
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
