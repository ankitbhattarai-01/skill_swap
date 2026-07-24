# Deploying SkillSwap Connect to Vercel

This is the frontend deployment guide. **Supabase (database, auth, realtime, edge
functions) is unchanged** — Vercel only hosts the TanStack Start web app. Every
"real" backend call still goes to Supabase directly from the browser.

## What changed in the codebase

The app used to build for **Cloudflare Workers** (`@cloudflare/vite-plugin` +
`server.ts` + `wrangler.jsonc`). To run on Vercel it now builds with **Nitro**,
which is TanStack Start's official Vercel path.

| Before (Cloudflare)                              | After (Vercel)                                        |
| ------------------------------------------------ | ----------------------------------------------------- |
| `@cloudflare/vite-plugin` on build               | `nitro()` from `nitro/vite`                            |
| `server.ts` injected security headers (CSP etc.) | Headers ported to Nitro `routeRules` in `vite.config` |
| Per-request CSP **nonce** via CF `HTMLRewriter`  | Static CSP (`script-src 'unsafe-inline'`) — CF-only API is gone |
| `wrangler deploy`                                | `git push` → Vercel auto-build                        |

`server.ts` and `wrangler.jsonc` are now **dormant** (Vercel ignores them). They're
left in place so a Cloudflare deploy is still possible; delete them only if you're
sure you'll never go back.

> **Note on the CSP:** Cloudflare's nonce-based CSP relied on a Cloudflare-only
> browser API that doesn't exist on Vercel, so `script-src` falls back to
> `'unsafe-inline'`. This is the standard tradeoff for a non-Cloudflare host and is
> defined in `vite.config.ts` (`SECURITY_HEADERS`). All the tight origin
> allowlists (Supabase, Jitsi/8x8, hCaptcha, Google) are preserved.

---

## Step 1 — Commit & push the build-config changes

Vercel builds from GitHub, so the config changes must be on the branch you deploy.

Files changed: `vite.config.ts`, `package.json`, `package-lock.json`, plus this doc.

```bash
git add vite.config.ts package.json package-lock.json docs/DEPLOYMENT_VERCEL.md
git commit -m "build: target Vercel via Nitro instead of Cloudflare Workers"
git push
```

## Step 2 — Import the repo on Vercel

1. Go to **[vercel.com/new](https://vercel.com/new)** and sign in with GitHub.
2. **Import** the `skillswap-connect` repository.
3. **Framework Preset:** Vercel should auto-detect **TanStack Start**. If it shows
   "Other", that's fine — leave the **Build Command** as `npm run build` and leave
   **Output Directory** blank (Nitro writes to `.vercel/output` via the Build
   Output API; do not override it).
4. **Root Directory:** leave as the repo root.
5. Don't click Deploy yet — set env vars first (Step 3).

## Step 3 — Environment variables

Add these under **Project → Settings → Environment Variables** (apply to
**Production** and **Preview**). These are all **public / publishable** client keys —
safe to expose; they're baked into the browser bundle at build time. The Supabase
service-role key and other server secrets are **not** here — they live only in
Supabase.

| Name                            | Value                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| `VITE_SUPABASE_PROJECT_ID`      | `hgkgeosmpsznumuhqrck`                                      |
| `VITE_SUPABASE_URL`             | `https://hgkgeosmpsznumuhqrck.supabase.co`                 |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_HeEresTINIWXQ48q5JZbxg_rOvgrFS8`           |
| `VITE_JAAS_APP_ID`              | `vpaas-magic-cookie-9f013c7a1ee84086a7af32ec5f3d067f`      |
| `VITE_JITSI_DOMAIN`             | `8x8.vc`                                                   |
| `VITE_TURNSTILE_SITE_KEY`       | `0x4AAAAAADVgSbQFIWj8arGi`                                  |

> Anything not `VITE_`-prefixed is ignored by the client build. If you later enable
> hCaptcha instead of Turnstile, add `VITE_HCAPTCHA_SITE_KEY`.

## Step 4 — Deploy

Click **Deploy**. First build takes ~2–4 min. You'll get a URL like
`https://skillswap-connect.vercel.app`. **The app will load, but auth, edge
functions, CAPTCHA, and emails won't fully work until Step 5.**

---

## Step 5 — Post-deploy wiring (required — do not skip)

Replace `YOUR_URL` below with your real Vercel URL (no trailing slash), e.g.
`https://skillswap-connect.vercel.app`. If you add a custom domain later, redo
these with the new domain.

### 5a. Supabase Auth URLs — *(fixes login, Google OAuth, email confirm/reset links)*

Supabase Dashboard → **Authentication → URL Configuration**:

- **Site URL:** `YOUR_URL`
- **Redirect URLs:** add both
  - `YOUR_URL/**`
  - `YOUR_URL/auth/callback`
  - (keep your `http://localhost:8080/**` entry for local dev)

### 5b. Edge Function CORS — *(fixes AI suggestions, session notes, practice, Jitsi token, email dispatch)*

Without this, the browser's calls to Supabase Edge Functions are blocked by CORS.
Run in a terminal with the Supabase CLI (localhost is always allowed automatically):

```bash
supabase secrets set CORS_ALLOWED_ORIGINS="YOUR_URL"
```

### 5c. Email CTA links — *(fixes "wrong link" in session emails)*

```bash
supabase secrets set APP_PUBLIC_URL="YOUR_URL"
```

### 5d. Turnstile allowed hostname — *(fixes CAPTCHA on signup/login)*

Cloudflare dashboard → **Turnstile** → your widget (site key
`0x4AAAAAADVgSbQFIWj8arGi`) → add your Vercel hostname (e.g.
`skillswap-connect.vercel.app`) to **Allowed hostnames**.

### 5e. JaaS / 8x8 video *(only if your JaaS app restricts origins)*

If in-app video shows an auth error, add the Vercel domain to the allowed origins
for your JaaS app in the **8x8 JaaS console**.

### 5f. Google OAuth origins *(only if you use your own Google OAuth client)*

If Google sign-in uses your own Google Cloud OAuth client (not Supabase's shared
one), add `YOUR_URL` to **Authorized JavaScript origins** in Google Cloud Console.
With Supabase-managed Google auth, Step 5a is enough.

---

## Verification checklist

After Step 5, load `YOUR_URL` and confirm:

- [ ] Landing page loads; no CSP errors in the browser console.
- [ ] Sign up / log in works (CAPTCHA passes).
- [ ] Google OAuth round-trips back to the app (if enabled).
- [ ] Dashboard **AI Suggestions** load (proves edge-function CORS is right).
- [ ] Explore / profile data loads (Supabase REST + realtime).
- [ ] A test video room opens (Jitsi).
- [ ] Response headers include `content-security-policy` and `strict-transport-security`
      (DevTools → Network → the document request).

## Ongoing deploys

Every `git push` to the connected branch triggers a new Vercel build. Pull requests
get their own **Preview** URL automatically.

## Rollback

Vercel keeps every deployment — use **Instant Rollback** in the dashboard to revert.
To go back to Cloudflare entirely, restore the `@cloudflare/vite-plugin` block in
`vite.config.ts` (see git history) and run `wrangler deploy`.

## Troubleshooting

- **Blank page / all scripts blocked:** a CSP origin is missing. Check the console
  for the blocked URL and add it to `SECURITY_HEADERS` in `vite.config.ts`, then
  redeploy.
- **Edge function calls fail with CORS:** `CORS_ALLOWED_ORIGINS` (5b) is missing or
  doesn't match the exact origin (scheme + host, no trailing slash).
- **Auth redirects to localhost or errors:** Supabase redirect URLs (5a) not set.
- **Build fails on Vercel but works locally:** confirm Node ≥ 20 (Project Settings →
  Node.js Version) and that all `VITE_` vars from Step 3 are set.
- **Client error logging:** `/api/logs/client` (the old Cloudflare log sink) is not
  wired on Vercel; the client logger fails silently by design, so nothing breaks. If
  you want server-side error logs on Vercel, add a Nitro server route for it later.
