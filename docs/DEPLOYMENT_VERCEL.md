# Deploying SkillSwap Connect to Vercel

This is the frontend deployment guide. **Supabase (database, auth, realtime, edge
functions) is unchanged** — Vercel only hosts the TanStack Start web app. Every
"real" backend call still goes to Supabase directly from the browser.

## What changed in the codebase

The app deploys to Vercel as a **static single-page app (SPA)**. Every backend
call goes straight to Supabase from the browser — there are **no server functions**
— so there is nothing to server-render. `vite build` produces a static client
bundle plus a prerendered SPA shell, and Vercel hosts those files directly. No
serverless function, no server runtime.

| Concern                | How it works now                                                             |
| ---------------------- | --------------------------------------------------------------------------- |
| Build                  | `npm run build` → static output in `dist/client`                            |
| SPA entry              | TanStack Start prerenders `dist/client/_shell.html`; `postbuild` copies it to `index.html` |
| Client routing         | `vercel.json` rewrites every route to `/index.html`                         |
| Security headers (CSP) | `vercel.json` `headers` (applied at Vercel's CDN edge)                       |
| Deploy                 | `git push` → Vercel auto-build                                              |

> **Why not Nitro/SSR?** The `nitro()` Vite plugin (v3 beta) co-orchestrates the
> Vite build and clobbers TanStack Start's own client→server build pass. The result
> is a production manifest whose client entry still points at the dev-only module
> `/@id/virtual:tanstack-start-client-entry`, which **404s in production** — so
> nothing hydrates and every page renders blank. This is broken across every
> currently-published nitro + TanStack Start beta (nitro issues #3905 / #4011 /
> #3921). Because this app needs no SSR, shipping a static SPA sidesteps the bug
> entirely and is the more reliable host anyway.

> **Note on the CSP:** `script-src` uses `'unsafe-inline'` (there is no server to
> inject a per-request nonce). All the tight origin allowlists (Supabase, Jitsi/8x8,
> hCaptcha, Google) are preserved in `vercel.json`. `server.ts` and `wrangler.jsonc`
> remain in the repo but are dormant (a leftover from the old Cloudflare target).

---

## Step 1 — Commit & push the build-config changes

Vercel builds from GitHub, so the config changes must be on the branch you deploy.

Files changed: `vite.config.ts`, `package.json`, `package-lock.json`, plus this doc.

```bash
git add vite.config.ts package.json package-lock.json docs/DEPLOYMENT_VERCEL.md
git commit -m "build: target Vercel via Nitro instead of Cloudflare Workers"
git push
```

## Step 2 — Import the repo on Vercel (or fix an existing project)

1. Go to **[vercel.com/new](https://vercel.com/new)** and sign in with GitHub.
2. **Import** the `skillswap-connect` repository.
3. **Framework Preset:** choose **Other**. This is a static SPA — do **not** pick a
   framework preset. The build settings live in `vercel.json` (which takes
   precedence over the dashboard), so you can leave the fields on their defaults:
   - Build Command: `npm run build`
   - Output Directory: `dist/client`
4. **Root Directory:** leave as the repo root.
5. Don't click Deploy yet — set env vars first (Step 3).

> **Already imported?** If the project already exists (e.g. it was set up for the
> old Nitro/SSR build), you do **not** need to re-import. Just open **Settings →
> Build and Deployment**, set **Framework Preset** to **Other** (or turn *off* any
> Build Command / Output Directory overrides so `vercel.json` wins), confirm the
> env vars in Step 3, then trigger a redeploy.

## Step 3 — Environment variables

> ⚠️ **This step is not optional.** These vars are read at **build time** and baked
> into the browser bundle. If `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`
> are missing when Vercel builds, the app loads and then throws *"Missing Supabase
> environment variables"* on startup — a **blank white page**. (You can tell they're
> missing if the deployed page's HTML contains no `supabase` string at all.)

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

- **Blank white page (most common):** two usual causes, in order —
  1. **Missing `VITE_` env vars** (Step 3): the deployed HTML contains no `supabase`
     string and the console shows *"Missing Supabase environment variables"*. Add the
     vars and redeploy.
  2. **A dev-only client entry shipped to prod:** the page's `<script>` imports
     `/@id/virtual:tanstack-start-client-entry` (which 404s). This is the Nitro-SSR
     build bug — it must **not** come back. Keep the build static (no `nitro()` plugin
     in `vite.config.ts`); `dist/client/index.html` must reference a real
     `/assets/index-*.js` entry, never an `@id/virtual` path.
- **A specific script/frame is CSP-blocked:** the console names the blocked URL. Add
  its origin to the matching directive in **`vercel.json`** (`headers` → CSP), then
  redeploy.
- **Deep link / refresh 404s (e.g. reloading `/dashboard`):** the SPA rewrite in
  `vercel.json` is missing or the Output Directory isn't `dist/client`.
- **Edge function calls fail with CORS:** `CORS_ALLOWED_ORIGINS` (5b) is missing or
  doesn't match the exact origin (scheme + host, no trailing slash).
- **Auth redirects to localhost or errors:** Supabase redirect URLs (5a) not set.
- **Build fails on Vercel but works locally:** confirm Node ≥ 20 (Project Settings →
  Node.js Version) and that all `VITE_` vars from Step 3 are set.
- **Client error logging:** `/api/logs/client` (the old Cloudflare log sink) is not
  wired on Vercel; the client logger fails silently by design, so nothing breaks. If
  you want server-side error logs on Vercel, add a Nitro server route for it later.
