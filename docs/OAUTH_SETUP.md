# OAuth provider setup (Google + GitHub)

Walkthrough for enabling third-party sign-in on SkillSwap Connect. Once both
providers are configured in the Supabase dashboard, the `Continue with Google`
and `Continue with GitHub` buttons on `/login` and `/signup` work end-to-end:
the user is bounced to the provider, comes back through `/auth/callback`,
their profile row is auto-created by the `handle_new_user` trigger, and they
land on `/dashboard` (returning user) or `/onboarding` (first sign-in).

If a provider is left unconfigured, the corresponding button surfaces a clear
"sign-in is not enabled" toast and the rest of auth (email + password) keeps
working untouched.

---

## 1. Pick your redirect URLs

You need three URLs in your Supabase **Authentication → URL Configuration**
section before touching any provider settings:

| Field                      | Value                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Site URL                   | `https://<your-domain>` (or `http://localhost:5173` during local dev)                                                 |
| Redirect URLs (allow list) | `https://<your-domain>/auth/callback`, `http://localhost:5173/auth/callback`                                          |
| Additional redirects       | `https://<your-domain>/auth/callback?next=*` if you want to allow the `?next=` query param Supabase strips by default |

Supabase rejects any provider redirect that doesn't exactly match an entry in
the allow list, so add both production and local-dev origins now to avoid
"Invalid Redirect URL" errors later.

---

## 2. Google

1. Open https://console.cloud.google.com and create (or pick) a project.
2. Go to **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name: `SkillSwap Connect`.
   - Support email: your project email.
   - Scopes: `userinfo.email`, `userinfo.profile`, `openid` (the defaults are fine).
   - Test users: add your own email while the app is in "Testing" mode, or
     publish the app to skip this once you're ready.
3. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: your site URL (and `http://localhost:5173`).
   - Authorized redirect URIs: copy the **Callback URL (for OAuth)** value
     from Supabase's Google provider page — it looks like
     `https://<project-ref>.supabase.co/auth/v1/callback`. Paste it here.
4. Copy the **Client ID** and **Client Secret** Google gives you.
5. In Supabase: **Authentication → Providers → Google**:
   - Toggle **Enable Sign in with Google**.
   - Paste the Client ID and Client Secret.
   - Leave "Skip nonce checks" off unless you're debugging.
   - Save.

Test: open `/login`, click **Continue with Google**, you should bounce
through `accounts.google.com` and land back on `/dashboard` (or `/onboarding`
if it's your first sign-in with that Google account).

---

## 3. GitHub

1. Open https://github.com/settings/developers → **New OAuth App**:
   - Application name: `SkillSwap Connect`.
   - Homepage URL: your site URL.
   - Authorization callback URL: same Supabase callback URL as above
     (`https://<project-ref>.supabase.co/auth/v1/callback`).
2. Click **Register application**.
3. On the next page, click **Generate a new client secret**. Copy both the
   **Client ID** (shown at the top) and the **Client Secret** (shown once).
4. In Supabase: **Authentication → Providers → GitHub**:
   - Toggle **Enable Sign in with GitHub**.
   - Paste Client ID and Client Secret.
   - Save.

GitHub doesn't have a separate consent/testing flow — the moment the OAuth
app is created, anyone with a GitHub account can sign in. Add organization
restrictions in your GitHub OAuth App page if you want to limit access.

Test: open `/login`, click **Continue with GitHub**, you should bounce
through `github.com/login/oauth/authorize` and land back signed in.

---

## 4. Profile auto-creation

The `handle_new_user` trigger on `auth.users` runs on every signup (email,
Google, GitHub) and inserts a matching row into `public.profiles` with:

- `full_name` chosen from `raw_user_meta_data` keys in order:
  `full_name` → `name` → `user_name` → `preferred_username` → the local part
  of the email.
- `avatar_url` chosen from `raw_user_meta_data.avatar_url` (Google + GitHub
  both set this), falling back to `picture` (Google sometimes uses that key).
- `credits = 10` starting balance.

If you preseeded a profile row for a known user before they signed in, the
trigger's `ON CONFLICT DO UPDATE` keeps your preseeded name and only fills in
`avatar_url` if it was missing.

See `supabase/migrations/20260522000000_handle_new_user_oauth_metadata.sql`
for the exact function body.

---

## 5. Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                                                              | Fix                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "redirect_uri_mismatch" from Google                      | Authorized redirect URI in Google Cloud doesn't match the Supabase callback URL exactly.                                                                                  | Copy/paste from Supabase, not from memory. The `<project-ref>` matters.                                                                                                                             |
| "Invalid Redirect URL" from Supabase                     | Your app passed a `redirectTo` that's not in the Supabase URL allow list.                                                                                                 | Add `https://<your-domain>/auth/callback` to **Redirect URLs**.                                                                                                                                     |
| "provider is not enabled" toast on the login button      | The provider toggle in Supabase is off, or you saved without filling in Client ID/Secret.                                                                                 | Re-open the provider in Supabase and verify both fields are populated.                                                                                                                              |
| User lands on `/auth/callback` and sees the error screen | Provider sent back `error=` instead of `code=`. Check the URL bar — `error_description` will tell you what the provider rejected (most commonly the user denied consent). | Most are user-driven; if you see "invalid_grant" repeatedly, the code is being exchanged twice (e.g., two tabs racing). The callback page guards against React's strict-mode double-effect already. |
| Signed in but profile has email-prefix name              | OAuth provider returned a `raw_user_meta_data` without any name keys, or the migration in §4 hasn't been applied yet.                                                     | Confirm the migration ran (`select pg_get_functiondef('public.handle_new_user'::regproc)` should mention `preferred_username`).                                                                     |
