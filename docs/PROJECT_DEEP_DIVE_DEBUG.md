# SkillSwap Connect Project Deep Dive

Generated: 2026-05-23

This document is a debugging-oriented technical map of the SkillSwap Connect project. It covers the stack, app routes, Supabase connections, database relationships, edge functions, realtime behavior, known gotchas, and practical places to look when something breaks.

## 1. Project Summary

SkillSwap Connect is a peer-to-peer learning platform where users can:

- Create learner/teacher profiles.
- Add skills they can teach or want to learn.
- Discover matching teachers and learners.
- Request, accept, reject, complete, cancel, dispute, and reschedule learning sessions.
- Use a credit escrow system for sessions.
- Chat in realtime.
- Join video calls through Jitsi or JaaS.
- Receive notifications.
- Review completed sessions.
- Use AI-powered skill and match suggestions.
- Use admin tools for moderation, finance, reports, users, skills, and sessions.

The app is a React/TanStack Start frontend backed by Supabase Auth, Postgres, Realtime, Storage, RPC functions, triggers, and Edge Functions. It is also prepared for Cloudflare Worker deployment.

## 2. Important Files

Root/runtime:

- `package.json` - scripts, dependencies, project metadata.
- `vite.config.ts` - Vite, TanStack Start, Tailwind, dev logging, dev server config.
- `server.ts` - Cloudflare Worker entry and production logging/security headers.
- `wrangler.jsonc` - Cloudflare Worker config.
- `components.json` - shadcn UI aliases and style config.
- `tsconfig.json` - TypeScript strict config and `@/*` path alias.
- `eslint.config.js` - ESLint and Prettier integration.
- `.prettierrc` - formatting rules.
- `.env.example` - expected public and server environment variables.

Frontend:

- `src/router.tsx` - TanStack Router instance.
- `src/routeTree.gen.ts` - generated route tree.
- `src/routes/__root.tsx` - root layout, app providers, global realtime bridges.
- `src/components` - shared UI and app components.
- `src/lib` - auth, logging, sessions, Jitsi, feature flags, API helpers.
- `src/integrations/supabase/client.ts` - Supabase browser client.
- `src/integrations/supabase/types.ts` - generated Supabase TypeScript types.

Supabase:

- `supabase/config.toml` - Supabase local/project config.
- `supabase/migrations` - schema, RLS, triggers, RPCs, feature flags, admin logic.
- `supabase/functions` - Edge Functions.
- `supabase/tests` - SQL security tests.
- `supabase/seeds` - local/test seed data.

Logs:

- `logs/app.log` - app/client logs.
- `logs/error.log` - errors.
- `logs/access.log` - request/access logs.

## 3. Tech Stack

Frontend:

- React 19.
- TypeScript 5.
- Vite 7.
- TanStack Router.
- TanStack Start.
- TanStack Query.
- Tailwind CSS 4.
- shadcn/Radix UI.
- lucide-react.
- sonner.
- recharts.
- react-hook-form.
- zod.
- date-fns.

Backend/platform:

- Supabase Auth.
- Supabase Postgres.
- Supabase RLS.
- Supabase Realtime.
- Supabase Storage.
- Supabase Edge Functions.
- Cloudflare Worker.
- Jitsi / JaaS video.
- Groq or Gemini for AI suggestions.
- Gmail SMTP for email fanout.
- Optional N8N webhook proxy.

Main scripts:

```bash
npm run dev
npm run build
npm run lint
npm run format
npm run preview
```

## 4. Runtime Architecture

High-level flow:

```text
Browser
  |
  | React + TanStack Router + TanStack Query
  |
  v
Supabase client
  |
  | Auth / Postgres / RPC / Realtime / Storage / Edge Functions
  |
  v
Supabase project
  |
  | optional production worker
  v
Cloudflare Worker server.ts
```

The browser talks directly to Supabase for most authenticated data access. Sensitive server-side operations live in Supabase RPCs, triggers, RLS policies, and Edge Functions.

The Cloudflare Worker entry in `server.ts` wraps TanStack Start and adds security headers, content security policy, and production-compatible client log ingestion.

## 5. Supabase Client And Auth

The Supabase client is created lazily in:

```text
src/integrations/supabase/client.ts
```

It reads:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- SSR fallbacks: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`

Auth settings:

- PKCE flow.
- Session persistence in browser localStorage.
- Auto token refresh.
- Manual auth-code handling with `detectSessionInUrl: false`.

Important auth files:

- `src/lib/auth-context.tsx` - global user/session state.
- `src/lib/auth-redirect.ts` - OAuth/PKCE code exchange.
- `src/lib/oauth.ts` - Google/GitHub OAuth helpers.
- `src/lib/redirect.ts` - redirect sanitization and post-auth route resolution.
- `src/integrations/supabase/auth-middleware.ts` - server function auth middleware.

Auth flow:

```text
User logs in/signs up
  |
  v
Supabase Auth creates or restores session
  |
  v
App loads profile
  |
  v
resolvePostAuthRoute decides destination
  |
  +-- no profile/onboarding incomplete -> /onboarding
  +-- onboarded -> /dashboard or sanitized redirect
```

## 6. App Providers And Global Realtime

`src/routes/__root.tsx` wraps the app with:

- `ThemeProvider`
- `QueryClientProvider`
- `AuthProvider`
- `AuthGateProvider`
- global error boundary
- `Toaster`
- `SiteHeader` for non-standalone routes

Global realtime components:

- `CreditBalanceRealtimeBridge`
- `IncomingRequestBanner`
- `MessageHeadsUp`
- `IncomingCallToast`
- `SessionEventHeadsUp`

Standalone routes do not use the main shell/sidebar layout. These include:

- `/`
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`
- `/auth/callback`
- `/onboarding`
- `/skills`

## 7. Route Map

### Public/Auth Routes

| Route              | Purpose                              | Main connections                                          |
| ------------------ | ------------------------------------ | --------------------------------------------------------- |
| `/`                | Landing page                         | `profiles`, `user_teaching_skills`, public stats          |
| `/login`           | Email/password login, OAuth, CAPTCHA | Supabase Auth, `safeRedirectPath`, `resolvePostAuthRoute` |
| `/signup`          | Signup and OAuth                     | Supabase Auth, CAPTCHA, profile trigger                   |
| `/auth/callback`   | OAuth PKCE exchange                  | Supabase Auth, `exchangeAuthCodeFromUrl`                  |
| `/forgot-password` | Send password reset email            | Supabase Auth                                             |
| `/reset-password`  | Update password                      | Supabase Auth                                             |
| `/skills`          | Public skill catalog                 | `skills`, `user_teaching_skills`                          |

### User App Routes

| Route                  | Purpose                         | Main connections                                                     |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `/onboarding`          | Initial profile and skill setup | `profiles`, `skills`, `user_teaching_skills`, `user_learning_skills` |
| `/dashboard`           | Main user dashboard             | profile, credits, sessions, matches, reviews, AI suggestions         |
| `/explore`             | Discover teachers/learners      | skills, profiles, ratings, availability, sessions                    |
| `/users/$userId`       | Public profile detail           | profile, skills, reviews, session request                            |
| `/profile`             | Edit own profile                | profile, avatar storage, skills, password, delete account RPC        |
| `/history`             | Session history                 | sessions, profiles, credits, realtime                                |
| `/sessions/$sessionId` | Session detail/actions          | session RPCs, reports, reschedules                                   |
| `/messages`            | Inbox/chat                      | sessions, messages, profiles, realtime                               |
| `/messages/$sessionId` | Legacy redirect                 | redirects to `/messages?s=<sessionId>`                               |
| `/video/$sessionId`    | Video room                      | sessions, Jitsi/JaaS, attendance RPCs                                |
| `/notifications`       | Full notification list          | `notifications`                                                      |
| `/credits`             | Credit balance and ledger       | `my_credit_balance`, `credit_transactions`                           |
| `/tracks`              | Learning tracks                 | track RPCs                                                           |

### Admin Routes

| Route             | Purpose                  | Main connections                  |
| ----------------- | ------------------------ | --------------------------------- |
| `/admin`          | Admin guard              | `get_my_admin_permissions`        |
| `/admin/`         | Admin console home       | admin snapshot RPCs               |
| `/admin/users`    | User moderation          | suspend/reinstate/reveal PII RPCs |
| `/admin/skills`   | Skill catalog management | create/delete skill RPCs          |
| `/admin/sessions` | Session monitoring       | admin sessions dashboard RPC      |
| `/admin/reports`  | Moderation reports       | report queue and status RPCs      |
| `/admin/finance`  | Finance operations       | maker-checker finance RPCs        |

## 8. Database Model

Important public tables:

- `profiles`
- `skills`
- `user_teaching_skills`
- `user_learning_skills`
- `sessions`
- `messages`
- `credit_transactions`
- `notifications`
- `reports`
- `reviews`
- `ai_suggestions`
- `learning_tracks`
- `track_planned_sessions`
- `reschedule_proposals`
- `user_availability`
- `session_attendance`
- `session_settlement`
- `user_strikes`

Admin/privacy/finance tables also exist in migrations, including admin audit, admin roles/permissions, privacy export/erasure, finance action, and report action tables.

Main relationships:

```text
auth.users
  |
  v
profiles
  |
  +-- user_teaching_skills -- skills
  |
  +-- user_learning_skills -- skills
  |
  +-- sessions as learner
  |
  +-- sessions as teacher
  |
  +-- messages
  |
  +-- notifications
  |
  +-- credit_transactions as from_user/to_user
  |
  +-- reviews as reviewer/reviewee
  |
  +-- reports as reporter/reported_user
```

Session-related relationships:

```text
sessions
  |
  +-- messages
  +-- reviews
  +-- reports
  +-- session_attendance
  +-- session_settlement
  +-- reschedule_proposals
  +-- credit_transactions
```

Track relationships:

```text
learning_tracks
  |
  +-- track_planned_sessions
  +-- sessions materialized from planned sessions
```

Important enums:

- `skill_level`: `basic`, `intermediate`, `advanced`
- `learning_mode`: `teaching`, `collaboration`, `mentorship`, `coaching`, `peer_review`, `project_based`, `study_group`, `hands_on`
- `session_status`: `pending`, `accepted`, `rejected`, `active`, `completed`, `cancelled`, `pending_review`, `disputed`

## 9. Important RPCs

Session lifecycle:

- `accept_session`
- `reject_session`
- `cancel_session`
- `complete_session`
- `dispute_session`
- `record_session_join`
- `record_session_leave`
- `session_attended_seconds`
- `auto_settle_session`
- `move_due_sessions_to_review`
- `settle_pending_review_sessions`

Credits:

- `my_credit_balance`

Availability:

- `set_my_availability`
- `get_my_availability`
- `compute_intersection_slots`
- `get_teacher_windows`
- `teachers_intersection_status`
- `teachers_free_time_status`
- `has_any_intersection`

Tracks:

- `propose_track`
- `accept_track`
- `reject_track`
- `end_track`
- `materialize_due_planned_sessions`
- `get_my_tracks`

Admin:

- `get_my_admin_permissions`
- `admin_has_permission`
- `is_admin`
- `admin_suspend_user`
- `admin_reinstate_user`
- `admin_issue_strike`
- `admin_revoke_strike`
- `admin_update_report_status`
- `get_admin_sessions_dashboard`
- `request_finance_action`
- `approve_finance_action`
- `reject_finance_action`
- `run_finance_reconciliation`
- `create_finance_report_manifest`

## 10. Session And Credit Flow

Request flow:

```text
Learner requests session
  |
  v
sessions row created with pending status
  |
  v
Teacher accepts
  |
  v
accept_session validates participants, schedule, status, suspension, and credits
  |
  v
Learner credits move into escrow
  |
  v
Session becomes accepted
```

Completion flow:

```text
Session accepted/active
  |
  v
Session ends or user completes
  |
  v
pending_review or completed
  |
  v
Escrow released to teacher or refunded depending on outcome
```

Important credit behavior:

- Server-side DB logic enforces session credit cost.
- The client should not be trusted for credit cost.
- Accepted sessions hold learner credits in escrow.
- Cancelled sessions refund escrow when allowed.
- Completed sessions release escrow to the teacher.
- Disputed sessions freeze settlement until resolved.

## 11. Messaging Flow

`/messages` groups threads by the other participant across accepted/active sessions.

Main data:

- `sessions`
- `messages`
- `profiles`

Realtime behavior:

- Subscribes to message inserts/updates/deletes.
- Optimistically inserts outgoing messages.
- Supports local hidden/read state.
- Chat is generally available only when there is an accepted or active session.

Legacy notification links may still use `/messages/$sessionId`; that route redirects to `/messages?s=<sessionId>`.

## 12. Video Flow

Video route:

```text
/video/$sessionId
```

Main files:

- `src/routes/video.$sessionId.tsx`
- `src/lib/jitsi.ts`
- `src/lib/jitsi-token.ts`
- `src/lib/call-signals.ts`
- `supabase/functions/mint-jitsi-token`

Flow:

```text
User opens video route
  |
  v
App checks auth, participant access, session status, and join window
  |
  v
If JaaS is enabled, app calls mint-jitsi-token
  |
  v
Edge Function verifies session access and records join
  |
  v
Jitsi room loads
  |
  v
On leave/cleanup, app calls record_session_leave
```

Jitsi modes:

- Default public Jitsi can use `meet.jit.si`.
- JaaS mode uses `8x8.vc` and requires JWT minting.

Debug gotcha:

- Frontend join window and `mint-jitsi-token` server window may not match exactly. Align them if users can see a join button but cannot mint a token, or if the server allows joining earlier than the UI.

## 13. AI Suggestions

Edge Function:

```text
supabase/functions/generate-suggestions
```

Purpose:

- Generate personalized learning/teaching suggestions.
- Ground suggestions in real user profile, skill, session, rating, and trending-skill data.
- Cache suggestions to reduce model calls.

Provider behavior:

- Prefer Groq if `GROQ_API_KEY` is configured.
- Fall back to Gemini if `GEMINI_API_KEY` is configured.

Common debug issues:

- Missing API key.
- Rate limit.
- Cached suggestions masking recent data changes.
- User has too little profile/skill data.

## 14. Edge Functions

| Function               | Purpose                   | Important secrets/env                                                                           |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `generate-suggestions` | AI suggestions            | `GROQ_API_KEY`, `GEMINI_API_KEY`, Supabase service role                                         |
| `mint-jitsi-token`     | JaaS JWT minting          | `JAAS_APP_ID`, `JAAS_KEY_ID`, `JAAS_PRIVATE_KEY`                                                |
| `n8n-webhook`          | Authenticated N8N proxy   | `N8N_*`, `N8N_WEBHOOK_SECRET`                                                                   |
| `send-session-email`   | Notification email fanout | `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_FROM_NAME`, `EMAIL_WEBHOOK_SECRET`, `APP_PUBLIC_URL` |

CORS helper:

```text
supabase/functions/_shared/cors.ts
```

It allows localhost origins by default and can use `CORS_ALLOWED_ORIGINS` for deployed origins.

## 15. Feature Flags And Settings

Feature flag client:

```text
src/lib/feature-flags.ts
```

Important flags/settings:

- `features.ai_suggestions.enabled`
- `features.video_calls.enabled`
- `features.public_explore.enabled`
- `signup.starting_credits`
- `sessions.default_credits_per_hour`

The feature flag helper fails soft and returns defaults when admin settings cannot be loaded.

## 16. Realtime And Cache

Realtime areas:

- Credit balance changes.
- Incoming session requests.
- Session lifecycle events.
- Messages.
- Notifications.
- Video call ringing/decline broadcasts.

Common local cache keys:

- `skillswap-dashboard-cache-<userId>`
- `skillswap-explore-cache`
- `skillswap-header-profile-<userId>`
- notification/message read-state keys

When debugging stale UI, clear browser storage keys starting with:

```text
skillswap-
skillswap.
```

TanStack Query defaults:

- `staleTime`: about 30 seconds.
- `gcTime`: about 5 minutes.
- retry: 1.
- no refetch on window focus.

## 17. Logging

Dev logging is configured in `vite.config.ts`.

Production/worker logging is configured in `server.ts`.

Log files:

- `logs/app.log`
- `logs/error.log`
- `logs/access.log`

The logging endpoint sanitizes sensitive keys such as:

- authorization
- cookie
- token
- secret
- password
- API key
- session

Client log payloads are capped to avoid very large writes.

## 18. Environment Variables

Public/browser:

- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_HCAPTCHA_SITE_KEY`
- `VITE_JITSI_DOMAIN`
- `VITE_JAAS_APP_ID`

Server/edge:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PUBLISHABLE_KEY`
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `JAAS_APP_ID`
- `JAAS_KEY_ID`
- `JAAS_PRIVATE_KEY`
- `N8N_RECOMMENDATION_WEBHOOK_URL`
- `N8N_CREDIT_TRANSFER_WEBHOOK_URL`
- `N8N_WEBHOOK_SECRET`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `GMAIL_FROM_NAME`
- `EMAIL_WEBHOOK_SECRET`
- `APP_PUBLIC_URL`
- `CORS_ALLOWED_ORIGINS`

Do not expose service-role or private keys to the browser.

## 19. Current Health Findings

Build status:

```text
npm run build -> succeeds
```

Build warnings:

- Some generated chunks are larger than 500 KB.
- Admin chart bundle and router/server bundles are large.

Lint status:

```text
npm run lint -> fails
```

Main lint causes:

- Prettier formatting issues.
- Line-ending mismatch.
- Some React hook dependency warnings.
- Some unused variable warnings.
- Some shadcn/react-refresh warnings.

Current dirty worktree files observed:

```text
src/lib/redirect.ts
src/routes/__root.tsx
src/routes/auth.callback.tsx
src/routes/dashboard.tsx
src/routes/login.tsx
src/routes/signup.tsx
supabase/seeds/test_python_advanced_collab.sql
```

## 20. Known Gotchas

### `src/lib/redirect.ts` appears binary to git

This file contains literal control characters in a regex. Git treats the file as binary, making diffs difficult to inspect.

Suggested fix later:

```ts
/[\u0000-\u001F\u007F]/;
```

instead of literal control characters.

### Credits-per-hour may have a config mismatch

Some DB defaults/history point to 4 credits per hour, while seeded admin setting uses `sessions.default_credits_per_hour = 5`.

If session cost looks wrong, check:

- teacher row `credits_per_hour`
- admin setting `sessions.default_credits_per_hour`
- DB trigger that recalculates session credits
- frontend fallback values

### Video join windows may differ

Frontend session helper and `mint-jitsi-token` may use different "join before start" windows.

If video access behaves inconsistently, compare:

- `src/lib/sessions.ts`
- `supabase/functions/mint-jitsi-token`

### Email docs may be stale

Some docs mention Resend, but the current email function uses Gmail SMTP through `send-session-email`.

### Generated Supabase types may lag migrations

`src/integrations/supabase/types.ts` does not include every table added by later migrations. Admin/privacy/finance tables are mostly accessed through RPCs.

Regenerate types if direct table access is added.

### Scheduled DB jobs need service-role execution

Functions such as these are not intended for normal browser users:

- `move_due_sessions_to_review`
- `settle_pending_review_sessions`
- `materialize_due_planned_sessions`
- `notify_upcoming_sessions`

They need pg_cron, Supabase scheduled functions, or another trusted worker.

## 21. Debugging Playbooks

### Auth/login/signup issue

Check:

1. Browser console and `logs/error.log`.
2. `src/routes/login.tsx` or `src/routes/signup.tsx`.
3. `src/lib/auth-context.tsx`.
4. `src/lib/auth-redirect.ts`.
5. Supabase Auth provider settings.
6. Email confirmation status.
7. CAPTCHA environment variables.
8. `profiles` row existence for the auth user.

### User lands on wrong page after login

Check:

1. `src/lib/redirect.ts`.
2. `resolvePostAuthRoute`.
3. `profiles.onboarding_completed`.
4. `/auth/callback` search params.
5. Whether redirect path was sanitized.

### Dashboard data stale or wrong

Check:

1. `src/routes/dashboard.tsx`.
2. sessionStorage key `skillswap-dashboard-cache-<userId>`.
3. TanStack Query cache.
4. `profiles`, `sessions`, skill rows, `credit_transactions`.
5. Realtime subscriptions.
6. Feature flag for AI suggestions if relevant.

### Explore/matching issue

Check:

1. `src/routes/explore.tsx`.
2. URL filters: query, category, level, sort, availability, mode, match.
3. `user_teaching_skills`.
4. `user_learning_skills`.
5. `profiles`.
6. `reviews`.
7. availability RPCs.
8. session request dialog.

### Session accept/reject/complete issue

Check:

1. `src/lib/sessions.ts`.
2. `src/routes/sessions.$sessionId.tsx`.
3. `accept_session`, `reject_session`, `cancel_session`, `complete_session`.
4. `sessions` row status.
5. credit balance through `my_credit_balance`.
6. `credit_transactions`.
7. suspension/strike state.
8. RLS policies and trigger errors.

### Credit balance issue

Check:

1. `my_credit_balance`.
2. `credit_transactions`.
3. session escrow status.
4. `CreditBalanceRealtimeBridge`.
5. `/credits` page query.
6. whether a cancelled/disputed/pending-review session still holds escrow.

### Messaging issue

Check:

1. `src/routes/messages.tsx`.
2. session status must usually be accepted or active.
3. `messages` table RLS.
4. realtime channel subscriptions.
5. hidden/read local state.
6. whether the user is actually a participant in the session.

### Video issue

Check:

1. `src/routes/video.$sessionId.tsx`.
2. `src/lib/jitsi.ts`.
3. `src/lib/jitsi-token.ts`.
4. `supabase/functions/mint-jitsi-token`.
5. session status and participant IDs.
6. join window.
7. JaaS env variables.
8. CSP allowlist in `server.ts`.

### AI suggestions issue

Check:

1. `src/lib/ai-suggestions.ts`.
2. `supabase/functions/generate-suggestions`.
3. `features.ai_suggestions.enabled`.
4. Groq/Gemini env variables.
5. cache age.
6. profile and skill completeness.
7. Edge Function logs.

### Admin permission issue

Check:

1. `/admin` route guard.
2. `get_my_admin_permissions`.
3. admin roles/permissions tables.
4. RLS policies.
5. whether the user profile exists.
6. audit/security-definer migration behavior.

## 22. Useful Commands

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Format:

```bash
npm run format
```

Start dev server:

```bash
npm run dev
```

Supabase local start:

```bash
npx supabase start
```

Supabase local status:

```bash
npx supabase status
```

Supabase DB lint:

```bash
npx supabase db lint --local
```

Run admin security SQL test manually:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin_security_boundaries.sql
```

## 23. Fast Mental Model

Use this when debugging:

```text
UI page
  |
  v
React component state + TanStack Query
  |
  v
Supabase client call
  |
  +-- table select/insert/update/delete
  +-- RPC
  +-- Edge Function
  +-- Storage
  +-- Realtime
  |
  v
RLS policies, triggers, and DB functions
  |
  v
Logs, browser console, and database rows reveal the actual failure
```

Most serious behavior is enforced in the database, not only in the frontend. When the UI says one thing and the DB does another, trust the DB/RPC/trigger layer first.
