# Local Suggestions Engine — Implementation Plan (v1, final)

**Goal:** Remove the LLM (Groq/Gemini) from the dashboard "AI Suggestions" feature entirely and
replace it with a fully deterministic, rules-based recommendation engine. No API keys, no rate
limits, no hallucinations, no invented framing ("you're in a slump", "drums → SEO"). Every tile is
computed from real DB data with fixed templates, and every click lands exactly where the tile
promised.

**Non-goals:** No UI redesign of the card (same 4-tile layout, same icons, same refresh button).
No new database tables. No changes to other features (session notes AI, verification quiz, etc.
keep their own APIs).

---

## 1. Hard requirements (from product owner)

1. **Exactly 4 tiles, always.** Never 3, never 5. A guaranteed fallback ladder makes 4 possible
   for every user state, including a brand-new empty account on an empty platform.
2. **Zero repetition.** No two tiles from the same "family" (e.g. the current bug: "you taught 5
   sessions" + "you completed 5 sessions" — both momentum). No two tiles about the same skill or
   the same person.
3. **Stage-wise profile completeness.** The 4 checklist items are: **bio**, **teaching skills**,
   **learning skills**, **availability**. Tile composition is staged by how many are missing
   (see §4).
4. **Real numbers only.** Day counts, learner counts, session counts, streaks, credits, ratings —
   all computed server-side from the DB at generation time. A user with zero sessions must NEVER
   see "it's been N days since your last session."
5. **Skill relatedness is domain-constrained.** HTML → CSS yes; Drums → SEO impossible, because
   relatedness comes only from a curated skill graph + same-category catalog co-occurrence, never
   from free association.
6. **Durable.** The engine must gracefully handle skills users add to the catalog that we've never
   heard of (the catalog is user-extendable — see migration `20260509090000_harden_skill_creation.sql`:
   any authenticated user can INSERT into `public.skills`). Unknown skills degrade to
   category-based suggestions, never crash or produce nonsense.

---

## 2. Architecture decision

**Keep the Edge Function, delete the LLM.** The engine stays in
`supabase/functions/generate-suggestions/index.ts` because:

- The frontend contract (`src/lib/ai-suggestions.ts` → `fetchAiSuggestions()` → response
  `{ suggestions, cached, generatedAt }`) stays identical → near-zero frontend changes.
- The reads run under the user's JWT (RLS-bound), same as today — no new security surface.
- The existing cache table (`ai_suggestions`), the 60-second regen floor, the concurrent-claim
  logic, and `invalidateAiSuggestionsCache()` all keep working unchanged.

**What dies** (all inside `generate-suggestions/index.ts`):

| Delete | Why |
|---|---|
| `buildPrompt` (~lines 847–1073) | No LLM |
| Groq + Gemini callers (~lines 1090–1180) and all key handling | No LLM, no rate limits |
| `LlmSuggestion` type + `ref:` indirection + ref-resolution | Engine emits real `action` objects directly |
| `validateSuggestion` + `buildAllowedNumbers` (~lines 1515–1657) | Nothing can hallucinate; validator is dead weight |
| `SKILL_LEXICON` (~lines 88–196) | Replaced by the skill graph (§7) |
| `tidyMessage` / em-dash cleanup (server + the client copies in `src/lib/ai-suggestions.ts`) | Templates are already clean |

**What stays:** the HTTP handler shell, CORS, cache read/write + claiming, the 60s regen floor,
`force` param, `gatherSignals` (extended, §3), `loadTeacherCards`, the `Suggestion` /
`SuggestionAction` types, the feature flag gate (`features.ai_suggestions.enabled`).

**New file:** `supabase/functions/generate-suggestions/skill-graph.ts` — pure data + lookup
functions (normalization, aliases, domains, progression edges). Deno supports sibling-file imports
inside a function folder.

Rough size: index.ts shrinks from ~2000 lines to ~700; skill-graph.ts ~250 lines of data.

---

## 3. Signals (extend `gatherSignals`)

Existing signals to KEEP as-is: profile (`full_name`, `bio`), credits (via `my_credit_balance`
RPC), teaching/learning skills (+ skill_ids), full catalog, `availableTeachers` (cheapest-3 per
wanted skill, with ratings), `seekerCounts` (real learner counts per taught skill),
`reciprocalMatches` (direct-swap pairs), `trendingSkills` (view, already filtered to
teacher-available), `relatedSkills` (catalog co-occurrence — keep as the fallback tier of the
skill graph).

**NEW signals to add:**

| Signal | Source | Computation |
|---|---|---|
| `hasAvailability` | `user_availability` | `count(*) where user_id = me` > 0 (any mode) |
| `hasTeachAvailability` | `user_availability` | rows with `mode='teach'` > 0 |
| `verifiedSkillIds` | `skill_verifications` | `select skill_id where user_id = me` (RLS: public-readable) |
| `hasAnyCompletedSession` | `sessions` | at least 1 completed session ever, as teacher OR learner. **Gate for all "days since" copy.** |
| `taughtCount30d` / `learnedCount30d` | `sessions` | completed in last 30 days, split by role (fixes the "taught 5 / completed 5" double-count) |
| `daysSinceLastSession` | `sessions` | from most recent completed session (either role); `null` if none ever |
| `streakDays` | `sessions` | consecutive **local calendar days** ending today or yesterday with ≥1 completed session (either role). Same walk-back algorithm as `loadStreak` in `dashboard.tsx` (lines ~366–401), but server-side |
| `tzOffsetMinutes` | request body | client sends `new Date().getTimezoneOffset()`; ALL day-boundary math (streak, daysSince) uses it. This is the fix for wrong day counts — today the server does UTC math while the dashboard streak card does local math, and they disagree |

Frontend change for this: `src/lib/ai-suggestions.ts` adds `tzOffsetMinutes` to the invoke body.
One line.

---

## 4. Profile-completeness staging (the core matrix)

Checklist items, each a boolean from signals:

- **T** = has ≥1 teaching skill
- **L** = has ≥1 learning skill
- **A** = has ≥1 availability window
- **B** = has non-empty bio (trimmed length ≥ 1)

`missing = 4 - (T + L + A + B)`. Completion tiles are emitted **only for the missing items**, in
fixed priority order: **teach skills → learn skills → availability → bio** (skills unlock
matching, availability unlocks booking, bio is polish).

| Stage | Missing | Tile composition (always exactly 4) |
|---|---|---|
| S4 — brand new | 4 | 4 completion tiles: add teach skills, add learn skills, set availability, add bio |
| S3 | 3 | 3 completion tiles + 1 growth tile |
| S2 | 2 | 2 completion tiles + 2 growth tiles |
| S1 | 1 | 1 completion tile + 3 growth tiles |
| S0 — complete | 0 | 4 growth tiles |

Growth tiles are chosen by the priority engine (§6) from the categories in §5. If fewer growth
tiles qualify than needed (tiny platform, new user), the **fallback ladder** (§6.4) fills to 4.

**Completion tile copy** (2 variants each; seeded pick, §6.5; no leading digits, no em-dashes):

- Teach skills: "Add a skill you can teach so others can book you." / "List a teaching skill to
  start earning credits."
- Learn skills: "Add a skill you want to learn to get matched with teachers." / "Tell us what you
  want to learn and we will find teachers for you."
- Availability: "Set your weekly availability so sessions can be booked." / "Add your free hours
  so booking takes seconds."
- Bio: "Add a short bio so people know who they are learning with." / "A two line bio makes your
  profile far more trustworthy."

Actions: teach/learn skills → `{ kind: "skills" }`; availability + bio → `{ kind: "profile" }`.

---

## 5. Growth category catalog

Each category: **id · trigger (all real data) · action · dedup family · copy templates**.
Copy rules for ALL templates: no leading digit, no em-dashes, correct pluralization
(`1 learner` / `2 learners`), first names only (`full_name.split(" ")[0]`), ratings as `4.5★`
only when reviews exist.

### Family: MOMENTUM (max 1 tile per generation — this kills the screenshot duplicate)

| id | Trigger | Copy (variants) | Action |
|---|---|---|---|
| `streak` | `streakDays >= 2` | "You are on a N day streak. One session today keeps it going." / "N days in a row of learning. Keep the run alive." | `{kind:"explore", mode:"teachers"}` |
| `taught_momentum` | no streak, `taughtCount30d >= 3` | "You taught N sessions this month. Your learners are showing up, keep going." | `{kind:"explore", mode:"learners"}` |
| `learned_momentum` | no streak, `learnedCount30d >= 3` | "You completed N sessions this month. Solid pace, keep it up." | `{kind:"explore", mode:"teachers"}` |
| `reengage` | `hasAnyCompletedSession === true` AND `daysSinceLastSession >= 5` | "It has been N days since your last session. Book a short one to get back in rhythm." | `{kind:"explore", mode:"teachers"}` |
| `first_session` | `hasAnyCompletedSession === false` AND L AND ≥1 available teacher | "Your first session is one click away. NAME teaches SKILL and has open slots." | `{kind:"user", userId, skillName}` |

Selection within the family: `streak` > `reengage` > `first_session` > `taught_momentum` >
`learned_momentum`. **`reengage` is structurally impossible for users with no session history** —
that's the "15 days for a new user" bug, fixed by the `hasAnyCompletedSession` gate, not by
trusting copy.

### Family: MATCH (max 2 tiles, but must be about different people AND different skills)

| id | Trigger | Copy | Action |
|---|---|---|---|
| `swap` | ≥1 reciprocal match | "NAME teaches THEIR_SKILL and wants YOUR_SKILL. Direct swap, no credits." | `{kind:"user", userId, skillName, swapMySkillName}` (opens swap dialog) |
| `teacher` | ≥1 available teacher for a wanted skill | "NAME teaches SKILL at N credits/hour, rated R★. Book a session." (rating clause dropped when no reviews) | `{kind:"user", userId, skillName}` |

`swap` always outranks `teacher` (a swap is strictly better value). If both fire they must
reference different users and different skills.

### Family: DEMAND (max 1)

| id | Trigger | Copy | Action |
|---|---|---|---|
| `seekers` | ≥1 learner wants a skill I teach | "N learners want SKILL right now. Head to Explore to offer a session." | `{kind:"explore", q: skill, mode:"learners"}` |
| `earn_credits` | credits < cheapest relevant teacher rate AND T AND ≥1 seeker | "Low on credits? N learners want SKILL. Teach a session to top up." | `{kind:"explore", q: skill, mode:"learners"}` |

`earn_credits` outranks `seekers` when it fires (more actionable). Both reference the
highest-count skill.

### Family: GROWTH-PATH (max 1)

| id | Trigger | Copy | Action |
|---|---|---|---|
| `progression` | skill graph (§7) yields a next-skill with ≥1 available teacher | "Into FROM? SUGGEST is the natural next step, and NAME teaches it." / "You know FROM. SUGGEST pairs perfectly with it. NAME can get you started." | `{kind:"user", userId, skillName: suggest}` — or `{kind:"explore", q: suggest, mode:"teachers"}` if multiple teachers |
| `trending` | trending view returns a skill (already teacher-filtered) not already on my lists | "SKILL is taking off on SkillSwap this week. Worth a look." | `{kind:"explore", q: skill, mode:"teachers"}` |

`progression` outranks `trending` (personal beats generic). **Dead-end guard stays:** a
progression suggestion is only emitted if the suggested skill has ≥1 bookable teacher — no tile
may deep-link to an empty result.

### Family: TRUST (max 1)

| id | Trigger | Copy | Action |
|---|---|---|---|
| `verify` | T AND ≥1 teaching skill NOT in `verifiedSkillIds` | "Get verified in SKILL to earn the trusted tick. Verified teachers get booked more." | `{kind:"profile"}` |
| `teach_availability` | T AND `hasTeachAvailability === false` AND A overall true | "You listed SKILL but have no teaching hours set. Add teach slots so learners can book you." | `{kind:"profile"}` |

### Fallback family: GENERIC (never fails, §6.4)

| id | Always-valid because | Copy | Action |
|---|---|---|---|
| `credits_info` | credits is always a real number | "You have N credits ready to spend. A session costs about 4 per hour." | `{kind:"explore", mode:"teachers"}` |
| `browse_learn` | static | "Browse the skill catalog, you might find your next favorite thing to learn." | `{kind:"explore", mode:"teachers"}` |
| `browse_teach` | static | "Scan the skill list, you probably know something someone wants to learn." | `{kind:"explore", mode:"learners"}` |
| `keep_fresh` | static | "Keep your availability up to date so booking always works first try." | `{kind:"profile"}` |

---

## 6. Selection engine (the algorithm)

### 6.1 User archetype (adjusts growth priority order)

Computed from signals, checked top-down, first match wins:

| Archetype | Condition | Growth priority order |
|---|---|---|
| DORMANT | `hasAnyCompletedSession` AND `daysSinceLastSession >= 5` | reengage → swap → teacher → seekers → progression → verify → trending |
| NEWCOMER | `hasAnyCompletedSession === false` | first_session → swap → teacher → seekers → trending → verify → progression |
| STREAKER | `streakDays >= 2` | streak → progression → swap → teacher → seekers → verify → trending |
| TEACHER-LEANING | `taughtCount30d > learnedCount30d` | seekers/earn_credits → verify → swap → taught_momentum → teach_availability → trending |
| LEARNER-LEANING | `learnedCount30d >= taughtCount30d` | teacher → swap → progression → learned_momentum → seekers → trending |

### 6.2 Pipeline (pseudocode)

```
signals   = gatherSignals(supabase, userId, tzOffsetMinutes)
seed      = fnv1aHash(userId + ":" + localDateString(tzOffsetMinutes))   // stable per user per day
missing   = completionChecklist(signals)                                  // ordered list
stage     = missing.length                                                // 0..4

tiles = []
tiles += completionTiles(missing).slice(0, min(stage, 4))                 // §4

candidates = allGrowthCandidates(signals)          // every category §5 evaluates its trigger
candidates = orderBy(archetypePriority(signals))   // §6.1
for c in candidates:
    if tiles.length == 4: break
    if familyCount(tiles, c.family) >= familyCap(c.family): continue      // MOMENTUM 1, MATCH 2, DEMAND 1, PATH 1, TRUST 1
    if mentionsSameSkill(tiles, c) or mentionsSameUser(tiles, c): continue
    tiles.push(render(c, seed))                    // seeded copy-variant pick §6.5

for g in [credits_info, browse_learn, browse_teach, keep_fresh]:          // §6.4 ladder
    if tiles.length == 4: break
    if not duplicatesExisting(tiles, g): tiles.push(render(g, seed))

assert tiles.length == 4                            // structurally guaranteed
```

### 6.3 Dedup rules (formal)

1. Max one tile per **category id**.
2. Family caps: MOMENTUM 1 · MATCH 2 · DEMAND 1 · GROWTH-PATH 1 · TRUST 1 · GENERIC unlimited
   (only reachable via ladder).
3. No two tiles may name the **same skill** (compare normalized skill names, §7.1).
4. No two tiles may name the **same person** (compare userId).
5. Completion tiles are exempt from 3–4 (they name no skill/person).

### 6.4 The exactly-4 guarantee (proof sketch)

- Stage S4: 4 completion tiles exist by definition → 4. ✔
- Stages S3–S0: completion tiles + growth candidates + the GENERIC ladder. The ladder's four
  entries depend only on `credits` (always readable via RPC) and static copy, and are distinct
  from every other category id → the ladder alone can always top up to 4. ✔

### 6.5 Deterministic variety (feels alive without an LLM)

- `seed = hash(userId + localDate)` → copy-variant index = `seed % variants.length` per category,
  and breaks ties between equal-priority candidates.
- Result: tiles rotate **daily** and whenever underlying data changes, but are stable within a
  day — no flicker between refreshes, no randomness to debug.
- The ⟳ force-refresh button now means "recompute from fresh data" (it already bypasses cache).
  Document this in the card tooltip if desired. Behavior change from today: refresh no longer
  re-rolls phrasing for the same data. That's correct — same data, same truth.

---

## 7. Skill graph (`skill-graph.ts`)

### 7.1 Normalization + aliases

`normalize(name)`: lowercase → trim → strip punctuation (`.`, `-`, `/`, `_` → space) → collapse
whitespace. Then alias lookup:

```
js, java script            → javascript        ts                  → typescript
reactjs, react js, react.js→ react             nodejs, node        → node.js
py                         → python            postgres, postgresql, mysql → sql
ml                         → machine learning  ui ux, uiux, ux, ui design  → ui/ux design
html5                      → html              css3                → css
excel, ms excel, spreadsheets → excel          dsa, data structures → data structures
ai                         → machine learning  photoshop           → photo editing
```

(Alias table is data, easy to extend; unknown names simply pass through normalization.)

### 7.2 Current seeded catalog (16 skills, from migration `20260427042346`)

JavaScript, Python, React, TypeScript, CSS, HTML, UI/UX Design, Figma, Node.js, SQL,
Machine Learning, Public Speaking, Data Analysis, Photography, Spanish, French.
**Live DB has more** (users add via combobox — e.g. Music Theory, Guitar exist from demos). The
graph below covers the seeded 16 + every *obvious* user-added skill; anything else falls to tier
2/3 (§7.4).

### 7.3 Curated progression edges (ordered best-first)

**Web/Frontend:** html → css, javascript · css → javascript, ui/ux design, tailwind css ·
javascript → typescript, react, node.js · typescript → react, node.js · react → typescript,
next.js, node.js · node.js → sql, express, typescript

**Programming/Data:** python → data analysis, sql, machine learning, django ·
sql → data analysis, python, node.js · data analysis → machine learning, python, excel, statistics ·
machine learning → data analysis, python, deep learning · java → data structures, spring ·
c++ → data structures · data structures → python, java · excel → data analysis, sql ·
statistics → data analysis, machine learning

**Design/Creative:** ui/ux design → figma, html, graphic design · figma → ui/ux design, prototyping ·
graphic design → figma, drawing, photo editing · photography → photo editing, videography, graphic design ·
photo editing → photography, graphic design · video editing → videography, photography, motion graphics ·
drawing → graphic design, digital art · digital art → drawing, graphic design

**Music:** guitar → music theory, songwriting, piano · music theory → piano, guitar, composition ·
piano → music theory, composition · singing → music theory, public speaking · drums → music theory, guitar ·
songwriting → music theory, guitar · violin → music theory · ukulele → guitar, music theory

**Languages:** spanish → french, portuguese, italian · french → spanish, italian ·
german → french, english · japanese → korean, mandarin · korean → japanese, mandarin ·
mandarin → japanese, korean · english → public speaking, creative writing · italian → spanish, french ·
portuguese → spanish

**Soft skills/Business:** public speaking → communication, interview skills, leadership ·
communication → public speaking, leadership · leadership → public speaking, communication ·
interview skills → public speaking, communication · digital marketing → seo, content writing, social media marketing ·
seo → digital marketing, content writing · content writing → seo, creative writing, copywriting ·
creative writing → content writing, english · copywriting → content writing, digital marketing ·
social media marketing → digital marketing, video editing

**Lifestyle (users add these):** cooking → baking, nutrition · baking → cooking ·
yoga → meditation, fitness · fitness → yoga, nutrition · meditation → yoga ·
chess → data structures, public speaking(*) · nutrition → cooking, fitness

(*) chess has no natural in-catalog neighbor; category fallback usually handles it — the edge is
there only so the graph never returns garbage for a common skill.

### 7.4 Three-tier lookup (durability guarantee — no daily patching)

For each of the user's skills (learning list first, then teaching):

1. **Tier 1 — curated graph:** `normalize(skill)` → progression edges → keep candidates that
   exist in the **live catalog** (normalized-name match) AND have ≥1 available teacher AND aren't
   already on the user's teach/learn lists. First hit wins.
2. **Tier 2 — catalog co-occurrence:** the existing `relatedSkills` computation (same category +
   co-occurrence scoring) already in `gatherSignals`. Same filters. **Same-category only** — this
   is the structural guard that makes "Drums → SEO" impossible: cross-domain hops don't exist in
   tier 1 (curated, domain-internal) or tier 2 (category-constrained), and there is no tier that
   free-associates.
3. **Tier 3 — none:** the GROWTH-PATH family emits `trending` or nothing. Never invent.

A skill nobody has heard of ("Underwater Basket Weaving") normalizes, misses tier 1, gets a
same-category tier-2 shot if the user gave it a category, otherwise the engine simply picks other
families. Zero maintenance required.

---

## 8. Caching & invalidation

- Keep the `ai_suggestions` table exactly as-is (no migration needed — TTL lives in code).
- **TTL: 6h → 30 minutes.** Generation is now ~10 cheap RLS reads, no API cost; fresher is better.
- Keep the 60s regen floor and the concurrent-claim CAS logic verbatim.
- Old cached rows are shape-compatible (`Suggestion[]` unchanged) → no migration, no cleanup;
  they age out in ≤6h or die on first ⟳.
- `invalidateAiSuggestionsCache()` is already called after profile/skill edits. **Add calls
  after:** availability save (`AvailabilityEditor` save path), session completion (dashboard/session
  detail completion handlers), verification pass (`SkillVerificationDialog` success path). All
  client-side one-liners; no DB triggers needed.

---

## 9. Frontend changes (deliberately tiny)

| File | Change |
|---|---|
| `src/lib/ai-suggestions.ts` | Add `tzOffsetMinutes: new Date().getTimezoneOffset()` to the invoke body. Delete the client-side `tidyMessage`/`rewriteLeadingNumber` legacy cleanup (templates are clean; keep for 1 release if paranoid about old cache rows, then delete). |
| `src/routes/dashboard.tsx` | No structural change. `AiInsightCard`/`InsightTile` and the `action.kind` click branches work as-is. Optional: card label "AI Suggestions" → "Suggestions" or "For you" (owner's call — the engine is still a recommender system; keeping the label is defensible for the project demo). |
| Streak card | Keep the client-side `loadStreak` for the streak chip UI, but both computations now use the same definition (consecutive local days, completed sessions, either role) — the tile and the chip can no longer contradict each other because the server gets the client's tz offset. |
| Feature flag | `features.ai_suggestions.enabled` gate stays untouched. |

---

## 10. Config & secrets cleanup

- `generate-suggestions` no longer reads `GEMINI_API_KEY` / `GROQ_API_KEY`. Do **not** delete the
  secrets from the Supabase project — `GEMINI_NOTES_API_KEY` (session notes) is separate and
  stays; the old keys just become unused by this function.
- Remove the model-name constants, retry/backoff code, and the JSON-parse-of-LLM-output paths.

---

## 11. QA matrix (run all of these before calling it done)

| # | User state | Expected 4 tiles |
|---|---|---|
| 1 | Brand new (nothing set) | Exactly: add teach, add learn, set availability, add bio. NO day counts, NO streaks, NO "been N days". |
| 2 | Only bio missing, active user | 1 bio tile + 3 growth, no duplicates |
| 3 | Complete profile, 5 completed sessions this month, active streak | Exactly ONE momentum-family tile (streak wins). The taught/completed double-tile bug must be impossible. |
| 4 | Complete profile, last session 6+ days ago | `reengage` tile with the REAL day count; verify against DB by hand |
| 5 | Zero sessions ever, complete profile | `first_session` or other growth — NEVER `reengage`/`streak` |
| 6 | Teaches a skill with 2 seekers | "2 learners want SKILL" with the real count; click lands on Explore filtered to that skill + learners mode |
| 7 | Learns HTML (or has HTML session history) | progression suggests CSS/JavaScript ONLY if a teacher for it exists; click resolves to that teacher/explore |
| 8 | Teaches Drums (user-added skill) | progression = music-domain or nothing. NEVER cross-domain (SEO etc.) |
| 9 | Unverified teaching skill | `verify` tile appears (when slot available); click → profile |
| 10 | Every tile, every state | No two tiles share family/skill/person; count is exactly 4; no message starts with a digit; no em-dashes |
| 11 | Same user, same day, refresh ×5 | Identical tiles (deterministic); next day → variant rotation |
| 12 | Timezone check (evening user, e.g. UTC+5:45 Nepal) | Streak/day counts match the dashboard streak chip exactly |

---

## 12. Implementation order (for the implementing session)

1. `skill-graph.ts` — data + `normalize`/`aliases`/`progressionsFor()` lookups. Pure, no I/O.
2. Extend `gatherSignals` with the new signals (§3) + `tzOffsetMinutes` plumbing.
3. Write the engine: completion checklist → archetype → candidates → dedup → ladder (§6).
4. Rewrite the handler: delete LLM/validator/lexicon/ref code; wire engine; TTL 30min.
5. Frontend: tz offset in invoke body; add the 3 new `invalidateAiSuggestionsCache()` call sites.
6. Deploy: `supabase functions deploy generate-suggestions` (no new migration, no new secrets).
7. Run the QA matrix (§11) against the live app; hand-verify day counts vs DB.

**Definition of done:** all 12 QA rows pass, the function makes zero outbound HTTP calls, and
grepping the function folder for `gemini|groq|fetch(` finds no LLM traffic.
