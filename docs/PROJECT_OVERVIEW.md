# SkillSwap Connect — Project Overview & Tech Stack

This document summarizes the **overall picture** of the repository, the **SkillSwap** product, and the **technologies** used.

---

## 1. Workspace layout

The repository root (`Final Innovation Project`) primarily contains one application folder:

| Path | Purpose |
|------|---------|
| **`skillswap-connect/`** | Full-stack web application: **SkillSwap** — a student skill-exchange platform where peers teach and learn using **credits** instead of money. |

All substantive product code lives under **`skillswap-connect`**.

---

## 2. What the product is

**SkillSwap** is a **peer learning marketplace for students**: learners find others by skill, request sessions, message, complete sessions, and move **credits** between accounts. The product messaging emphasizes starter credits, no credit card for core flows, embedded video, and profiles tied to sessions and history.

### 2.1 Core user journeys

Routes, components, and database migrations support roughly the following flows:

1. **Discovery** — Browse/explore peers by skills and profiles (`/explore`, `/users/$userId`).
2. **Sessions** — Request → accept → schedule/reschedule → attend → review/settle (`/dashboard`, `/sessions/$sessionId`, plus server-side rules in SQL migrations).
3. **Messaging** — Session-linked chat (`/messages`, `/messages/$sessionId`).
4. **Credits & history** — Credit ledger and activity (`/credits`, `/history`).
5. **Learning tracks** — Structured progression (`/tracks`).
6. **Video** — Jitsi room per accepted session (`/video/$sessionId`; session `meet_link` in the database).
7. **Onboarding & profile** — `/onboarding`, `/profile`.
8. **Authentication** — `/login`, `/signup` with Supabase Auth; Google OAuth-related code exists in the codebase.
9. **Trust & safety** — Strikes, reports, moderation (UI such as strike banners and report flows; policies in migrations).
10. **Admin / enterprise** — Broad `/admin/*` area: users, sessions, skills, finance, cases, access, security, compliance, audit, reports, settings, broadcast, health.

### 2.2 Documentation beyond the UI

- **`docs/compliance/`** — Governance-oriented material (RBAC, retention, audit, change management, etc.).
- **`docs/jitsi-video.md`** — Jitsi integration: environment variables, session flow, production notes.

Together, these indicate the project targets not only a demo UI but also **operational and compliance** awareness.

---

## 3. Architecture (how pieces fit)

| Layer | Role |
|--------|------|
| **Browser + SSR** | **TanStack Start** on **React 19** with **TanStack Router** (file-based routes under `src/routes/`). **TanStack Query** is used in the root layout for client-side server state. |
| **Build / dev** | **Vite 7** with TanStack Start, React, Tailwind, Cloudflare build integration, path aliases, and related tooling configured directly in `vite.config.ts`. |
| **Deploy target** | **Cloudflare Workers** via **`wrangler.jsonc`** with **`main`: `./server.ts`**. |
| **HTTP edge** | **`server.ts`** wraps TanStack Start’s default handler and injects **security headers** (including a documented **Content-Security Policy** for Jitsi, Supabase, OAuth, CAPTCHA, and Gemini-related origins). |
| **Backend / data** | **Supabase**: PostgreSQL (extensive **SQL migrations**), RLS/RPC patterns, Realtime, Storage, Auth. The app uses generated **`Database`** types (`src/integrations/supabase/types.ts`). |
| **Serverless (Supabase Edge Functions, Deno)** | Includes at least: **`generate-suggestions`** (Gemini), **`mint-jitsi-token`**, **`n8n-webhook`** (optional automation). |

Business rules and schema evolution live heavily in **PostgreSQL migrations** under `supabase/migrations/` (credits, sessions, attendance, reviews, strikes, admin dashboards, feature flags, availability/timezones, learning tracks, security hardening, etc.).

---

## 4. Tech stack (detailed)

### 4.1 Core application

| Technology | Notes |
|------------|--------|
| **TypeScript** | `tsconfig.json`: `strict`-oriented settings, `ES2022`, `moduleResolution: "bundler"`, path alias `@/*` → `./src/*`. |
| **React 19** | `react`, `react-dom`. |
| **TanStack Router** | File-based routes, loaders, head/meta. |
| **TanStack Start** | Full-stack React framework integrated with Vite. |
| **TanStack Query** | Async/cache layer for data fetching in the UI. |

### 4.2 Styling and components

| Technology | Notes |
|------------|--------|
| **Tailwind CSS v4** | `@tailwindcss/vite`, app styles (e.g. `src/styles.css`). |
| **shadcn/ui pattern** | `components.json`: “new-york” style, Radix primitives, CSS variables, slate base. |
| **Radix UI** | Broad set of `@radix-ui/react-*` packages for accessible primitives. |
| **Icons** | `lucide-react`. |
| **Utilities** | `class-variance-authority`, `clsx`, `tailwind-merge`. |
| **Charts** | `recharts`. |
| **Other UI** | `sonner` (toasts), `vaul` (drawers), `cmdk`, `embla-carousel-react`, `react-day-picker`, `input-otp`, `react-resizable-panels`. |
| **Forms** | `react-hook-form`, `zod`, `@hookform/resolvers`. |

### 4.3 Backend and integrations

| Technology | Notes |
|------------|--------|
| **Supabase** | `@supabase/supabase-js`; client supports Vite `import.meta.env` and SSR `process.env` (`src/integrations/supabase/client.ts`). |
| **Jitsi** | Embedded video; default `meet.jit.si` or custom domain via `VITE_JITSI_DOMAIN`; token path via **`mint-jitsi-token`** Edge Function where applicable. |
| **Google Gemini** | **`generate-suggestions`** Edge Function; `GEMINI_API_KEY` secret; grounded on real platform data to reduce hallucinated skills. |
| **n8n** | Optional workflows; browser invokes authenticated **`n8n-webhook`** Edge Function (no client-side webhook signing). |
| **CAPTCHA / abuse** | Cloudflare Turnstile and/or hCaptcha (CSP and UI such as `CaptchaChallenge`). |
| **Google OAuth** | Account/linking flows referenced in app code and CSP (`oauth.ts`, allowed Google image/connect origins). |

### 4.4 Tooling and quality

| Technology | Notes |
|------------|--------|
| **ESLint 9** | `@eslint/js`, `typescript-eslint`, React Hooks / Refresh, Prettier integration. |
| **Prettier** | Formatting (`format` script). |
| **Package lock** | `package-lock.json` present. |
| **Bun** | `bunfig.toml` may be used for optional workflows. |

### 4.5 Deployment / platform

| Technology | Notes |
|------------|--------|
| **Cloudflare Workers** | `@cloudflare/vite-plugin`, `wrangler.jsonc`, `nodejs_compat`, custom **`server.ts`** entry. |

---

## 5. Notable engineering themes

1. **Security-first edge** — The custom Worker documents XSS/CSP tradeoffs and restricts third-party origins to what the app actually uses (video, auth, AI, CAPTCHA, Supabase).
2. **Server-side business rules** — Large migration history for credits, session lifecycle, admin RPCs, and **`SECURITY INVOKER`** / definer hardening reflects emphasis on **correctness** and **least privilege** in the database.
3. **Enterprise admin** — Migrations and routes reference phased admin capabilities (finance, compliance, privacy, settings change management, etc.).
4. **Optional intelligence** — Gemini-powered suggestions and n8n recommendations are **additive**; core matching and credits remain in Supabase/PostgreSQL.

---

## 6. How to navigate the repository

| Area | Location |
|------|----------|
| **Routes / pages** | `skillswap-connect/src/routes/*.tsx` — file-based routing; `__root.tsx` is the app shell (providers, global chrome). |
| **Shared UI** | `skillswap-connect/src/components/` — includes `ui/` for shadcn-style primitives. |
| **Domain logic** | `skillswap-connect/src/lib/` — auth, sessions, Jitsi, matching, ratings, feature flags, etc. |
| **Supabase schema & policies** | `skillswap-connect/supabase/migrations/` |
| **Edge Functions** | `skillswap-connect/supabase/functions/` |
| **Supabase CLI config** | `skillswap-connect/supabase/config.toml` |
| **Product / ops docs** | `skillswap-connect/docs/` |

---

## 7. Scripts (from `package.json`)

| Script | Command |
|--------|---------|
| `dev` | `vite dev` |
| `build` | `vite build` |
| `build:dev` | `vite build --mode development` |
| `preview` | `vite preview` |
| `lint` | `eslint .` |
| `format` | `prettier --write .` |

---

*Maintained overview of the SkillSwap Connect codebase. Update this file when major architecture or stack changes land.*
