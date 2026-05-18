# SkillSwap Connect

A peer-to-peer learning platform where users exchange skills as the currency ??? teach what you know to learn what you don't.

## Features

- **Skill Profiles** ??? Showcase what you can teach and what you want to learn
- **Smart Matching** ??? Discover teachers via search, filters, and AI-powered suggestions
- **Session Booking** ??? Schedule, reschedule, and manage 1-on-1 learning sessions
- **Real-Time Messaging** ??? Chat with teachers, complete with read receipts and safety filters
- **Video Calls** ??? Jitsi-powered calls baked right into the platform
- **Reviews & Ratings** ??? Two-sided review system after every session
- **Credit System** ??? Earn credits by teaching, spend them learning. No money involved.
- **Admin Panel** ??? Full moderation tools, reports, finance dashboard
- **Email Notifications** ??? Session reminders, message alerts, completion summaries

## Tech Stack

- **Frontend:** Vite + React + TypeScript + TanStack Start + shadcn/ui + Tailwind CSS
- **Backend:** Supabase (Postgres + Auth + Realtime + Storage + Edge Functions)
- **Video:** Jitsi (self-hosted)
- **AI:** n8n workflow automation for skill suggestions
- **Deployment:** Cloudflare Workers via Wrangler

## Team

| Member | Roles |
|---|---|
| **Utsab Karki** ([@UtsabKarki-01](https://github.com/UtsabKarki-01)) | Project Lead, Auth, AI Integration, Documentation |
| **Suman Joshi** ([@SumanJoshi-01](https://github.com/SumanJoshi-01)) | Frontend, Profile/Explore/Dashboard, Deployment |
| **Sulav Dyola** ([@sulavdyola01-hash](https://github.com/sulavdyola01-hash)) | Sessions, Messaging, Video, UI/UX |
| **Ankit Bhattarai** ([@ankitbhattarai-01](https://github.com/ankitbhattarai-01)) | Database, Admin Panel, Security Hardening, Testing |

## Local Development

```bash
npm install
cp .env.example .env   # Fill in your Supabase credentials
npm run dev
```

## Project Structure

```
src/
  routes/          # TanStack Router pages
  components/      # UI components (shadcn + custom)
  lib/             # Helpers, contexts, queries
  hooks/           # Custom React hooks
  integrations/    # Supabase client + types

supabase/
  migrations/      # 114+ SQL migration files
  functions/       # Edge functions (Jitsi tokens, AI suggestions, email)
  tests/           # Security boundary tests

docs/
  PROJECT_OVERVIEW.md
  EMAIL_SETUP.md
  jitsi-video.md
  compliance/      # GDPR, audit, RBAC docs
```

## Status

Built as a Final Innovation Project. ~80 commits across April???May 2026.

---

Built by 4 developers learning to build production-grade software together.
## Status (2026-05-18)

Project submitted for Final Innovation Project evaluation. All core features shipped. Two open PRs (#1, #2) tracked as known WIP items.
