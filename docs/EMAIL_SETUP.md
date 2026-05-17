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
                                                                              └─ Resend HTTP API
                                                                                     └─ recipient inbox
```

If any step is unconfigured, the rest of the system keeps working —
notifications still land in-app, you just don't get an email.

---

## 1. Create a Resend account

1. Sign up at https://resend.com (free tier: 3,000 emails/month, 100/day).
2. Verify a domain you control under **Domains** (recommended for production).
   For testing you can use Resend's built-in `onresend.com` sender — no domain
   verification needed, but limited to your account's email address.
3. Create an API key under **API Keys** → **Create API Key** (full access).
   Copy the `re_…` value once — Resend never shows it again.

## 2. Set Supabase secrets

These are read by the Edge Function at runtime. Run from PowerShell in the
project root:

```powershell
supabase secrets set `
  RESEND_API_KEY="re_paste_your_key_here" `
  RESEND_FROM_EMAIL="SkillSwap <noreply@yourdomain.com>" `
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

You should see one POST per session_* notification with a `{ "sent": true }`
response. If you see `401 Invalid signature`, the secret in step 4 doesn't
match `EMAIL_WEBHOOK_SECRET` from step 2.

## 6. (Optional) Let users opt out

The migration adds a boolean column `profiles.email_notifications_enabled`
(defaults to `true`). To wire it into the profile UI:

```ts
await supabase
  .from("profiles")
  .update({ email_notifications_enabled: enabled })
  .eq("id", userId);
```

The Edge Function checks this flag before sending — opted-out users still get
in-app notifications, they just don't get email.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No email, no log entry | Config row missing — re-run step 4 |
| `401 Missing signature headers` | Calling the function directly from the browser/curl. Only the DB trigger is supposed to reach it. |
| `401 Invalid signature` | `EMAIL_WEBHOOK_SECRET` ≠ `private.email_dispatch_config.shared_secret` |
| `404 Recipient email not found` | User was deleted between trigger and dispatch — safe to ignore |
| `502 Resend request failed 403` | API key revoked, or sending from an unverified domain |
| `502 Resend request failed 422` | `RESEND_FROM_EMAIL` malformed — must be `Name <user@domain>` |

## Disabling the pipeline

Either delete the config row (fastest) or drop the trigger:

```sql
-- Quick disable, keep wiring:
DELETE FROM private.email_dispatch_config;

-- Full removal:
DROP TRIGGER IF EXISTS notifications_session_email_fanout ON public.notifications;
```
