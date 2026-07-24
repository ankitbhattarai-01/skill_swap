// Generates the dashboard's "Suggestions" tiles with a fully local,
// deterministic rules engine. No LLM, no API keys, no rate limits: every tile
// is computed from real DB data (read under the caller's JWT, so RLS is the
// access boundary) and rendered from fixed copy templates. Output is stable
// for a given (user, day, rotation) triple: automatic loads never flicker,
// while a manual ⟳ bumps `rotation` and deals a genuinely different hand.
//
// Guarantees (see docs/local-suggestions-engine-plan.md):
//   - Exactly 4 tiles for every user state, including a brand-new account.
//   - No two tiles from the same family, about the same skill, or the same
//     person.
//   - "Days since" copy is impossible without at least one completed session.
//   - Skill progressions come only from a curated domain-internal graph plus
//     same-category catalog co-occurrence — never cross-domain association.
//   - Day-boundary math (streaks, days-since) uses the CLIENT's timezone
//     offset, so tiles agree with the dashboard's streak chip.
//
// Endpoint:
//   POST /generate-suggestions
//   Body: { force?: boolean, tzOffsetMinutes?: number, rotation?: number }
//   Returns: { suggestions: Suggestion[], cached: boolean, generatedAt: string }

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsJson, corsPreflight } from "../_shared/cors.ts";
import { canonicalSkillKey, progressionTargets } from "./skill-graph.ts";

// Cache TTL. Generation is ~a dozen cheap RLS reads now (no API cost), so a
// short TTL keeps tiles fresh. The 60s regen floor below still guards abuse.
const CACHE_TTL_MS = 30 * 60 * 1000;

// `action` makes each tile clickable and deep-links to the exact entity the
// message talks about (a specific user, a filtered explore view, etc.). The
// shape must stay in sync with AiSuggestionAction in src/lib/ai-suggestions.ts.
type SuggestionAction =
  // `skillName` is the skill the message is about (the teacher's skill for a
  // match, the skill to learn for a swap). `swapMySkillName` only applies to a
  // reciprocal swap: it's the skill the current user would teach back, so the
  // swap dialog can pre-select BOTH legs to match what the message promised.
  //
  // The `*SkillId` twins let the client open the booking / swap dialog straight
  // from the tile — no profile detour, no re-picking the skill — without having
  // to resolve a name back to a row (names collide, casing drifts). Names stay
  // for display and as the fallback path for cache rows written before this.
  | {
      kind: "user";
      userId: string;
      skillName?: string;
      skillId?: string;
      swapMySkillName?: string;
      swapMySkillId?: string;
    }
  | { kind: "explore"; q?: string; mode?: "teachers" | "learners" }
  | { kind: "profile" }
  | { kind: "skills" };

type Suggestion = {
  message: string;
  // `demand` (people waiting to learn what you teach) is deliberately separate
  // from `trending` (a skill rising platform-wide): DEMAND and PATH each place
  // a tile in the same batch, so sharing a type gave two cards the same icon.
  type:
    | "trending"
    | "demand"
    | "match"
    | "progression"
    | "profile"
    | "swap"
    | "momentum"
    | "general";
  action?: SuggestionAction | null;
};

type AvailableTeacher = {
  skill: string;
  skill_id: string;
  teacher_name: string;
  teacher_id: string;
  credits_per_hour: number;
  rating: number | null;
  review_count: number;
};

type SeekerCount = {
  skill: string;
  skill_id: string;
  count: number;
};

type ReciprocalMatch = {
  user_id: string;
  name: string;
  they_teach: string;
  they_teach_skill_id: string;
  they_want_to_learn: string;
  they_want_to_learn_skill_id: string;
  rating: number | null;
};

type ProgressionPick = {
  from: string;
  suggest: string;
  suggestSkillId: string;
  teacherId: string;
  teacherName: string;
  teacherCount: number;
};

type SkillRef = { id: string; name: string };

type EngineSignals = {
  bio: string | null;
  credits: number;
  teachingSkills: SkillRef[];
  learningSkills: SkillRef[];
  hasAvailability: boolean;
  hasTeachAvailability: boolean;
  // Teaching skill_ids that already carry a verification badge.
  verifiedSkillIds: Set<string>;
  // Hard data gate for ALL "days since" copy: a user with zero completed
  // sessions can never see a day count.
  hasAnyCompletedSession: boolean;
  taughtCount30d: number;
  learnedCount30d: number;
  daysSinceLastSession: number | null;
  streakDays: number;
  availableTeachers: AvailableTeacher[];
  seekerCounts: SeekerCount[];
  reciprocalMatches: ReciprocalMatch[];
  trendingSkills: string[];
  progression: ProgressionPick | null;
};

// ─── Small helpers ──────────────────────────────────────────────────────────

// Calendar-day index in the CLIENT's local timezone. `tzOffsetMinutes` is the
// value of JS `new Date().getTimezoneOffset()` (UTC minus local, so Nepal
// UTC+5:45 sends -345). Subtracting it shifts the epoch into local wall time.
function localDayIndex(epochMs: number, tzOffsetMinutes: number): number {
  return Math.floor((epochMs - tzOffsetMinutes * 60_000) / 86_400_000);
}

// FNV-1a: tiny, stable string hash for the daily copy-variant seed.
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

// Subject-verb agreement for the head-count copy. Pluralizing only the noun
// produced "1 learner want Public Speaking" whenever a skill had exactly one
// seeker — the single most common case on a young platform.
function verb(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

// Ratings read better as words than as a raw "4.7★" — the number invites the
// user to do the arithmetic ("is 4.2 good?") instead of just trusting the
// tile. Anything under 4 is left unsaid: a suggestion is a pitch, and a
// mediocre average is not a reason to book. Returns an adjective phrase meant
// to sit in front of a name ("highly rated Sulav"), or "" for no claim.
function ratingAdjective(rating: number | null): string {
  if (rating === null) return "";
  if (rating >= 4.5) return "highly rated";
  if (rating >= 4) return "well rated";
  return "";
}

// Same phrase capitalised for sentence-initial use ("Highly rated Sulav
// teaches …"), or "" when there is no claim to make.
function ratingAdjectiveLead(rating: number | null): string {
  const adj = ratingAdjective(rating);
  return adj ? `${adj[0].toUpperCase()}${adj.slice(1)} ` : "";
}

// Ring shift: [a,b,c] rotated by 1 is [b,c,a]. Nothing is dropped, so a
// rotated list is still the full list — just entered at a different point.
function rotate<T>(items: T[], by: number): T[] {
  if (items.length < 2) return items;
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// Fetches display name + average rating + review count for a set of teacher
// user ids in two queries. Shared by every teacher lookup so the
// review-aggregation logic lives in one place.
type TeacherCard = { name: string; rating: number | null; reviewCount: number };
async function loadTeacherCards(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, TeacherCard>> {
  const out = new Map<string, TeacherCard>();
  if (!userIds.length) return out;
  type ProfileRow = { id: string; full_name: string | null };
  type ReviewRow = { reviewee_id: string; rating: number };
  const [profilesRes, reviewsRes] = await Promise.all([
    supabase.from("profiles").select("id, full_name").in("id", userIds),
    supabase.from("reviews").select("reviewee_id, rating").in("reviewee_id", userIds),
  ]);
  if (profilesRes.error) {
    console.error("[loadTeacherCards] profiles read failed:", profilesRes.error.message);
  }
  if (reviewsRes.error) {
    console.error("[loadTeacherCards] reviews read failed:", reviewsRes.error.message);
  }
  const ratingsBy = new Map<string, number[]>();
  for (const r of (reviewsRes.data ?? []) as ReviewRow[]) {
    const arr = ratingsBy.get(r.reviewee_id) ?? [];
    arr.push(r.rating);
    ratingsBy.set(r.reviewee_id, arr);
  }
  for (const p of (profilesRes.data ?? []) as ProfileRow[]) {
    if (!p.full_name) continue;
    const ratings = ratingsBy.get(p.id) ?? [];
    const rating = ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null;
    out.set(p.id, { name: p.full_name, rating, reviewCount: ratings.length });
  }
  return out;
}

// Best teacher first: rating desc (unrated last), then review count, then a
// stable id tiebreak so the pick is deterministic.
function bestTeacherFirst(
  ids: string[],
  cards: Map<string, TeacherCard>,
): { id: string; card: TeacherCard }[] {
  return ids
    .map((id) => ({ id, card: cards.get(id) }))
    .filter((c): c is { id: string; card: TeacherCard } => Boolean(c.card))
    .sort((a, b) => {
      const ra = a.card.rating ?? -1;
      const rb = b.card.rating ?? -1;
      if (rb !== ra) return rb - ra;
      if (b.card.reviewCount !== a.card.reviewCount) return b.card.reviewCount - a.card.reviewCount;
      return a.id.localeCompare(b.id);
    });
}

// ─── Signals ────────────────────────────────────────────────────────────────

async function gatherSignals(
  supabase: SupabaseClient,
  userId: string,
  tzOffsetMinutes: number,
): Promise<EngineSignals> {
  // Credits live behind a SECURITY DEFINER RPC because the `credits` column
  // on `profiles` was REVOKE'd from authenticated (see migration
  // 20260511050000_hide_public_credits.sql) to prevent peer-snooping.
  const [
    profileRes,
    teachRes,
    learnRes,
    trendingRes,
    creditBalanceRes,
    catalogRes,
    availabilityRes,
    verifiedRes,
    sessionsRes,
    learnedRes,
  ] = await Promise.all([
    supabase.from("profiles").select("full_name, bio").eq("id", userId).maybeSingle(),
    supabase.from("user_teaching_skills").select("skill_id, skills(name)").eq("user_id", userId),
    supabase.from("user_learning_skills").select("skill_id, skills(name)").eq("user_id", userId),
    supabase
      .from("trending_skills")
      .select("skill_id, skill_name, new_learners, recent_sessions")
      .limit(20),
    supabase.rpc("my_credit_balance"),
    // Curated catalog only. A retired skill must never resurface as a
    // "trending" or "next step" tile — nobody can select it any more, so every
    // such tile would be a dead end.
    supabase.from("skills").select("id, name, category").eq("is_active", true),
    // RLS restricts user_availability SELECT to own rows already.
    supabase.from("user_availability").select("mode").eq("user_id", userId),
    supabase.from("skill_verifications").select("skill_id").eq("user_id", userId),
    // One read serves streak, 30-day counts, days-since AND the has-any gate:
    // `count: "exact"` counts every completed session ever, while the rows
    // (newest 500 by scheduled_at) cover all day-math windows.
    supabase
      .from("sessions")
      .select("scheduled_at, teacher_id, learner_id", { count: "exact" })
      .or(`teacher_id.eq.${userId},learner_id.eq.${userId}`)
      .eq("status", "completed")
      .order("scheduled_at", { ascending: false })
      .limit(500),
    // Learner-side completions feed the progression "from" pool: a skill
    // mastered months ago is still a valid next-step trigger.
    supabase
      .from("sessions")
      .select("skill_id, skills:skill_id(name), updated_at")
      .eq("learner_id", userId)
      .eq("status", "completed")
      .order("updated_at", { ascending: false }),
  ]);

  // Partial failures degrade to fewer growth candidates rather than aborting —
  // the generic fallback ladder still guarantees 4 tiles. But they must be
  // visible in the function logs.
  for (const [label, res] of [
    ["profile", profileRes],
    ["teaching", teachRes],
    ["learning", learnRes],
    ["trending", trendingRes],
    ["credits", creditBalanceRes],
    ["catalog", catalogRes],
    ["availability", availabilityRes],
    ["verifications", verifiedRes],
    ["sessions", sessionsRes],
    ["learned", learnedRes],
  ] as const) {
    if (res.error) console.error(`[gatherSignals] ${label} read failed:`, res.error.message);
  }

  type CatalogRow = { id: string; name: string; category: string | null };
  const catalogSkills = ((catalogRes.data ?? []) as CatalogRow[]).filter((r) => Boolean(r.name));

  type SkillJoinRow = { skill_id: string; skills: { name: string } | null };
  const teachingRows = (teachRes.data ?? []) as SkillJoinRow[];
  const learningRows = (learnRes.data ?? []) as SkillJoinRow[];
  // Sorted by name because the DB returns unordered rows: the engine must be
  // deterministic (same data → same tiles) and these lists drive slicing and
  // "first skill wins" picks downstream.
  const toRefs = (rows: SkillJoinRow[]): SkillRef[] =>
    rows
      .filter((r): r is SkillJoinRow & { skills: { name: string } } =>
        Boolean(r.skill_id && r.skills?.name),
      )
      .map((r) => ({ id: r.skill_id, name: r.skills.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const teachingSkills = toRefs(teachingRows);
  const learningSkills = toRefs(learningRows);

  // ── Session math, all in the client's local calendar days ─────────────────
  type SessionRow = { scheduled_at: string | null; teacher_id: string; learner_id: string };
  const sessionRows = (sessionsRes.data ?? []) as SessionRow[];
  const hasAnyCompletedSession = (sessionsRes.count ?? sessionRows.length) > 0;
  const todayIdx = localDayIndex(Date.now(), tzOffsetMinutes);

  const sessionDays = new Set<number>();
  let latestDayIdx: number | null = null;
  let taughtCount30d = 0;
  let learnedCount30d = 0;
  for (const row of sessionRows) {
    if (!row.scheduled_at) continue;
    const ms = Date.parse(row.scheduled_at);
    if (Number.isNaN(ms)) continue;
    const dayIdx = localDayIndex(ms, tzOffsetMinutes);
    sessionDays.add(dayIdx);
    if (latestDayIdx === null || dayIdx > latestDayIdx) latestDayIdx = dayIdx;
    if (dayIdx >= todayIdx - 29 && dayIdx <= todayIdx) {
      if (row.teacher_id === userId) taughtCount30d++;
      if (row.learner_id === userId) learnedCount30d++;
    }
  }

  // Same walk-back as the dashboard's loadStreak: start today, or yesterday if
  // today has no session yet (the day isn't over).
  let streakDays = 0;
  if (sessionDays.size) {
    let cursor = todayIdx;
    if (!sessionDays.has(cursor)) cursor -= 1;
    while (sessionDays.has(cursor)) {
      streakDays++;
      cursor -= 1;
    }
  }

  const daysSinceLastSession =
    latestDayIdx === null ? null : Math.max(0, todayIdx - latestDayIdx);

  // ── Availability + verification ───────────────────────────────────────────
  type AvailabilityRow = { mode: string };
  const availabilityRows = (availabilityRes.data ?? []) as AvailabilityRow[];
  const hasAvailability = availabilityRows.length > 0;
  const hasTeachAvailability = availabilityRows.some((r) => r.mode === "teach");

  const verifiedSkillIds = new Set<string>(
    ((verifiedRes.data ?? []) as { skill_id: string }[]).map((r) => r.skill_id),
  );

  const myTeachingSkillIds = teachingSkills.map((r) => r.id);
  const myLearningSkillIds = learningSkills.map((r) => r.id);

  // ── Skills the user already engages with ──────────────────────────────────
  // Learning list first so a fresh want drives recommendations; completed
  // learner-side sessions add to the pool (a skill mastered months ago is
  // still a valid next-step trigger). Both the progression and trending blocks
  // below filter against this set, so it's computed once, up front.
  const knownIds = new Set<string>([...myTeachingSkillIds, ...myLearningSkillIds]);
  const knownCanon = new Set<string>(
    [...teachingSkills, ...learningSkills].map((r) => canonicalSkillKey(r.name)),
  );
  type LearnedRow = { skill_id: string | null; skills: { name: string } | null };
  const completedLearning: SkillRef[] = [];
  for (const r of (learnedRes.data ?? []) as LearnedRow[]) {
    if (!r.skill_id || !r.skills?.name) continue;
    const key = canonicalSkillKey(r.skills.name);
    if (knownCanon.has(key)) continue;
    knownCanon.add(key);
    knownIds.add(r.skill_id);
    completedLearning.push({ id: r.skill_id, name: r.skills.name });
  }

  const catalogByCanon = new Map<string, CatalogRow>();
  const catalogById = new Map<string, CatalogRow>();
  for (const c of catalogSkills) {
    catalogById.set(c.id, c);
    const key = canonicalSkillKey(c.name);
    if (!catalogByCanon.has(key)) catalogByCanon.set(key, c);
  }

  // ── Growth signals ────────────────────────────────────────────────────────
  // The five blocks below each depend only on the batch above, never on each
  // other, so they run concurrently: end-to-end latency becomes the depth of
  // the slowest single block instead of the sum of all five. (This endpoint is
  // round-trip bound, not row bound — the queries themselves are tiny.)

  // Available teachers for the user's wanted skills. One batched query across
  // ALL learning skills, then one profiles + one reviews lookup over the union
  // of candidates. Kept cheapest-3 per skill.
  const teachersBlock = async (): Promise<AvailableTeacher[]> => {
    const out: AvailableTeacher[] = [];
    const learningForTeachers = learningSkills.slice(0, 5);
    if (!learningForTeachers.length) return out;

    type TeachRow = { user_id: string; skill_id: string; credits_per_hour: number };
    const { data: teachAllRaw, error: teachAllError } = await supabase
      .from("user_teaching_skills")
      .select("user_id, skill_id, credits_per_hour")
      .in(
        "skill_id",
        learningForTeachers.map((r) => r.id),
      )
      .neq("user_id", userId)
      .order("credits_per_hour", { ascending: true })
      .limit(60);
    if (teachAllError) {
      console.error("[gatherSignals] teacher candidates read failed:", teachAllError.message);
    }

    // Re-sort with a user_id tiebreak: the DB only ordered by price, so equal
    // prices could arrive in any order and break determinism.
    const teachRows = ((teachAllRaw ?? []) as TeachRow[]).sort(
      (a, b) => a.credits_per_hour - b.credits_per_hour || a.user_id.localeCompare(b.user_id),
    );
    const teachersBySkill = new Map<string, TeachRow[]>();
    for (const t of teachRows) {
      const arr = teachersBySkill.get(t.skill_id) ?? [];
      if (arr.length < 3) {
        arr.push(t);
        teachersBySkill.set(t.skill_id, arr);
      }
    }

    const teacherIds = Array.from(
      new Set(
        Array.from(teachersBySkill.values())
          .flat()
          .map((t) => t.user_id),
      ),
    );
    if (!teacherIds.length) return out;

    const cards = await loadTeacherCards(supabase, teacherIds);
    for (const skill of learningForTeachers) {
      for (const t of teachersBySkill.get(skill.id) ?? []) {
        const card = cards.get(t.user_id);
        if (!card) continue;
        out.push({
          skill: skill.name,
          skill_id: skill.id,
          teacher_name: card.name,
          teacher_id: t.user_id,
          credits_per_hour: t.credits_per_hour ?? 4,
          rating: card.rating,
          review_count: card.reviewCount,
        });
      }
    }
    return out;
  };

  // Seeker demand for the user's taught skills (real head-counts).
  const seekersBlock = async (): Promise<SeekerCount[]> => {
    const out: SeekerCount[] = [];
    const teachingForSeekers = teachingSkills.slice(0, 5);
    const seekerCountResults = await Promise.all(
      teachingForSeekers.map((skill) =>
        supabase
          .from("user_learning_skills")
          .select("user_id", { count: "exact", head: true })
          .eq("skill_id", skill.id)
          .neq("user_id", userId),
      ),
    );
    teachingForSeekers.forEach((skill, i) => {
      const res = seekerCountResults[i];
      if (res.error) {
        console.error("[gatherSignals] seeker count failed:", res.error.message);
        return;
      }
      if (res.count && res.count > 0) {
        out.push({ skill: skill.name, skill_id: skill.id, count: res.count });
      }
    });
    out.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
    return out;
  };

  // Reciprocal matches (direct swaps, the platform's killer feature).
  const reciprocalBlock = async (): Promise<ReciprocalMatch[]> => {
    const reciprocalMatches: ReciprocalMatch[] = [];
    if (!myTeachingSkillIds.length || !myLearningSkillIds.length) return reciprocalMatches;

    type MatchRow = { user_id: string; skill_id: string };

    const [teachersOfMyWantsRaw, learnersOfMyOffersRaw] = await Promise.all([
      supabase
        .from("user_teaching_skills")
        .select("user_id, skill_id")
        .in("skill_id", myLearningSkillIds)
        .neq("user_id", userId),
      supabase
        .from("user_learning_skills")
        .select("user_id, skill_id")
        .in("skill_id", myTeachingSkillIds)
        .neq("user_id", userId),
    ]);

    const teachesByUser = new Map<string, Set<string>>();
    for (const r of (teachersOfMyWantsRaw.data ?? []) as MatchRow[]) {
      const set = teachesByUser.get(r.user_id) ?? new Set();
      set.add(r.skill_id);
      teachesByUser.set(r.user_id, set);
    }
    const wantsByUser = new Map<string, Set<string>>();
    for (const r of (learnersOfMyOffersRaw.data ?? []) as MatchRow[]) {
      const set = wantsByUser.get(r.user_id) ?? new Set();
      set.add(r.skill_id);
      wantsByUser.set(r.user_id, set);
    }

    // Candidates who both teach-what-I-want AND want-what-I-teach. Sorted so
    // the shortlist below is deterministic regardless of DB row order.
    const candidateIds = [...teachesByUser.keys()]
      .filter((id) => wantsByUser.has(id))
      .sort();
    if (!candidateIds.length) return reciprocalMatches;

    // A direct swap is the strongest tile the engine can produce, so the person
    // it names has to be the most credible partner available — not whoever's
    // uuid happened to sort first. Ranking priority, in order:
    //   1. rating (desc, unrated last)
    //   2. how many of the skills they teach are ones you actually want
    //   3. review count, then id, purely as deterministic tiebreaks
    const shortlist = candidateIds.slice(0, 10);
    const cards = await loadTeacherCards(supabase, shortlist);
    const rankedIds = shortlist
      .filter((id) => cards.has(id))
      .sort((a, b) => {
        const ca = cards.get(a)!;
        const cb = cards.get(b)!;
        const ra = ca.rating ?? -1;
        const rb = cb.rating ?? -1;
        if (rb !== ra) return rb - ra;
        const oa = teachesByUser.get(a)?.size ?? 0;
        const ob = teachesByUser.get(b)?.size ?? 0;
        if (ob !== oa) return ob - oa;
        if (cb.reviewCount !== ca.reviewCount) return cb.reviewCount - ca.reviewCount;
        return a.localeCompare(b);
      });

    const skillNameById = new Map<string, string>();
    for (const r of [...teachingSkills, ...learningSkills]) skillNameById.set(r.id, r.name);

    // Deterministic leg pick: the skill whose name sorts first, rather than
    // whatever order the DB returned the rows in.
    const firstLeg = (set: Set<string> | undefined): string | undefined =>
      [...(set ?? [])].sort((a, b) =>
        (skillNameById.get(a) ?? a).localeCompare(skillNameById.get(b) ?? b),
      )[0];

    for (const candId of rankedIds.slice(0, 3)) {
      const card = cards.get(candId);
      if (!card) continue;
      const theyTeachId = firstLeg(teachesByUser.get(candId));
      const theyWantId = firstLeg(wantsByUser.get(candId));
      const theyTeach = theyTeachId ? skillNameById.get(theyTeachId) : undefined;
      const theyWant = theyWantId ? skillNameById.get(theyWantId) : undefined;
      if (!theyTeachId || !theyWantId || !theyTeach || !theyWant) continue;
      reciprocalMatches.push({
        user_id: candId,
        name: card.name,
        they_teach: theyTeach,
        they_teach_skill_id: theyTeachId,
        they_want_to_learn: theyWant,
        they_want_to_learn_skill_id: theyWantId,
        rating: card.rating,
      });
    }
    return reciprocalMatches;
  };

  // Progression (curated graph first, same-category co-occurrence second).
  const progressionBlock = async (): Promise<ProgressionPick | null> => {
    // Tier 1: curated progression edges, kept only when the target exists in
    // the live catalog and isn't already on the user's lists. Ordered
    // best-first.
    type ProgressionCandidate = { from: string; row: CatalogRow };
    const progressionCandidates: ProgressionCandidate[] = [];
    const seenCandidateIds = new Set<string>();
    const fromPool = [...learningSkills, ...completedLearning, ...teachingSkills];
    for (const source of fromPool) {
      for (const targetKey of progressionTargets(source.name)) {
        const row = catalogByCanon.get(targetKey);
        if (!row || knownIds.has(row.id) || seenCandidateIds.has(row.id)) continue;
        seenCandidateIds.add(row.id);
        progressionCandidates.push({ from: source.name, row });
        if (progressionCandidates.length >= 8) break;
      }
      if (progressionCandidates.length >= 8) break;
    }

    // Tier 2: SAME-CATEGORY catalog neighbours, ranked by peer co-occurrence.
    // The category constraint is the structural guard against cross-domain hops
    // ("Drums → SEO"): a candidate must share a category with the user's skill
    // that drives it. Co-occurrence only ranks within that boundary.
    if (progressionCandidates.length < 8 && knownIds.size) {
      const knownIdList = [...knownIds];
      type PeerRow = { user_id: string; skill_id: string };
      const [peerTeachRaw, peerLearnRaw] = await Promise.all([
        supabase
          .from("user_teaching_skills")
          .select("user_id, skill_id")
          .in("skill_id", knownIdList)
          .neq("user_id", userId)
          .limit(200),
        supabase
          .from("user_learning_skills")
          .select("user_id, skill_id")
          .in("skill_id", knownIdList)
          .neq("user_id", userId)
          .limit(200),
      ]);
      const peerIds = [
        ...new Set(
          [
            ...((peerTeachRaw.data ?? []) as PeerRow[]),
            ...((peerLearnRaw.data ?? []) as PeerRow[]),
          ].map((r) => r.user_id),
        ),
      ].slice(0, 100);

      const coOccurrence = new Map<string, number>();
      if (peerIds.length) {
        const [peerTeachSkillsRaw, peerLearnSkillsRaw] = await Promise.all([
          supabase
            .from("user_teaching_skills")
            .select("user_id, skill_id")
            .in("user_id", peerIds)
            .limit(400),
          supabase
            .from("user_learning_skills")
            .select("user_id, skill_id")
            .in("user_id", peerIds)
            .limit(400),
        ]);
        for (const r of [
          ...((peerTeachSkillsRaw.data ?? []) as PeerRow[]),
          ...((peerLearnSkillsRaw.data ?? []) as PeerRow[]),
        ]) {
          if (!knownIds.has(r.skill_id)) {
            coOccurrence.set(r.skill_id, (coOccurrence.get(r.skill_id) ?? 0) + 1);
          }
        }
      }

      // A known skill per category (prefer learning-side) attributes the "from".
      const fromByCategory = new Map<string, string>();
      for (const source of fromPool) {
        const cat = catalogById.get(source.id)?.category;
        if (cat && !fromByCategory.has(cat)) fromByCategory.set(cat, source.name);
      }
      const tier2 = catalogSkills
        .filter(
          (c) =>
            c.category &&
            fromByCategory.has(c.category) &&
            !knownIds.has(c.id) &&
            !seenCandidateIds.has(c.id),
        )
        .sort((a, b) => {
          const diff = (coOccurrence.get(b.id) ?? 0) - (coOccurrence.get(a.id) ?? 0);
          return diff !== 0 ? diff : a.name.localeCompare(b.name);
        });
      for (const row of tier2) {
        seenCandidateIds.add(row.id);
        progressionCandidates.push({ from: fromByCategory.get(row.category as string)!, row });
        if (progressionCandidates.length >= 8) break;
      }
    }

    // Dead-end guard: a progression is only emitted when the suggested skill
    // has at least one bookable teacher. First candidate with a teacher wins.
    if (!progressionCandidates.length) return null;
    type TeachRow = { user_id: string; skill_id: string };
    const { data: progTeachRaw, error: progTeachErr } = await supabase
      .from("user_teaching_skills")
      .select("user_id, skill_id")
      .in(
        "skill_id",
        progressionCandidates.map((c) => c.row.id),
      )
      .neq("user_id", userId)
      .limit(80);
    if (progTeachErr) {
      console.error("[gatherSignals] progression teacher lookup failed:", progTeachErr.message);
    }
    const teachersForSkill = new Map<string, string[]>();
    for (const t of (progTeachRaw ?? []) as TeachRow[]) {
      const arr = teachersForSkill.get(t.skill_id) ?? [];
      if (!arr.includes(t.user_id)) arr.push(t.user_id);
      teachersForSkill.set(t.skill_id, arr);
    }
    const winner = progressionCandidates.find((c) => (teachersForSkill.get(c.row.id) ?? []).length);
    if (!winner) return null;
    const teacherIds = teachersForSkill.get(winner.row.id) ?? [];
    const cards = await loadTeacherCards(supabase, teacherIds.slice(0, 10));
    const best = bestTeacherFirst(teacherIds, cards)[0];
    if (!best) return null;
    return {
      from: winner.from,
      suggest: winner.row.name,
      suggestSkillId: winner.row.id,
      teacherId: best.id,
      teacherName: best.card.name,
      teacherCount: teacherIds.length,
    };
  };

  // Trending: teacher-backed skills not already on the user's lists. The view
  // ranks by learner demand, so a skill can "trend" with zero teachers — and
  // the tile deep-links to find-a-teacher, which would then be empty.
  // Filtering to teacher-backed rows guarantees a bookable landing.
  const trendingBlock = async (): Promise<string[]> => {
    type TrendingRow = { skill_id: string; skill_name: string };
    const trendingRaw = ((trendingRes.data ?? []) as TrendingRow[]).filter(
      (t) => !knownIds.has(t.skill_id),
    );
    if (!trendingRaw.length) return [];
    const { data: trendTeachRows, error: trendTeachErr } = await supabase
      .from("user_teaching_skills")
      .select("skill_id")
      .in(
        "skill_id",
        trendingRaw.map((t) => t.skill_id),
      )
      .neq("user_id", userId);
    if (trendTeachErr) {
      console.error("[gatherSignals] trending teacher filter failed:", trendTeachErr.message);
    }
    const taughtTrending = new Set((trendTeachRows ?? []).map((r) => r.skill_id));
    return trendingRaw
      .filter((t) => taughtTrending.has(t.skill_id))
      .slice(0, 3)
      .map((t) => t.skill_name);
  };

  const [availableTeachers, seekerCounts, reciprocalMatches, progression, trendingSkills] =
    await Promise.all([
      teachersBlock(),
      seekersBlock(),
      reciprocalBlock(),
      progressionBlock(),
      trendingBlock(),
    ]);

  return {
    bio: profileRes.data?.bio ?? null,
    credits: (creditBalanceRes.data as number) ?? 0,
    teachingSkills,
    learningSkills,
    hasAvailability,
    hasTeachAvailability,
    verifiedSkillIds,
    hasAnyCompletedSession,
    taughtCount30d,
    learnedCount30d,
    daysSinceLastSession,
    streakDays,
    availableTeachers,
    seekerCounts,
    reciprocalMatches,
    trendingSkills,
    progression,
  };
}

// ─── Selection engine ───────────────────────────────────────────────────────
// Families cap repetition structurally: at most one MOMENTUM tile kills the
// old "taught 5 sessions" + "completed 5 sessions" duplicate for good.

type Family = "COMPLETION" | "MOMENTUM" | "MATCH" | "DEMAND" | "PATH" | "TRUST" | "GENERIC";
const FAMILY_CAPS: Record<Family, number> = {
  COMPLETION: 4,
  MOMENTUM: 1,
  MATCH: 2,
  DEMAND: 1,
  PATH: 1,
  TRUST: 1,
  GENERIC: 4,
};

type Tile = {
  id: string;
  family: Family;
  // Canonical skill keys this tile names (dedup rule: no two tiles may
  // mention the same skill).
  skillKeys: string[];
  // The person this tile deep-links to (dedup rule: no two tiles may mention
  // the same person).
  personId?: string;
  suggestion: Suggestion;
};

type VariantPicker = (categoryId: string, variants: string[]) => string;

// ── Completion tiles (§4 of the plan) ───────────────────────────────────────

type ChecklistItem = "teach" | "learn" | "availability" | "bio";

// Fixed priority order: skills unlock matching, availability unlocks booking,
// bio is polish.
function completionMissing(s: EngineSignals): ChecklistItem[] {
  const missing: ChecklistItem[] = [];
  if (!s.teachingSkills.length) missing.push("teach");
  if (!s.learningSkills.length) missing.push("learn");
  if (!s.hasAvailability) missing.push("availability");
  if (!s.bio || !s.bio.trim()) missing.push("bio");
  return missing;
}

function completionTile(item: ChecklistItem, pick: VariantPicker): Tile {
  const copy: Record<ChecklistItem, { variants: string[]; action: SuggestionAction }> = {
    teach: {
      variants: [
        "Add a skill you can teach so others can book you.",
        "List a teaching skill to start earning credits.",
        "Something you already know is worth credits here. Add it as a teaching skill.",
      ],
      action: { kind: "skills" },
    },
    learn: {
      variants: [
        "Add a skill you want to learn to get matched with teachers.",
        "Tell us what you want to learn and we will find teachers for you.",
        "Pick one thing you want to get better at and we will match you.",
      ],
      action: { kind: "skills" },
    },
    availability: {
      variants: [
        "Set your weekly availability so sessions can be booked.",
        "Add your free hours so booking takes seconds.",
        "Nobody can book you until your weekly hours are set. It takes a minute.",
      ],
      action: { kind: "profile" },
    },
    bio: {
      variants: [
        "Add a short bio so people know who they are learning with.",
        "A two line bio makes your profile far more trustworthy.",
        "Say a little about yourself. Profiles with a bio get more requests.",
      ],
      action: { kind: "profile" },
    },
  };
  const { variants, action } = copy[item];
  const id = `completion_${item}`;
  return {
    id,
    family: "COMPLETION",
    skillKeys: [],
    suggestion: { message: pick(id, variants), type: "profile", action },
  };
}

// ── Growth candidates (§5) ──────────────────────────────────────────────────

// MOMENTUM emits at most one candidate, chosen by fixed precedence:
// streak > reengage > first_session > taught > learned. The `reengage` branch
// is structurally impossible without a completed session — that's the "15 days
// for a new user" bug, fixed by a data gate rather than trusted copy.
function momentumCandidate(s: EngineSignals, pick: VariantPicker): Tile | null {
  if (s.streakDays >= 2) {
    const n = s.streakDays;
    return {
      id: "streak",
      family: "MOMENTUM",
      skillKeys: [],
      suggestion: {
        message: pick("streak", [
          `You are on a ${n} day streak. One session today keeps it going.`,
          `Learning ${n} days in a row. Keep the run alive with a quick session.`,
          `${n} days straight. Do not break the chain, book something short.`,
        ]),
        type: "momentum",
        action: { kind: "explore", mode: "teachers" },
      },
    };
  }
  if (
    s.hasAnyCompletedSession &&
    s.daysSinceLastSession !== null &&
    s.daysSinceLastSession >= 5
  ) {
    const n = s.daysSinceLastSession;
    return {
      id: "reengage",
      family: "MOMENTUM",
      skillKeys: [],
      suggestion: {
        message: pick("reengage", [
          `It has been ${n} days since your last session. Book a short one to get back in rhythm.`,
          `Your last session was ${n} days ago. A quick booking gets you moving again.`,
          `${n} days off. A 20 minute session is enough to pick the thread back up.`,
        ]),
        type: "momentum",
        action: { kind: "explore", mode: "teachers" },
      },
    };
  }
  if (!s.hasAnyCompletedSession && s.learningSkills.length && s.availableTeachers.length) {
    const best = bestOverallTeacher(s.availableTeachers);
    return {
      id: "first_session",
      family: "MOMENTUM",
      skillKeys: [canonicalSkillKey(best.skill)],
      personId: best.teacher_id,
      suggestion: {
        message: pick("first_session", [
          `Your first session is one click away. ${firstName(best.teacher_name)} teaches ${best.skill} for ${best.credits_per_hour} credits an hour.`,
          `Ready to start? ${firstName(best.teacher_name)} teaches ${best.skill} and charges ${best.credits_per_hour} credits an hour.`,
          `${firstName(best.teacher_name)} could be your first session: ${best.skill}, ${best.credits_per_hour} credits an hour.`,
        ]),
        type: "match",
        action: {
          kind: "user",
          userId: best.teacher_id,
          skillName: best.skill,
          skillId: best.skill_id,
        },
      },
    };
  }
  if (s.taughtCount30d >= 3) {
    const n = s.taughtCount30d;
    return {
      id: "taught_momentum",
      family: "MOMENTUM",
      skillKeys: [],
      suggestion: {
        message: pick("taught_momentum", [
          `You taught ${n} sessions this month. Your learners are showing up, keep going.`,
          `Teaching momentum: ${n} sessions this month. Keep it rolling.`,
          `${n} sessions taught this month. That is a real teaching habit forming.`,
        ]),
        type: "momentum",
        action: { kind: "explore", mode: "learners" },
      },
    };
  }
  if (s.learnedCount30d >= 3) {
    const n = s.learnedCount30d;
    return {
      id: "learned_momentum",
      family: "MOMENTUM",
      skillKeys: [],
      suggestion: {
        message: pick("learned_momentum", [
          `You completed ${n} sessions this month. Solid pace, keep it up.`,
          `That is ${n} sessions finished this month. Nice rhythm, keep going.`,
          `${n} sessions done this month. Line up the next one while you are on a roll.`,
        ]),
        type: "momentum",
        action: { kind: "explore", mode: "teachers" },
      },
    };
  }
  return null;
}

// Rating desc, then price asc: the friendliest credible first booking heads
// the list.
function rankTeachers(teachers: AvailableTeacher[]): AvailableTeacher[] {
  return [...teachers].sort((a, b) => {
    const ra = a.rating ?? -1;
    const rb = b.rating ?? -1;
    if (rb !== ra) return rb - ra;
    if (a.credits_per_hour !== b.credits_per_hour) return a.credits_per_hour - b.credits_per_hour;
    return a.teacher_id.localeCompare(b.teacher_id);
  });
}

function bestOverallTeacher(teachers: AvailableTeacher[]): AvailableTeacher {
  return rankTeachers(teachers)[0];
}

// Best teacher per wanted skill (from the cheapest-3 pool): rating desc, then
// price asc, one candidate tile per distinct skill. `rotation` steps down that
// ranking, so pressing ⟳ on a skill with several teachers recommends the next
// one rather than repeating the same name.
function teacherCandidates(s: EngineSignals, pick: VariantPicker, rotation: number): Tile[] {
  const bySkill = new Map<string, AvailableTeacher[]>();
  for (const t of s.availableTeachers) {
    const arr = bySkill.get(t.skill_id) ?? [];
    arr.push(t);
    bySkill.set(t.skill_id, arr);
  }
  const tiles: Tile[] = [];
  for (const group of bySkill.values()) {
    const ranked = rankTeachers(group);
    const best = ranked[rotation % ranked.length];
    const adj = ratingAdjective(best.rating);
    const lead = ratingAdjectiveLead(best.rating);
    tiles.push({
      id: `teacher_${best.skill_id}`,
      family: "MATCH",
      skillKeys: [canonicalSkillKey(best.skill)],
      personId: best.teacher_id,
      suggestion: {
        message: pick(`teacher_${best.skill_id}`, [
          `${lead}${firstName(best.teacher_name)} teaches ${best.skill} at ${best.credits_per_hour} credits/hour. Book a session.`,
          `Learn ${best.skill} with ${adj ? `${adj} ` : ""}${firstName(best.teacher_name)} for ${best.credits_per_hour} credits an hour.`,
          `Still want ${best.skill}? ${firstName(best.teacher_name)} teaches it for ${best.credits_per_hour} credits an hour${adj ? ` and is ${adj}` : ""}.`,
        ]),
        type: "match",
        action: {
          kind: "user",
          userId: best.teacher_id,
          skillName: best.skill,
          skillId: best.skill_id,
        },
      },
    });
  }
  return tiles;
}

function swapCandidates(s: EngineSignals, pick: VariantPicker): Tile[] {
  return s.reciprocalMatches.map((m, i) => {
    // Rating is the second-strongest signal after the swap itself, so say it
    // out loud when the partner has a good one — it's the difference between
    // "someone matches you" and "someone good matches you".
    const adj = ratingAdjective(m.rating);
    const lead = ratingAdjectiveLead(m.rating);
    return {
      id: i === 0 ? "swap" : `swap_${i + 1}`,
      family: "MATCH" as const,
      skillKeys: [canonicalSkillKey(m.they_teach), canonicalSkillKey(m.they_want_to_learn)],
      personId: m.user_id,
      suggestion: {
        message: pick(`swap_${m.user_id}`, [
          `${lead}${firstName(m.name)} teaches ${m.they_teach} and wants ${m.they_want_to_learn}. Direct swap, no credits.`,
          `Trade with ${adj ? `${adj} ` : ""}${firstName(m.name)}: their ${m.they_teach} for your ${m.they_want_to_learn}. No credits needed.`,
          `You and ${adj ? `${adj} ` : ""}${firstName(m.name)} line up perfectly: ${m.they_teach} for ${m.they_want_to_learn}. Propose a swap.`,
        ]),
        type: "swap" as const,
        action: {
          kind: "user" as const,
          userId: m.user_id,
          skillName: m.they_teach,
          skillId: m.they_teach_skill_id,
          swapMySkillName: m.they_want_to_learn,
          swapMySkillId: m.they_want_to_learn_skill_id,
        },
      },
    };
  });
}

// DEMAND is capped at one placed tile, but emits a candidate per in-demand
// skill (top 2) so rotation can talk about a different one. earn_credits
// outranks plain seekers when the user is genuinely short on credits (more
// actionable framing), and only the top skill gets that framing.
function demandCandidates(s: EngineSignals, pick: VariantPicker): Tile[] {
  if (!s.teachingSkills.length) return [];
  const cheapest = s.availableTeachers.length
    ? Math.min(...s.availableTeachers.map((t) => t.credits_per_hour))
    : null;
  const lowOnCredits = cheapest !== null && s.credits < cheapest;

  return s.seekerCounts.slice(0, 2).map((row, i) => {
    const n = row.count;
    const learners = plural(n, "learner");
    const wants = verb(n, "wants", "want");
    const areLooking = verb(n, "is looking", "are looking");
    const areWaiting = verb(n, "is waiting", "are waiting");
    const earnFraming = lowOnCredits && i === 0;
    return {
      id: earnFraming ? "earn_credits" : i === 0 ? "seekers" : `seekers_${i + 1}`,
      family: "DEMAND" as const,
      skillKeys: [canonicalSkillKey(row.skill)],
      suggestion: {
        message: earnFraming
          ? pick("earn_credits", [
              `Low on credits? ${n} ${learners} ${wants} ${row.skill}. Teach a session to top up.`,
              `Teach ${row.skill} to earn credits, ${n} ${learners} ${areWaiting} right now.`,
              `${n} ${learners} ${wants} ${row.skill}. One session teaching it tops your balance up.`,
            ])
          : pick(`seekers_${row.skill_id}`, [
              `${row.skill} has ${n} ${learners} waiting right now. Offer a session on Explore.`,
              `Demand is up: ${n} ${learners} ${wants} ${row.skill}. Head to Explore to offer a session.`,
              `${n} ${learners} ${areLooking} for ${row.skill}. You could teach one this week.`,
            ]),
        type: "demand" as const,
        action: { kind: "explore" as const, q: row.skill, mode: "learners" as const },
      },
    };
  });
}

function progressionCandidate(s: EngineSignals, pick: VariantPicker): Tile | null {
  const p = s.progression;
  if (!p) return null;
  const single = p.teacherCount === 1;
  const teacher = firstName(p.teacherName);
  return {
    id: "progression",
    family: "PATH",
    skillKeys: [canonicalSkillKey(p.from), canonicalSkillKey(p.suggest)],
    personId: single ? p.teacherId : undefined,
    suggestion: {
      message: single
        ? pick("progression", [
            `Into ${p.from}? ${p.suggest} is the natural next step, and ${teacher} teaches it.`,
            `You know ${p.from}. ${p.suggest} pairs perfectly with it, and ${teacher} can get you started.`,
            `${p.suggest} builds straight on your ${p.from}. ${teacher} can take you through it.`,
          ])
        : pick("progression", [
            `Into ${p.from}? ${p.suggest} is the natural next step, and teachers are available now.`,
            `You know ${p.from}. ${p.suggest} pairs perfectly with it. See who teaches it.`,
            `${p.suggest} is where ${p.from} usually leads next. Several people teach it.`,
          ]),
      type: "progression",
      action: single
        ? { kind: "user", userId: p.teacherId, skillName: p.suggest, skillId: p.suggestSkillId }
        : { kind: "explore", q: p.suggest, mode: "teachers" },
    },
  };
}

// One candidate per trending skill (up to 3). The PATH cap still lets only one
// through per batch — the extras exist so a manual ⟳ rotation can surface a
// different trending skill instead of the same one every time.
function trendingCandidates(s: EngineSignals, pick: VariantPicker): Tile[] {
  return s.trendingSkills.map((skill, i) => ({
    id: i === 0 ? "trending" : `trending_${i + 1}`,
    family: "PATH" as const,
    skillKeys: [canonicalSkillKey(skill)],
    suggestion: {
      message: pick(`trending_${skill}`, [
        `${skill} is taking off on SkillSwap this week. Worth a look.`,
        `More people are picking up ${skill} lately. See who teaches it.`,
        `${skill} is having a moment on SkillSwap. Take a look at who teaches it.`,
      ]),
      type: "trending" as const,
      action: { kind: "explore" as const, q: skill, mode: "teachers" as const },
    },
  }));
}

function trustCandidates(s: EngineSignals, pick: VariantPicker): Tile[] {
  const tiles: Tile[] = [];
  // One candidate per unverified teaching skill (top 2). TRUST caps placement
  // at one, so the second only appears when rotation reaches it.
  const unverified = s.teachingSkills.filter((t) => !s.verifiedSkillIds.has(t.id)).slice(0, 2);
  unverified.forEach((skill, i) => {
    tiles.push({
      id: i === 0 ? "verify" : `verify_${i + 1}`,
      family: "TRUST",
      skillKeys: [canonicalSkillKey(skill.name)],
      suggestion: {
        message: pick(`verify_${skill.id}`, [
          `Get verified in ${skill.name} to earn the trusted tick. Verified teachers get booked more.`,
          `A verified tick on ${skill.name} builds trust. Take the short quiz from your profile.`,
          `Ten questions is all it takes to get the verified tick on ${skill.name}.`,
        ]),
        type: "profile",
        action: { kind: "profile" },
      },
    });
  });
  if (s.teachingSkills.length && s.hasAvailability && !s.hasTeachAvailability) {
    const skill = s.teachingSkills[0].name;
    tiles.push({
      id: "teach_availability",
      family: "TRUST",
      skillKeys: [canonicalSkillKey(skill)],
      suggestion: {
        message: pick("teach_availability", [
          `You listed ${skill} but have no teaching hours set. Add teach slots so learners can book you.`,
          `Learners cannot book ${skill} until you add teaching hours. Set a teach window.`,
          `Add a teaching window and ${skill} becomes bookable straight from your profile.`,
        ]),
        type: "profile",
        action: { kind: "profile" },
      },
    });
  }
  return tiles;
}

// ── Archetype priority (§6.1): adjusts which growth tiles surface first ─────

type Archetype = "DORMANT" | "NEWCOMER" | "STREAKER" | "TEACHER" | "LEARNER";

function archetypeOf(s: EngineSignals): Archetype {
  if (s.hasAnyCompletedSession && (s.daysSinceLastSession ?? 0) >= 5) return "DORMANT";
  if (!s.hasAnyCompletedSession) return "NEWCOMER";
  if (s.streakDays >= 2) return "STREAKER";
  if (s.taughtCount30d > s.learnedCount30d) return "TEACHER";
  return "LEARNER";
}

// Category-id priority per archetype. `teacher` covers all teacher_* ids.
//
// `swap` leads every archetype on purpose: a reciprocal match is the only tile
// that costs the user nothing, needs no credit balance, and already has the
// other side's interest confirmed. Whatever the user's state, that beats a paid
// booking or a nudge. (It only ever appears when a real reciprocal match
// exists, so leading with it costs nothing when there is none.)
const ARCHETYPE_ORDER: Record<Archetype, string[]> = {
  DORMANT: ["swap", "reengage", "teacher", "earn_credits", "seekers", "progression", "verify", "trending", "teach_availability"],
  NEWCOMER: ["swap", "first_session", "teacher", "earn_credits", "seekers", "trending", "verify", "progression", "teach_availability"],
  STREAKER: ["swap", "streak", "progression", "teacher", "earn_credits", "seekers", "verify", "trending", "teach_availability"],
  TEACHER: ["swap", "earn_credits", "seekers", "verify", "taught_momentum", "teach_availability", "teacher", "progression", "trending"],
  LEARNER: ["swap", "teacher", "progression", "learned_momentum", "earn_credits", "seekers", "verify", "trending", "teach_availability"],
};

// Ids absent from an archetype's list rank after it, in this stable order.
const DEFAULT_TAIL = [
  "swap",
  "streak",
  "reengage",
  "first_session",
  "taught_momentum",
  "learned_momentum",
  "teacher",
  "earn_credits",
  "seekers",
  "progression",
  "trending",
  "verify",
  "teach_availability",
];

function priorityRank(id: string, order: string[]): number {
  // swap_2 → swap, teacher_<uuid> → teacher, trending_2 → trending, and so on.
  // Note "teacher_" (not "teach") so `teach_availability` keeps its own rank.
  const base = id.startsWith("swap")
    ? "swap"
    : id.startsWith("teacher_")
      ? "teacher"
      : id.startsWith("trending")
        ? "trending"
        : id.startsWith("seekers")
          ? "seekers"
          : id.startsWith("verify")
            ? "verify"
            : id;
  const idx = order.indexOf(base);
  if (idx !== -1) return idx;
  const tail = DEFAULT_TAIL.indexOf(base);
  return order.length + (tail === -1 ? DEFAULT_TAIL.length : tail);
}

// ── Generic fallback ladder (§6.4): the exactly-4 guarantee ─────────────────
// These depend only on the credit balance (always readable) and static copy,
// so the ladder alone can always top up to 4. Ladder tiles that would repeat
// the intent of an already-placed tile are skipped — the remaining ones are
// still always enough (each exclusion is caused by a tile already occupying a
// slot, so tiles.length + eligible ladder ≥ 4 holds in every stage).
function ladderTiles(s: EngineSignals, placed: Tile[], pick: VariantPicker): Tile[] {
  const placedIds = new Set(placed.map((t) => t.id));
  const tiles: Tile[] = [];

  const creditsMsg =
    s.credits >= 4
      ? pick("credits_info", [
          `You have ${s.credits} credits ready to spend. A session costs about 4 per hour.`,
          `Your balance is ${s.credits} credits, enough for about ${Math.floor(s.credits / 4)} ${plural(Math.floor(s.credits / 4), "hour")} of learning.`,
          `${s.credits} credits are sitting unspent. Put a couple of them to work this week.`,
        ])
      : s.credits > 0
        ? `You have ${s.credits} credits. Sessions cost about 4 per hour, teach one to top up.`
        : `Sessions cost about 4 credits an hour. Teach one first to build your balance.`;
  tiles.push({
    id: "credits_info",
    family: "GENERIC",
    skillKeys: [],
    suggestion: {
      message: creditsMsg,
      type: "general",
      action: { kind: "explore", mode: s.credits >= 4 ? "teachers" : "learners" },
    },
  });

  if (!placedIds.has("completion_learn")) {
    tiles.push({
      id: "browse_learn",
      family: "GENERIC",
      skillKeys: [],
      suggestion: {
        message: pick("browse_learn", [
          "Browse the skill catalog, you might find your next favorite thing to learn.",
          "Take a scroll through Explore, something new to learn might jump out.",
          "Not sure what is next? Explore is full of people teaching things you have not tried.",
        ]),
        type: "general",
        action: { kind: "explore", mode: "teachers" },
      },
    });
  }

  if (!placedIds.has("completion_teach")) {
    tiles.push({
      id: "browse_teach",
      family: "GENERIC",
      skillKeys: [],
      suggestion: {
        message: pick("browse_teach", [
          "Scan the skill list, you probably know something someone wants to learn.",
          "You likely know something worth teaching. Check who is learning on Explore.",
          "Teaching one session pays for one you take. See who is looking on Explore.",
        ]),
        type: "general",
        action: { kind: "explore", mode: "learners" },
      },
    });
  }

  if (!placedIds.has("completion_availability") && !placedIds.has("teach_availability")) {
    tiles.push({
      id: "keep_fresh",
      family: "GENERIC",
      skillKeys: [],
      suggestion: {
        message: pick("keep_fresh", [
          "Keep your availability up to date so booking always works first try.",
          "Fresh availability means faster bookings. Give yours a quick check.",
          "Worth a look at your weekly hours. Stale slots turn into declined requests.",
        ]),
        type: "general",
        action: { kind: "profile" },
      },
    });
  }

  return tiles;
}

// ── The pipeline (§6.2) ─────────────────────────────────────────────────────

function buildSuggestions(
  s: EngineSignals,
  userId: string,
  tzOffsetMinutes: number,
  rotation: number,
): Suggestion[] {
  // Stable per (user, LOCAL day, rotation): automatic loads never flicker,
  // because the client only bumps `rotation` when the user presses ⟳. Every
  // bump reseeds the copy variants AND shifts the candidate window below, so a
  // refresh is a genuinely different hand rather than the same four tiles.
  const dayIdx = localDayIndex(Date.now(), tzOffsetMinutes);
  const seedBase = `${userId}:${dayIdx}:${rotation}`;
  const pick: VariantPicker = (categoryId, variants) =>
    variants[fnv1a(`${seedBase}:${categoryId}`) % variants.length];

  const tiles: Tile[] = [];
  for (const item of completionMissing(s).slice(0, 4)) {
    tiles.push(completionTile(item, pick));
  }

  // Rotation reaches INSIDE each family as well as across them. Without this,
  // a user with (say) two in-demand skills and three trending skills would see
  // the same "1 learner wants Public Speaking" tile at every rotation, because
  // the DEMAND cap only ever admits the head of that list. Entering each list
  // at a different point is what makes ⟳ change what the tiles actually say,
  // as opposed to only reshuffling them.
  //
  // Order-independent reads (list lengths, the credit-balance floor, the
  // rank-sorted teacher picks) are unaffected by construction.
  const view: EngineSignals = {
    ...s,
    seekerCounts: rotate(s.seekerCounts, rotation),
    trendingSkills: rotate(s.trendingSkills, rotation),
    reciprocalMatches: rotate(s.reciprocalMatches, rotation),
    teachingSkills: rotate(s.teachingSkills, rotation),
  };

  // Growth candidates, ordered by the user's archetype.
  const order = ARCHETYPE_ORDER[archetypeOf(s)];
  const ranked: Tile[] = [
    momentumCandidate(view, pick),
    ...swapCandidates(view, pick),
    ...teacherCandidates(view, pick, rotation),
    ...demandCandidates(view, pick),
    progressionCandidate(view, pick),
    ...trendingCandidates(view, pick),
    ...trustCandidates(view, pick),
  ]
    .filter((c): c is Tile => c !== null)
    .sort((a, b) => priorityRank(a.id, order) - priorityRank(b.id, order));

  // Rotation walks the ranked list as a ring: rotation 0 offers the strongest
  // candidates first, rotation 1 starts one further down and wraps the skipped
  // one to the back, and so on. Nothing is ever dropped — the whole pool stays
  // reachable — but pressing ⟳ deals from a different point in the deck. This
  // is only meaningful because the caps below (one MOMENTUM, one DEMAND, one
  // PATH…) mean a typical pool holds more candidates than the four slots.
  const offset = ranked.length ? rotation % ranked.length : 0;
  const rotated = [...ranked.slice(offset), ...ranked.slice(0, offset)];

  // …with one exception: the ring must never rotate a direct swap out of the
  // batch. Swaps top every archetype order, so at rotation 0 one is already in
  // front — but at rotation 3 the ring would bury it behind three weaker tiles
  // and the caps could then eat the slot. Lifting the best remaining swap back
  // to the head keeps the "swap always wins" rule true at every rotation, while
  // rotation still decides WHICH partner it names (reciprocalMatches is rotated
  // in `view` above). Only the first is lifted: a second swap stays where the
  // ring put it, so the batch keeps room for a paid match too.
  const swapIdx = rotated.findIndex((t) => t.id.startsWith("swap"));
  const candidates =
    swapIdx > 0
      ? [rotated[swapIdx], ...rotated.filter((_, i) => i !== swapIdx)]
      : rotated;

  const familyCount = new Map<Family, number>();
  const usedIds = new Set<string>(tiles.map((t) => t.id));
  const usedSkills = new Set<string>();
  const usedPersons = new Set<string>();

  const tryPlace = (c: Tile): void => {
    if (tiles.length >= 4) return;
    if (usedIds.has(c.id)) return;
    if ((familyCount.get(c.family) ?? 0) >= FAMILY_CAPS[c.family]) return;
    if (c.skillKeys.some((k) => usedSkills.has(k))) return;
    if (c.personId && usedPersons.has(c.personId)) return;
    tiles.push(c);
    usedIds.add(c.id);
    familyCount.set(c.family, (familyCount.get(c.family) ?? 0) + 1);
    c.skillKeys.forEach((k) => usedSkills.add(k));
    if (c.personId) usedPersons.add(c.personId);
  };

  for (const c of candidates) tryPlace(c);
  for (const g of ladderTiles(s, tiles, pick)) tryPlace(g);

  return tiles.slice(0, 4).map((t) => t.suggestion);
}

// ─── HTTP handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight(req);
  const json = (status: number, body: Record<string, unknown>) => corsJson(req, status, body);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Unauthorized" });
    const user = userData.user;

    const body = (await req.json().catch(() => ({}))) as {
      force?: boolean;
      tzOffsetMinutes?: number;
      rotation?: number;
    };
    const force = body.force === true;
    // Manual-refresh counter owned by the client. Any non-negative integer is
    // valid; it only ever feeds a modulo, so it's clamped rather than
    // validated. Missing/garbage → 0, i.e. the strongest hand.
    const rotation =
      typeof body.rotation === "number" && Number.isFinite(body.rotation)
        ? Math.abs(Math.round(body.rotation)) % 10_000
        : 0;
    // getTimezoneOffset() is at most ±14h in the real world; anything else is a
    // malformed client and falls back to UTC math.
    const tzOffsetMinutes =
      typeof body.tzOffsetMinutes === "number" &&
      Number.isFinite(body.tzOffsetMinutes) &&
      Math.abs(body.tzOffsetMinutes) <= 900
        ? Math.round(body.tzOffsetMinutes)
        : 0;

    // Service-role client is used ONLY for the cache table writes (bypasses
    // RLS on `ai_suggestions`). All grounding-signal reads go through
    // `userClient` so they're constrained by the caller's RLS — that way a
    // bug here can't ever exfiltrate cross-user data the caller wouldn't
    // already be allowed to read via the normal API.
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Cache check + rate limit. Both branches read the cache row, so do it once
    // and decide what to do with it.
    const { data: cached } = await adminClient
      .from("ai_suggestions")
      .select("suggestions, generated_at, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!force && cached && new Date(cached.expires_at) > new Date()) {
      return json(200, {
        suggestions: cached.suggestions,
        cached: true,
        generatedAt: cached.generated_at,
      });
    }

    // Floor on regeneration, guarding the dozen DB reads from a stuck refresh
    // loop. A background load is floored at 60s — regenerating that often is
    // pointless because nothing it reads changes that fast. A user-driven ⟳
    // (force) gets a 2s floor instead: it carries a new `rotation` and MUST
    // produce different tiles, so serving the cached copy here is exactly the
    // "I pressed refresh five times and nothing changed" bug. 2s still absorbs
    // a double-click or a duplicated tab.
    //
    // Within the floor we serve the current tiles with a quiet 200 rather than
    // a 429 — the row is already in hand, so it costs nothing and avoids an
    // error toast.
    if (cached) {
      const ageMs = Date.now() - new Date(cached.generated_at).getTime();
      if (ageMs < (force ? 2_000 : 60_000)) {
        if (Array.isArray(cached.suggestions) && cached.suggestions.length > 0) {
          return json(200, {
            suggestions: cached.suggestions,
            cached: true,
            generatedAt: cached.generated_at,
          });
        }
        // Empty-suggestions row = the born-expired placeholder of a first
        // generation still in flight. Serving [] would blank the card, so a
        // short retry-after is the honest answer here.
        return corsJson(
          req,
          429,
          { error: "Suggestions are being generated. Try again in a few seconds.", retryAfter: 5 },
          { "Retry-After": "5" },
        );
      }
    }

    // ── In-flight dedupe ──────────────────────────────────────────────────
    // Two concurrent requests (double tab, dashboard + manual refresh racing)
    // would both reach this point. Claim the cache row atomically:
    //  - expired/forced regen: compare-and-swap generated_at — only the
    //    request that flips it proceeds; the loser serves the stale copy.
    //  - first-time: INSERT a placeholder row — the unique(user_id) constraint
    //    makes exactly one request win; the loser gets a short retry-after.
    const claimIso = new Date().toISOString();
    if (cached) {
      const { data: claimedRows, error: claimError } = await adminClient
        .from("ai_suggestions")
        .update({ generated_at: claimIso })
        .eq("user_id", user.id)
        .eq("generated_at", cached.generated_at)
        .select("user_id");
      if (claimError) {
        console.error("[generate-suggestions] claim update failed", claimError);
        return json(500, { error: "Internal error" });
      }
      if (!claimedRows || claimedRows.length === 0) {
        // Another request is regenerating right now — serve the previous copy.
        return json(200, {
          suggestions: cached.suggestions,
          cached: true,
          generatedAt: cached.generated_at,
        });
      }
    } else {
      const { error: claimError } = await adminClient.from("ai_suggestions").insert({
        user_id: user.id,
        suggestions: [],
        generated_at: claimIso,
        // Placeholder is born expired so it never serves as a real cache hit.
        expires_at: claimIso,
      });
      if (claimError) {
        // Unique violation: a concurrent first-time request won the claim.
        return corsJson(
          req,
          429,
          { error: "Suggestions are being generated. Try again in a few seconds.", retryAfter: 5 },
          { "Retry-After": "5" },
        );
      }
    }

    // Generate fresh — signals come from the user-scoped client so RLS, not
    // service-role trust, is the access boundary.
    const signals = await gatherSignals(userClient, user.id, tzOffsetMinutes);
    const suggestions = buildSuggestions(signals, user.id, tzOffsetMinutes, rotation);

    if (suggestions.length !== 4) {
      // Structurally impossible (see the ladder), but never cache a bad batch.
      console.error("[generate-suggestions] engine returned", suggestions.length, "tiles");
      return json(500, { error: "Could not generate suggestions" });
    }

    const generatedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();

    const { error: cacheError } = await adminClient.from("ai_suggestions").upsert({
      user_id: user.id,
      suggestions,
      generated_at: generatedAt,
      expires_at: expiresAt,
    });
    if (cacheError) {
      return json(500, { error: "Could not cache suggestions" });
    }

    return json(200, { suggestions, cached: false, generatedAt });
  } catch (error) {
    // Error messages can include request IDs or schema fragments. Log for ops,
    // return a generic message to clients.
    console.error("[generate-suggestions] unhandled error", error);
    return json(500, { error: "Internal error" });
  }
});
