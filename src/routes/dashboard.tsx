import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Children, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  Coins,
  Sparkles,
  GraduationCap,
  Users,
  HandHeart,
  Calendar,
  MessageCircle,
  ArrowRight,
  Lightbulb,
  Loader2,
  Check,
  X,
  Video,
  RefreshCw,
  ArrowLeftRight,
  TrendingUp,
  Megaphone,
  UserCircle2,
  Trophy,
  GitBranch,
  ChevronDown,
  Clock,
  Compass,
  Flame,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import {
  fetchAiSuggestions,
  inferExploreMode,
  invalidateAiSuggestionsCache,
  nextSuggestionsRotation,
  readCachedSuggestions,
  writeCachedSuggestions,
  type AiSuggestion,
} from "@/lib/ai-suggestions";
import { useFeatureEnabled } from "@/lib/feature-flags";
// Jitsi helpers are only needed on the accept-session path and to rewrite
// already-accepted meet links - both rare on a typical dashboard load. Lazy
// import keeps the (~small but non-zero) module out of the initial chunk.
const loadJitsi = () => import("@/lib/jitsi");
import {
  getOrCreateSession,
  requestSessionsForSlots,
  canJoinSession,
  describeJoinWindow,
  type SessionDuration,
} from "@/lib/sessions";
import { playRequestSentChime, playCancelChime } from "@/lib/sounds";
import { warmBookingDialogs } from "@/lib/warm-dialog-chunks";
import { markSelfAction } from "@/lib/self-action";
import { fetchTeacherRatings, type TeacherRating } from "@/lib/ratings";
import { loadVerifiedPairs, verifiedPairKey } from "@/lib/skill-verification";
import { VerifiedTick } from "@/components/VerifiedTick";
import { ConfirmAction } from "@/components/ConfirmAction";
import { UpNextRescheduleActions } from "@/components/UpNextRescheduleActions";
import { UserAvatar } from "@/components/UserAvatar";
import { PageLoading } from "@/components/PageLoading";
import {
  NextMoveSkeleton,
  PeopleSectionSkeleton,
  SuggestionsSkeleton,
} from "@/components/DashboardSectionSkeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { signAvatarUrls } from "@/lib/avatars";
import { deriveMatchLabel, rankCandidate, type LearningMode, type SkillLevel } from "@/lib/match";
import type { Enums } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { useInvalidateMyCreditBalance, useMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { queryUserSessions } from "@/lib/session-queries";
import { SwapInbox } from "@/components/SwapInbox";
import { completeOnboarding } from "@/lib/onboarding";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

// Lazy: SessionRequestDialog pulls in react-day-picker via the Calendar UI.
// Keeping it out of the dashboard route chunk strips ~40-60kb from first paint
// since the dialog only mounts when a user actually opens it.
const SessionRequestDialog = lazy(() =>
  import("@/components/SessionRequestDialog").then((m) => ({ default: m.SessionRequestDialog })),
);
import type { MultiSessionParams } from "@/components/SessionRequestDialog";
// Lazy for the same reason - it pulls in the Calendar via TeacherSlotPicker.
const SwapProposalDialog = lazy(() =>
  import("@/components/SwapProposalDialog").then((m) => ({ default: m.SwapProposalDialog })),
);

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard | SkillSwap" }] }),
  component: DashboardPage,
});

const SUGGESTION_TYPE_META: Record<
  AiSuggestion["type"],
  { icon: typeof Lightbulb; bg: string; fg: string }
> = {
  swap: {
    icon: ArrowLeftRight,
    bg: "bg-violet-500/15",
    fg: "text-violet-400",
  },
  match: {
    icon: HandHeart,
    bg: "bg-emerald-500/15",
    fg: "text-emerald-400",
  },
  momentum: {
    icon: Trophy,
    bg: "bg-amber-500/15",
    fg: "text-amber-400",
  },
  trending: {
    icon: TrendingUp,
    bg: "bg-rose-500/15",
    fg: "text-rose-400",
  },
  // Demand tiles ("N learners waiting for X") used to be typed `trending`,
  // which meant two cards in the same batch could show the same arrow.
  demand: {
    icon: Megaphone,
    bg: "bg-orange-500/15",
    fg: "text-orange-400",
  },
  progression: {
    icon: GitBranch,
    bg: "bg-sky-500/15",
    fg: "text-sky-400",
  },
  profile: {
    icon: UserCircle2,
    bg: "bg-fuchsia-500/15",
    fg: "text-fuchsia-400",
  },
  general: {
    icon: Lightbulb,
    bg: "gradient-brand-soft",
    fg: "text-brand-cyan",
  },
};

// `credits` deliberately not stored here. The single source of truth for the
// live balance is `useMyCreditBalance()` (TanStack Query + realtime). Keeping
// a copy on Profile created a second value that drifted whenever realtime
// updated the query but the local Profile object stayed stale.
type Profile = {
  id: string;
  full_name: string | null;
  bio: string | null;
  onboarded: boolean;
  learning_mode: LearningMode | null;
};

type ProfileSummary = {
  full_name: string;
  learning_mode: LearningMode | null;
  avatar_url: string | null;
  updated_at: string | null;
};

type LearnRow = {
  id: string;
  skill_id: string;
  current_level: string;
  learning_mode: LearningMode | null;
  skills: { id: string; name: string } | null;
};

type TeachOffer = {
  id: string;
  level: string;
  credits_per_hour: number;
  user_id: string;
  skill_id: string;
  skills: { id: string; name: string } | null;
  profiles: { id: string; full_name: string | null; avatar_url: string | null } | null;
  teaching_mode: LearningMode | null;
};

type Seeker = {
  id: string;
  user_id: string;
  skill_id: string;
  current_level: string;
  learning_mode: LearningMode | null;
  skills: { id: string; name: string } | null;
  profiles: { id: string; full_name: string | null; avatar_url: string | null } | null;
};

type SessionStatus = Enums<"session_status">;

type SessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  initiator_id: string | null;
  skill_id: string;
  status: SessionStatus;
  credits: number;
  duration_minutes: number;
  scheduled_at: string | null;
  meet_link: string | null;
  created_at: string;
  is_swap?: boolean;
  swap_id?: string | null;
  batch_id?: string | null;
  skills: { id: string; name: string } | null;
  learnerName: string;
  teacherName: string;
};

async function queryDashboardSessionRows(userId: string) {
  return queryUserSessions({
    userId,
    statuses: ["pending", "accepted", "active", "pending_review", "disputed"],
  });
}

// How long a hover-prefetched teaching row stays usable. Long enough to cover
// hover → read → click, short enough that a price the teacher just changed
// can't be what the booking dialog opens on.
const BOOK_OFFER_TTL_MS = 60_000;

const DASHBOARD_CACHE_PREFIX = "skillswap-dashboard-cache";
const DASHBOARD_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type DashboardCache = {
  savedAt: number;
  profile: Profile;
  learning: LearnRow[];
  teachers: TeachOffer[];
  seekers: Seeker[];
  myTeaching: {
    skill_id: string;
    level: string;
    teaching_mode: LearningMode | null;
    skills: { name: string } | null;
  }[];
  sessions: SessionRow[];
  recs: AiSuggestion[] | null;
  teacherRatings: [string, TeacherRating][];
  // Serialized verifiedPairKey() entries - restored alongside `teachers` so the
  // cached tiles paint with their ticks instead of growing one a moment later.
  verifiedPairs: string[];
  streak: number;
};

function getDashboardCache(userId: string) {
  try {
    const raw = sessionStorage.getItem(`${DASHBOARD_CACHE_PREFIX}-${userId}`);
    if (!raw) return null;
    const cache = JSON.parse(raw) as DashboardCache;
    if (Date.now() - cache.savedAt > DASHBOARD_CACHE_MAX_AGE_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function setDashboardCache(userId: string, cache: Omit<DashboardCache, "savedAt">) {
  try {
    sessionStorage.setItem(
      `${DASHBOARD_CACHE_PREFIX}-${userId}`,
      JSON.stringify({ ...cache, savedAt: Date.now() }),
    );
  } catch {
    // Cache is only a speed boost; ignore quota/private-mode failures.
  }
}

// Patches only the `recs` field of an existing snapshot, so the next mount
// rehydrates the suggestions the user is looking at right now rather than the
// previous session's. Suggestions arrive on their own schedule - earlier than
// the full snapshot write on a cold load, long after it on a manual ⟳ - so a
// targeted patch is the only safe write. No-op when there's no snapshot yet:
// the full write that follows picks the value up from recsRef.
function cacheRecs(userId: string | undefined, recs: AiSuggestion[]) {
  // The localStorage copy is written unconditionally: it is what a brand-new
  // tab (empty sessionStorage) rehydrates from, so it must survive even when
  // there is no dashboard snapshot to patch.
  writeCachedSuggestions(userId, recs);
  if (!userId) return;
  const snapshot = getDashboardCache(userId);
  if (!snapshot) return;
  const { savedAt: _savedAt, ...rest } = snapshot;
  setDashboardCache(userId, { ...rest, recs });
}

// 128x128 covers 2x DPR on the 40-64px avatar slots used across the dashboard
// (top-match tiles, seeker cards). Without the transform, every avatar
// downloads at its 400-800px upload size - the Lighthouse report flagged
// ~88 KB per tile for ~55px circles.
const AVATAR_TRANSFORM = { width: 128, height: 128, quality: 75, resize: "cover" } as const;

// Row fetch only - deliberately does NOT sign avatars. The candidate pool is up
// to 100 people per direction but we render at most ~8 of them, and the signer
// costs one HTTP roundtrip per uncached avatar (Storage's batch endpoint can't
// take a transform). Signing the whole pool put ~200 requests on the critical
// path before "Top matches" could paint. Ranking only needs full_name /
// learning_mode / updated_at, so the pool gets raw storage paths and the
// survivors get signed by attachSignedAvatars() after the cut.
async function loadProfileSummaries(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids));
  const profileMap = new Map<string, ProfileSummary>();
  if (!uniqueIds.length) return profileMap;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, learning_mode, avatar_url, updated_at")
    .in("id", uniqueIds);
  // Profiles decorate the match tiles; a failure shouldn't kill the dashboard,
  // but it shouldn't be invisible either.
  if (error) console.error("[dashboard] loadProfileSummaries failed:", error);
  for (const person of data ?? []) {
    profileMap.set(person.id, {
      full_name: person.full_name ?? "Student",
      learning_mode: person.learning_mode ?? null,
      // Storage path, not a URL yet - see attachSignedAvatars.
      avatar_url: person.avatar_url ?? null,
      updated_at: person.updated_at ?? null,
    });
  }
  return profileMap;
}

// Swaps each row's raw storage path for a signed, downscaled URL. Called with
// the post-rank slice only, so the fan-out is ~10 requests instead of ~100.
// Rows whose avatar fails to sign keep a null url and fall back to initials.
async function attachSignedAvatars<
  T extends {
    profiles: { id: string; full_name: string | null; avatar_url: string | null } | null;
  },
>(rows: T[]): Promise<T[]> {
  const signedUrlMap = await signAvatarUrls(
    rows.map((row) => row.profiles?.avatar_url),
    AVATAR_TRANSFORM,
  );
  return rows.map((row) => {
    const path = row.profiles?.avatar_url;
    if (!path || !row.profiles) return row;
    return { ...row, profiles: { ...row.profiles, avatar_url: signedUrlMap.get(path) ?? null } };
  });
}

async function loadCandidateLearningSkillIds(userIds: string[]) {
  const map = new Map<string, Set<string>>();
  if (!userIds.length) return map;
  const { data, error } = await supabase
    .from("user_learning_skills")
    .select("user_id, skill_id")
    .in("user_id", userIds);
  if (error) console.error("[dashboard] loadCandidateLearningSkillIds failed:", error);
  for (const row of data ?? []) {
    const set = map.get(row.user_id) ?? new Set<string>();
    set.add(row.skill_id);
    map.set(row.user_id, set);
  }
  return map;
}

async function loadCandidateTeachingSkillIds(userIds: string[]) {
  const map = new Map<string, Set<string>>();
  if (!userIds.length) return map;
  const { data, error } = await supabase
    .from("user_teaching_skills")
    .select("user_id, skill_id")
    .in("user_id", userIds);
  if (error) console.error("[dashboard] loadCandidateTeachingSkillIds failed:", error);
  for (const row of data ?? []) {
    const set = map.get(row.user_id) ?? new Set<string>();
    set.add(row.skill_id);
    map.set(row.user_id, set);
  }
  return map;
}

// Set once we've seen PostgREST say the RPC isn't in the schema cache - i.e.
// migration 20260530100000 hasn't been applied to this database. That answer
// can't change without a migration + reload, so re-asking on every load (and
// this runs twice per load, once per pipeline) only bought a guaranteed-404
// round trip in front of the fallback.
let completedCountsRpcMissing = false;

async function loadCompletedSessionCounts(userIds: string[]) {
  const counts = new Map<string, number>();
  if (!userIds.length) return counts;

  // Preferred path: one grouped RPC that counts in Postgres and returns just
  // (user_id, completed_count) instead of streaming back every completed-session
  // row for every candidate across two queries. SECURITY INVOKER, so it sees the
  // exact same rows the fallback queries below would - the ranking signal is
  // unchanged, only the round trips and payload shrink.
  if (!completedCountsRpcMissing) {
    const { data, error } = await supabase.rpc("completed_session_counts", {
      p_user_ids: userIds,
    });
    if (!error && data) {
      for (const row of data) {
        if (row.user_id) counts.set(row.user_id, Number(row.completed_count) || 0);
      }
      return counts;
    }
    // Only latch on "this function does not exist" (PGRST202 / 42883). A
    // transient failure must still retry the fast path next time.
    const raw = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();
    if (
      error?.code === "PGRST202" ||
      error?.code === "42883" ||
      raw.includes("could not find the function")
    ) {
      completedCountsRpcMissing = true;
    }
  }

  // Fallback: original two-query client-side tally. Keeps the dashboard working
  // if the RPC hasn't been applied to the DB yet (or errors), so deploying the
  // client and running the migration don't have to be perfectly in lockstep.
  // Capped: the count is only a ranking signal, so saturating at 2000 rows per
  // leg beats streaming every completed session ever recorded back to the
  // browser just to tally them.
  const [{ data: asTeacher }, { data: asLearner }] = await Promise.all([
    supabase
      .from("sessions")
      .select("teacher_id")
      .in("teacher_id", userIds)
      .eq("status", "completed")
      .limit(2000),
    supabase
      .from("sessions")
      .select("learner_id")
      .in("learner_id", userIds)
      .eq("status", "completed")
      .limit(2000),
  ]);
  for (const row of asTeacher ?? []) {
    if (!row.teacher_id) continue;
    counts.set(row.teacher_id, (counts.get(row.teacher_id) ?? 0) + 1);
  }
  for (const row of asLearner ?? []) {
    if (!row.learner_id) continue;
    counts.set(row.learner_id, (counts.get(row.learner_id) ?? 0) + 1);
  }
  return counts;
}

// Streak = consecutive days with at least one completed session, walking
// back from today. If today has no completed session yet we start from
// yesterday - the day isn't over, so a missing entry shouldn't kill the streak.
async function loadStreak(userId: string): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - 120);
  const { data } = await supabase
    .from("sessions")
    .select("scheduled_at")
    .or(`learner_id.eq.${userId},teacher_id.eq.${userId}`)
    .eq("status", "completed")
    .gte("scheduled_at", since.toISOString());

  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const days = new Set<string>();
  for (const row of data ?? []) {
    if (!row.scheduled_at) continue;
    const d = new Date(row.scheduled_at);
    if (Number.isNaN(d.getTime())) continue;
    days.add(dayKey(d));
  }
  if (!days.size) return 0;

  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!days.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor))) return 0;
  }
  let count = 0;
  while (days.has(dayKey(cursor))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

async function loadMyLearningSkills(userId: string) {
  const withMethod = await supabase
    .from("user_learning_skills")
    .select("id, skill_id, current_level, learning_mode, skills:skill_id(id, name)")
    .eq("user_id", userId);
  if (!withMethod.error) return (withMethod.data ?? []) as unknown as LearnRow[];

  const fallback = await supabase
    .from("user_learning_skills")
    .select("id, skill_id, current_level, skills:skill_id(id, name)")
    .eq("user_id", userId);
  return ((fallback.data ?? []) as unknown as LearnRow[]).map((row) => ({
    ...row,
    learning_mode: row.learning_mode ?? "mentorship",
  }));
}

async function loadMyTeachingSkills(userId: string) {
  const withMethod = await supabase
    .from("user_teaching_skills")
    .select("skill_id, level, teaching_mode, skills:skill_id(name)")
    .eq("user_id", userId);
  if (!withMethod.error) {
    return (withMethod.data ?? []) as unknown as {
      skill_id: string;
      level: string;
      teaching_mode: LearningMode | null;
      skills: { name: string } | null;
    }[];
  }

  const fallback = await supabase
    .from("user_teaching_skills")
    .select("skill_id, level, skills:skill_id(name)")
    .eq("user_id", userId);
  return (
    (fallback.data ?? []) as unknown as {
      skill_id: string;
      level: string;
      teaching_mode?: LearningMode | null;
      skills: { name: string } | null;
    }[]
  ).map((row) => ({ ...row, teaching_mode: row.teaching_mode ?? "teaching" }));
}

function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  // "Book again", the top-match tiles and the Up next reschedule button all
  // open code-split dialogs - fetch them while the dashboard is idle.
  useEffect(() => {
    warmBookingDialogs();
  }, []);
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  // Single source of truth shared with the header. Realtime push from
  // credit_transactions keeps this fresh without any manual fetch.
  const { data: liveCreditBalance } = useMyCreditBalance();
  const aiSuggestionsEnabled = useFeatureEnabled("features.ai_suggestions.enabled", true);
  // Mirror the two query-derived values into refs so loadDashboard can read the
  // latest without listing them as deps. Adding them to the useCallback deps
  // would change its identity when the credit query / feature flags resolve,
  // which the useEffect(loadDashboard) below would interpret as a reason to
  // re-run the entire dashboard load.
  const liveCreditBalanceRef = useRef(liveCreditBalance);
  liveCreditBalanceRef.current = liveCreditBalance;
  const aiSuggestionsEnabledRef = useRef(aiSuggestionsEnabled);
  aiSuggestionsEnabledRef.current = aiSuggestionsEnabled;
  // Who is signed in right now - lets a slow in-flight load detect that the
  // user changed underneath it and drop its results instead of painting them.
  const currentUserIdRef = useRef<string | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  // Mirror for loadDashboard's "keep the painted page, skip the skeleton"
  // check - reading `profile` directly would force it into the callback deps
  // and refire the whole load whenever the profile object is replaced.
  const profileRef = useRef<Profile | null>(null);
  profileRef.current = profile;
  const [learning, setLearning] = useState<LearnRow[]>([]);
  const [teachers, setTeachers] = useState<TeachOffer[]>([]);
  // teacher_id → next free slot the teacher offers (or null = no free
  // `teach` time posted / fully booked in the 7-day horizon). Value isn't read
  // on this page anymore (the availability chip was removed); the setter stays
  // so the availability fetch still feeds match ranking. Prefixed with `_` to
  // opt out of the unused-vars lint.
  const [_teacherAvailability, setTeacherAvailability] = useState<Map<string, string | null>>(
    new Map(),
  );
  const [seekers, setSeekers] = useState<Seeker[]>([]);
  const [myTeaching, setMyTeaching] = useState<
    {
      skill_id: string;
      level: string;
      teaching_mode: LearningMode | null;
      skills: { name: string } | null;
    }[]
  >([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  // The user a swap is being proposed to (opens SwapProposalDialog). Driven by
  // the reciprocal-match AI suggestion tile. The skill names let the dialog
  // pre-select the exact legs the suggestion named ("Swap Figma for Guitar")
  // instead of defaulting to the first overlap.
  const [swapTarget, setSwapTarget] = useState<SwapTileTarget | null>(null);
  // Bumped whenever the sessions realtime channel fires (or a swap is
  // proposed) so SwapInbox refetches - it manages its own data and would
  // otherwise only load on mount.
  const [swapRefresh, setSwapRefresh] = useState(0);
  const [streak, setStreak] = useState(0);
  const [recs, setRecs] = useState<AiSuggestion[] | null>(null);
  // Mirror so loadDashboard can persist the latest suggestions into the cache
  // without listing `recs` as a dep (which would refire the whole load every
  // time suggestions resolve).
  const recsRef = useRef<AiSuggestion[] | null>(null);
  recsRef.current = recs;
  const [recsRefreshing, setRecsRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  // True once the live teacher/seeker query has resolved this mount. The
  // dashboard cache deliberately does NOT pre-paint teachers/seekers because
  // their ranking depends on availability data that arrives separately -
  // hydrating from cache produced a visible flicker on refresh (Top Match
  // tile A → tile B once live data landed). Keeping these lists unhydrated
  // and showing a skeleton in NextMoveCard is the right trade.
  const [matchesHydrated, setMatchesHydrated] = useState(false);
  // Same idea for the session pipeline. "Your Next Move" is built from sessions
  // AND teachers, so it can only be trusted once both have landed - without
  // this, a fast teacher pipeline paints "Top match for you" and the sessions
  // arriving a moment later shove an "Action needed" card in above it.
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  // State value isn't read anywhere on this page - the setter exists only so
  // cache hydration can persist the rating map for next mount. Prefixed with
  // `_` to opt out of the unused-vars lint without breaking the cache wire-up.
  const [_teacherRatings, setTeacherRatings] = useState<Map<string, TeacherRating>>(new Map());
  // "user_id:skill_id" for every verified teaching skill among the matched
  // teachers, so their tick shows here the same way it does on their profile.
  const [verifiedPairs, setVerifiedPairs] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [requestDialog, setRequestDialog] = useState<
    | { kind: "request"; teacher: TeachOffer }
    | { kind: "offer"; seeker: Seeker; creditsPerHour: number }
    | null
  >(null);
  // bookTileKey() of the suggestion tile whose teaching-row lookup is in
  // flight, so that one tile shows a spinner instead of the whole card.
  const [bookingTileKey, setBookingTileKey] = useState<string | null>(null);
  // bookTileKey() → the in-flight/resolved teaching row behind a suggestion
  // tile. Filled on hover or focus (the tiles are buttons now, so the router's
  // preload="intent" no longer applies) so the click itself opens the dialog.
  const bookOfferCache = useRef(new Map<string, { at: number; row: Promise<TeachOffer | null> }>());
  // Gate to prevent the dashboard skeleton from painting before we know the
  // user finished onboarding. Without this, a brand-new OAuth user - e.g. a
  // GitHub signup that lands here because Supabase's project redirect URLs
  // point straight at /dashboard rather than /auth/callback - sees the
  // dashboard layout flash for ~300ms while loadDashboard fetches the profile
  // and detects onboarded=false, then bounces to /onboarding. Showing a
  // neutral spinner until the onboarded flag is verified makes the transition
  // visually continuous from the OAuth handoff into /onboarding.
  const [onboardingGateReady, setOnboardingGateReady] = useState(false);

  const markBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const clearBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // The Message and Request/Offer buttons on a person card both belong to the
  // same row id. Without a distinct key the in-flight spinner from one action
  // would light up the other button too. Suffixing the message action's busy
  // key keeps the two buttons independent.
  const messageBusyKey = (id: string) => `${id}:message`;

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/dashboard" } });
    }
    // user?.id only - auth events rotate the user object reference even when
    // the underlying user hasn't changed, which previously refired this and
    // every other [user] effect on the page 3× during bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id, navigate]);

  // The onboarding gate is opened by `loadDashboard` as soon as it confirms
  // `profile.onboarded` is true (or by cache hydration below for returning
  // users). The dedicated pre-check effect that previously fired a separate
  // `select onboarded` roundtrip was removed because loadDashboard fetches
  // the same column on its first read - keeping the pre-check duplicated work
  // and pushed first paint behind an extra serial roundtrip.

  useEffect(() => {
    if (!user) return;
    const cache = getDashboardCache(user.id);
    // Suggestions rehydrate even when there is no snapshot. Their own copy
    // lives in localStorage rather than sessionStorage, so a freshly opened
    // tab - the load the Edge Function round trip is most visible on - still
    // paints the tiles the user last saw instead of a skeleton.
    // Assigned unconditionally (not just when there's something to show) so
    // switching accounts in one tab clears the previous user's tiles instead of
    // leaving them up until the new user's fetch lands.
    const lastRecs = cache?.recs ?? readCachedSuggestions(user.id);
    setRecs(lastRecs?.length ? lastRecs : null);
    if (!cache) return;

    // Cached profiles are only ever written after a successful dashboard load,
    // which implies onboarded=true. Trust it to open the gate synchronously so
    // returning users skip the spinner entirely.
    if (cache.profile?.onboarded) setOnboardingGateReady(true);
    setProfile(cache.profile);
    setLearning(cache.learning ?? []);
    // Matches ARE restored from cache now. They used to be held back because a
    // cached order could visibly re-shuffle once availability landed - but what
    // we cache is the FINAL ordering (verified tier → availability → score),
    // the exact same list the live load recomputes. So the cached order equals
    // the incoming order unless the underlying data actually changed, and
    // returning users skip the skeleton entirely instead of waiting out a full
    // round of queries to see a list we already had.
    if (cache.teachers?.length) {
      setTeachers(cache.teachers);
      setVerifiedPairs(new Set(cache.verifiedPairs ?? []));
      setMatchesHydrated(true);
    }
    setSeekers(cache.seekers ?? []);
    setMyTeaching(cache.myTeaching ?? []);
    if (Array.isArray(cache.sessions)) {
      setSessions(cache.sessions);
      // An empty array is a real answer here ("you have no live sessions"),
      // unlike the teachers list - so key off the array's presence, not length.
      setSessionsHydrated(true);
    }
    setStreak(cache.streak ?? 0);
    setTeacherRatings(new Map(cache.teacherRatings ?? []));
    setLoading(false);
    // user?.id only - see the auth-rotation note on the login-redirect effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Collapse overlapping loads: a realtime burst arriving while a load is
  // already running queues exactly one trailing rerun instead of racing a
  // second full pipeline whose phases interleave with the first.
  const loadInFlightRef = useRef<string | null>(null);
  const loadQueuedRef = useRef(false);

  const loadDashboard = useCallback(async () => {
    if (!user) return;
    const uid = user.id;
    currentUserIdRef.current = uid;
    if (loadInFlightRef.current === uid) {
      loadQueuedRef.current = true;
      return;
    }
    loadInFlightRef.current = uid;
    const stale = () => currentUserIdRef.current !== uid;
    // auto_complete_due_sessions / notify_upcoming_sessions are now run on a
    // schedule (pg_cron or an external worker using the service role) rather
    // than fired from every dashboard load. The grants were tightened in
    // migration 20260511040000_lock_sweep_rpcs_to_service_role.sql.
    setLoading((current) => (profileRef.current ? false : current));
    try {
      // Phase 1+2: fire every independent read in parallel. Profile resolves
      // first so we can short-circuit on !onboarded, but the rest race in the
      // background instead of waiting for the second wave.
      const profilePromise = supabase
        .from("profiles")
        .select("id, full_name, bio, onboarded, learning_mode")
        .eq("id", user.id)
        .maybeSingle();
      // Credit balance is no longer fetched here - useMyCreditBalance() already
      // owns that RPC (shared with the header, kept fresh via realtime). We read
      // its cached value off liveCreditBalanceRef when ranking below, dropping
      // one redundant my_credit_balance() call per dashboard load.
      // Suggestions ride out with this first wave instead of waiting for the
      // profile read to resolve. The Edge Function re-authenticates and reads
      // its own cache row before it can answer, so parking it behind one more
      // serial round trip was the difference between the card landing with the
      // page and landing visibly after it. The rejection handler is attached
      // here, not at the consumer below, because several paths return early -
      // without it those would leave an unhandled rejection behind.
      const suggestionsPromise = aiSuggestionsEnabledRef.current
        ? fetchAiSuggestions().then(
            (r) => r.suggestions,
            // null = "ask failed", distinct from an empty batch. The consumer
            // uses it to keep whatever tiles are already painted.
            () => null,
          )
        : null;
      const learnPromise = loadMyLearningSkills(user.id);
      const myTeachPromise = loadMyTeachingSkills(user.id);
      const sessionsPromise = queryDashboardSessionRows(user.id);
      // .catch here (not at the await sites) because this promise is now
      // consumed in two places - a fire-and-forget setStreak below and the
      // cache write at the end. Without it, the fire-and-forget leg would be
      // an unhandled rejection. loadStreak swallows query errors already, so
      // this only guards against an unexpected throw.
      const streakPromise = loadStreak(user.id).catch(() => 0);

      const { data: p, error: profileError } = await profilePromise;
      if (stale()) return;
      if (profileError) throw profileError;

      if (!p) {
        toast.error("Your profile is still being prepared. Please finish onboarding.");
        setProfile(null);
        setLoading(false);
        navigate({ to: "/onboarding" });
        return;
      }

      if (!p.onboarded) {
        const [{ data: existingTeaching }, { data: existingLearning }] = await Promise.all([
          supabase.from("user_teaching_skills").select("id").eq("user_id", user.id).limit(1),
          supabase.from("user_learning_skills").select("id").eq("user_id", user.id).limit(1),
        ]);

        // Auto-flip onboarded only if step 1 (full_name) was completed too.
        // Without this, a user who saved a skill in step 2 but bailed on step 1
        // gets quietly promoted to "fully onboarded" with no display name and
        // no bio - the dashboard hero ends up rendering "Welcome back, Friend".
        const hasSkills =
          (existingTeaching?.length ?? 0) > 0 || (existingLearning?.length ?? 0) > 0;
        const hasName = Boolean(p.full_name && p.full_name.trim());

        if (hasSkills && hasName) {
          // Server-side complete_onboarding re-checks the same conditions
          // before flipping the flag - see the migration that locks the
          // column down. We still pre-check on the client so we don't
          // bounce a brand-new user through a doomed RPC call.
          const { error: onboardedFlipError } = await completeOnboarding(user.id);
          if (onboardedFlipError) {
            console.error("[dashboard] failed to flip onboarded flag", onboardedFlipError);
            setLoading(false);
            navigate({ to: "/onboarding" });
            return;
          }
          p.onboarded = true;
        } else {
          setLoading(false);
          navigate({ to: "/onboarding" });
          return;
        }
      }
      setProfile(p as Profile);
      // Open the gate the moment we know onboarded=true so the skeleton can
      // paint without waiting for the rest of the pipeline.
      setOnboardingGateReady(true);
      // Only join the suggestions call now - it has been in flight since the
      // top of this function, alongside the profile read.
      if (suggestionsPromise) {
        void suggestionsPromise.then((suggestions) => {
          if (stale()) return;
          if (!suggestions) {
            // The call failed. Tiles restored from the local copy are better
            // than blanking the card, so only fall back to "hide it" when
            // there is nothing painted to keep.
            setRecs((current) => current ?? []);
            return;
          }
          setRecs(suggestions);
          // Keep the mirror in step immediately: the snapshot write further
          // down reads recsRef, and it can run before React re-renders.
          recsRef.current = suggestions;
          cacheRecs(uid, suggestions);
        });
      }

      // Only the two skill lists gate phase 3 - they're what the teacher and
      // seeker queries filter on. The sessions read (a participant OR-filter
      // that walks the SELECT-fallback ladder) and the 120-day streak scan
      // feed other parts of the page entirely, so awaiting all four together
      // parked "Top matches" behind whichever of the four was slowest. They
      // stay in flight and land in their own sections below.
      const [learn, myTeach] = await Promise.all([learnPromise, myTeachPromise]);
      if (stale()) return;

      // Streak only drives the hero chip; paint it the moment its own query
      // returns instead of holding the match pipelines for it.
      void streakPromise.then((count) => {
        if (!stale()) setStreak(count);
      });

      const learnRows = learn ?? [];
      setLearning(learnRows);
      const myTeachRows = myTeach ?? [];
      setMyTeaching(myTeachRows);

      // Paint here, not after every pipeline below has settled. This is the
      // earliest point at which the page can render without contradicting
      // itself later: the hero's secondary CTA reads myTeaching, and these two
      // lists were fired alongside the profile read, so waiting for them costs
      // nothing beyond the wave we already awaited. Everything still in flight
      // (matches, sessions, seekers, suggestions) feeds a section that owns a
      // placeholder shaped like its real shell, so they fill in without moving
      // the page. Holding the whole route behind the slowest of them was what
      // produced a long generic grey screen followed by one full-page swap.
      setLoading(false);

      // Phase 3: teachers, seekers, session-participant names. These three
      // share no data - running them in Promise.all means the slowest leg
      // dominates instead of all three summing.
      const myCredits = liveCreditBalanceRef.current ?? null;
      const learnSkillIds = learnRows.map((l) => l.skill_id);
      const teachSkillIds = myTeachRows.map((s) => s.skill_id);

      const teacherPipeline = (async () => {
        if (!learnSkillIds.length) {
          return {
            list: [] as TeachOffer[],
            ratings: new Map<string, TeacherRating>(),
            availability: new Map<string, string | null>(),
            verified: new Set<string>(),
          };
        }
        // Candidate pool for the rank-sort. Ordered newest-first so the cut is
        // deterministic instead of whatever insertion order the planner
        // returns; 100 keeps the fan-out queries (profiles/ratings/counts)
        // cheap while giving the ranker a real pool to pick its top 10 from.
        let teacherResult = await supabase
          .from("user_teaching_skills")
          .select(
            "id, skill_id, level, credits_per_hour, user_id, teaching_mode, skills:skill_id(id, name)",
          )
          .in("skill_id", learnSkillIds)
          .neq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        if (teacherResult.error) {
          teacherResult = (await supabase
            .from("user_teaching_skills")
            .select("id, skill_id, level, credits_per_hour, user_id, skills:skill_id(id, name)")
            .in("skill_id", learnSkillIds)
            .neq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(100)) as unknown as typeof teacherResult;
        }
        if (teacherResult.error) throw teacherResult.error;
        const { data: t } = teacherResult;
        const teacherRows = (t ?? []) as unknown as TeachOffer[];
        if (!teacherRows.length) {
          return {
            list: [] as TeachOffer[],
            ratings: new Map<string, TeacherRating>(),
            availability: new Map<string, string | null>(),
            verified: new Set<string>(),
          };
        }
        const teacherUserIds = Array.from(new Set(teacherRows.map((row) => row.user_id)));
        // Wave 1 - the cheap fan-out. Every one of these is a single indexed
        // query over the candidate pool, and the ranker needs all of them
        // before it can cut the pool down. teachers_free_time_status is NOT
        // here on purpose: it loops get_teacher_windows once per teacher in
        // plpgsql, so running it across 100 candidates was the single slowest
        // thing on the dashboard. It only feeds the final ordering, so it now
        // runs in wave 2 against the ~10 rows that survive the cut.
        const [
          teacherProfiles,
          teacherRatingMap,
          teacherLearningMap,
          teacherSessionsMap,
          verified,
        ] = await Promise.all([
          loadProfileSummaries(teacherUserIds),
          fetchTeacherRatings(teacherUserIds),
          loadCandidateLearningSkillIds(teacherUserIds),
          loadCompletedSessionCounts(teacherUserIds),
          loadVerifiedPairs(teacherUserIds),
        ]);
        const myTeachSkillIdSetForRanking = new Set(myTeachRows.map((row) => row.skill_id));
        // A verified tick means this person passed the quiz for THIS skill, not
        // merely that they hold a badge somewhere. It outranks every other
        // signal: verified teachers occupy the top of the list, and the score
        // only decides the order within each tier. Applied here rather than
        // after the slice so a verified teacher sitting at rank 40 of the pool
        // still surfaces.
        const verifiedTier = (row: { user_id: string; skill_id: string }) =>
          verified.has(verifiedPairKey(row.user_id, row.skill_id)) ? 0 : 1;
        const ranked = teacherRows
          .map((row) => {
            const summary = teacherProfiles.get(row.user_id);
            return {
              ...row,
              profiles: {
                id: row.user_id,
                full_name: summary?.full_name ?? "Student",
                avatar_url: summary?.avatar_url ?? null,
              },
              teaching_mode: row.teaching_mode ?? summary?.learning_mode ?? "teaching",
            };
          })
          .sort((a, b) => {
            const tier = verifiedTier(a) - verifiedTier(b);
            if (tier !== 0) return tier;
            const aLearn = learnRows.find((row) => row.skill_id === a.skill_id);
            const bLearn = learnRows.find((row) => row.skill_id === b.skill_id);
            const aReciprocal = Array.from(teacherLearningMap.get(a.user_id) ?? []).some((id) =>
              myTeachSkillIdSetForRanking.has(id),
            );
            const bReciprocal = Array.from(teacherLearningMap.get(b.user_id) ?? []).some((id) =>
              myTeachSkillIdSetForRanking.has(id),
            );
            const aScore = rankCandidate({
              direction: "teacher",
              myMode: aLearn?.learning_mode,
              theirMode: a.teaching_mode,
              myLevel: aLearn?.current_level as SkillLevel | undefined,
              theirLevel: a.level as SkillLevel | undefined,
              rating: teacherRatingMap.get(a.user_id)?.average ?? null,
              completedSessions: teacherSessionsMap.get(a.user_id) ?? 0,
              profileUpdatedAt: teacherProfiles.get(a.user_id)?.updated_at ?? null,
              myCredits,
              theirCreditsPerHour: a.credits_per_hour,
              reciprocal: aReciprocal,
              candidateId: a.user_id + ":" + a.skill_id,
              viewerId: user.id,
            }).total;
            const bScore = rankCandidate({
              direction: "teacher",
              myMode: bLearn?.learning_mode,
              theirMode: b.teaching_mode,
              myLevel: bLearn?.current_level as SkillLevel | undefined,
              theirLevel: b.level as SkillLevel | undefined,
              rating: teacherRatingMap.get(b.user_id)?.average ?? null,
              completedSessions: teacherSessionsMap.get(b.user_id) ?? 0,
              profileUpdatedAt: teacherProfiles.get(b.user_id)?.updated_at ?? null,
              myCredits,
              theirCreditsPerHour: b.credits_per_hour,
              reciprocal: bReciprocal,
              candidateId: b.user_id + ":" + b.skill_id,
              viewerId: user.id,
            }).total;
            return bScore - aScore;
          })
          .slice(0, 10);

        // Wave 2 - the expensive-per-row work, now paid for ~10 rows instead of
        // ~100: next-free-slot (a plpgsql loop over get_teacher_windows) and
        // avatar signing (one Storage roundtrip each). Both only matter for
        // rows we actually render, so scoping them to the cut is what turned
        // this pipeline from seconds into one short roundtrip.
        const rankedUserIds = Array.from(new Set(ranked.map((row) => row.user_id)));
        const [freeTimeRes, rankedWithAvatars] = await Promise.all([
          supabase.rpc("teachers_free_time_status", {
            p_teacher_ids: rankedUserIds,
            p_duration_minutes: 30,
            p_horizon_days: 7,
          }),
          attachSignedAvatars(ranked),
        ]);
        const availability = new Map<string, string | null>();
        for (const r of (freeTimeRes.data ?? []) as {
          teacher_id: string;
          next_slot: string | null;
        }[]) {
          availability.set(r.teacher_id, r.next_slot);
        }

        // Stable re-sort: within a verification tier, teachers with an upcoming
        // slot float to top, preserving the rank-sort order within each group.
        // The tier check comes first so availability can never pull an
        // unverified teacher above a verified one.
        const slotMs = (uid: string) => {
          const slot = availability.get(uid);
          if (!slot) return null;
          const ts = Date.parse(slot);
          return Number.isNaN(ts) ? null : ts;
        };
        const finalList = [...rankedWithAvatars].sort((a, b) => {
          const tier = verifiedTier(a) - verifiedTier(b);
          if (tier !== 0) return tier;
          const aSlot = slotMs(a.user_id);
          const bSlot = slotMs(b.user_id);
          if (aSlot != null && bSlot != null) return aSlot - bSlot;
          if (aSlot != null) return -1;
          if (bSlot != null) return 1;
          return 0;
        });
        return { list: finalList, ratings: teacherRatingMap, availability, verified };
      })();

      const seekerPipeline = (async () => {
        if (!teachSkillIds.length) return [] as Seeker[];
        // Same deterministic newest-first 100-row pool as the teacher pipeline.
        let seekerResult = await supabase
          .from("user_learning_skills")
          .select("id, user_id, skill_id, current_level, learning_mode, skills:skill_id(id, name)")
          .in("skill_id", teachSkillIds)
          .neq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        if (seekerResult.error) {
          seekerResult = (await supabase
            .from("user_learning_skills")
            .select("id, user_id, skill_id, current_level, skills:skill_id(id, name)")
            .in("skill_id", teachSkillIds)
            .neq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(100)) as unknown as typeof seekerResult;
        }
        if (seekerResult.error) throw seekerResult.error;
        const { data: s } = seekerResult;
        const seekerRows = (s ?? []) as unknown as Seeker[];
        if (!seekerRows.length) return [] as Seeker[];
        const seekerUserIds = Array.from(new Set(seekerRows.map((row) => row.user_id)));
        const [seekerProfiles, seekerTeachingMap, seekerSessionsMap] = await Promise.all([
          loadProfileSummaries(seekerUserIds),
          loadCandidateTeachingSkillIds(seekerUserIds),
          loadCompletedSessionCounts(seekerUserIds),
        ]);
        const myLearnSkillIdSetForRanking = new Set(learnRows.map((row) => row.skill_id));
        const myTeachLevelBySkill = new Map(myTeachRows.map((row) => [row.skill_id, row.level]));
        const rankedSeekers = seekerRows
          .map((row) => {
            const summary = seekerProfiles.get(row.user_id);
            return {
              ...row,
              profiles: {
                id: row.user_id,
                full_name: summary?.full_name ?? "Student",
                avatar_url: summary?.avatar_url ?? null,
              },
              learning_mode: row.learning_mode ?? summary?.learning_mode ?? "mentorship",
            };
          })
          .sort((a, b) => {
            const aTeach = myTeachRows.find((teach) => teach.skill_id === a.skill_id);
            const bTeach = myTeachRows.find((teach) => teach.skill_id === b.skill_id);
            const aReciprocal = Array.from(seekerTeachingMap.get(a.user_id) ?? []).some((id) =>
              myLearnSkillIdSetForRanking.has(id),
            );
            const bReciprocal = Array.from(seekerTeachingMap.get(b.user_id) ?? []).some((id) =>
              myLearnSkillIdSetForRanking.has(id),
            );
            const aScore = rankCandidate({
              direction: "seeker",
              myMode: aTeach?.teaching_mode,
              theirMode: a.learning_mode,
              myLevel: myTeachLevelBySkill.get(a.skill_id) as SkillLevel | undefined,
              theirLevel: a.current_level as SkillLevel | undefined,
              completedSessions: seekerSessionsMap.get(a.user_id) ?? 0,
              profileUpdatedAt: seekerProfiles.get(a.user_id)?.updated_at ?? null,
              reciprocal: aReciprocal,
              candidateId: a.user_id + ":" + a.skill_id,
              viewerId: user.id,
            }).total;
            const bScore = rankCandidate({
              direction: "seeker",
              myMode: bTeach?.teaching_mode,
              theirMode: b.learning_mode,
              myLevel: myTeachLevelBySkill.get(b.skill_id) as SkillLevel | undefined,
              theirLevel: b.current_level as SkillLevel | undefined,
              completedSessions: seekerSessionsMap.get(b.user_id) ?? 0,
              profileUpdatedAt: seekerProfiles.get(b.user_id)?.updated_at ?? null,
              reciprocal: bReciprocal,
              candidateId: b.user_id + ":" + b.skill_id,
              viewerId: user.id,
            }).total;
            return bScore - aScore;
          })
          .slice(0, 10);
        // Sign only the survivors - see attachSignedAvatars.
        return attachSignedAvatars(rankedSeekers);
      })();

      const sessionPipeline = (async () => {
        // Awaited here rather than up front so the teacher/seeker pipelines
        // don't sit behind this query - see the phase-2 note above.
        const allRawSessions = await sessionsPromise;
        // Swap sessions (is_swap) have a different, credit-free accept flow and
        // are surfaced separately in <SwapInbox>. Keep them out of the ordinary
        // session lists so their cards and accept buttons never mix in here.
        const rawSessions = allRawSessions.filter((s) => !s.is_swap);
        const participantIds = Array.from(
          new Set(rawSessions.flatMap((s) => [s.learner_id, s.teacher_id])),
        );
        // Jitsi helpers are only needed to rewrite meet links on already-
        // accepted/active sessions. If the user has none, skip the import.
        const needsJitsi = rawSessions.some(
          (s) => s.status === "accepted" || s.status === "active",
        );
        const [{ data: people }, jitsi] = await Promise.all([
          participantIds.length
            ? supabase.from("profiles").select("id, full_name").in("id", participantIds)
            : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
          needsJitsi ? loadJitsi() : Promise.resolve(null),
        ]);
        const profileMap = new Map<string, string>();
        for (const person of people ?? []) {
          profileMap.set(person.id, person.full_name ?? "Student");
        }
        const getVideoRoomUrl = jitsi?.getVideoRoomUrl;
        return rawSessions.map((s) => {
          const normalizedLink =
            (s.status === "accepted" || s.status === "active") && getVideoRoomUrl
              ? getVideoRoomUrl({
                  link: s.meet_link,
                  sessionId: s.id,
                  skillName: s.skills?.name,
                })
              : s.meet_link;
          return {
            ...s,
            meet_link: normalizedLink,
            learnerName: profileMap.get(s.learner_id) ?? "Student",
            teacherName: profileMap.get(s.teacher_id) ?? "Student",
          };
        });
      })();

      // The "Top matches" section renders teacher data only, so unblock its
      // skeleton the instant the teacher pipeline resolves - don't make it wait
      // on the seeker pipeline or the session pipeline (which dynamically
      // imports Jitsi). Each pipeline paints its own section as it lands.
      const teacherDone = teacherPipeline.then((outcome) => {
        if (stale()) return outcome;
        setTeacherRatings(outcome.ratings);
        setTeacherAvailability(outcome.availability);
        setVerifiedPairs(outcome.verified);
        setTeachers(outcome.list);
        setMatchesHydrated(true);
        return outcome;
      });
      const seekerDone = seekerPipeline.then((list) => {
        if (!stale()) setSeekers(list);
        return list;
      });
      const sessionDone = sessionPipeline.then((list) => {
        if (!stale()) {
          setSessions(list);
          setSessionsHydrated(true);
        }
        return list;
      });

      // streakPromise joins here only so the snapshot below can record it. By
      // now it has had the whole pipeline to resolve, so it costs nothing.
      const [teacherOutcome, seekerList, sessionList, streakCount] = await Promise.all([
        teacherDone,
        seekerDone,
        sessionDone,
        streakPromise,
      ]);
      if (stale()) return;

      setDashboardCache(user.id, {
        profile: p as Profile,
        learning: learnRows,
        teachers: teacherOutcome.list,
        seekers: seekerList,
        myTeaching: myTeachRows,
        sessions: sessionList,
        recs: recsRef.current,
        teacherRatings: Array.from(teacherOutcome.ratings.entries()),
        verifiedPairs: Array.from(teacherOutcome.verified),
        streak: streakCount,
      });
    } catch (error) {
      if (stale()) return;
      setLoading(false);
      // Keep any tiles already restored from the local copy - a failed
      // dashboard load says nothing about whether the suggestions are valid.
      setRecs((current) => current ?? []);
      setMatchesHydrated(true);
      // Release every section's placeholder, or a failed load leaves the
      // Next Move card spinning on a skeleton with no pipeline left to fill it.
      setSessionsHydrated(true);
      // Open the gate even on error so the user sees the skeleton + toast
      // instead of an indefinite spinner.
      setOnboardingGateReady(true);
      toastError(error, "Could not load dashboard");
    } finally {
      if (loadInFlightRef.current === uid) loadInFlightRef.current = null;
      if (loadQueuedRef.current) {
        loadQueuedRef.current = false;
        // A realtime event landed mid-load; run once more so its change isn't
        // lost. Skipped when the user changed - their own effect reloads.
        if (!stale()) void loadDashboard();
      }
    }
    // Stable across user-object rotations so useEffect(loadDashboard) below
    // only refires when the actual user changes, not on every auth event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, navigate]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // Keep the active sessions list live: a new request from another user, or a
  // status change made elsewhere, should appear without a manual refresh.
  // Debounce 250ms so a burst of postgres_changes from a single transaction
  // (accept → trigger → audit insert → notification insert) collapses into
  // one reload instead of three.
  const debouncedReloadDashboard = useDebouncedCallback(() => {
    setSwapRefresh((n) => n + 1);
    void loadDashboard();
  }, 250);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`dashboard-sessions-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `learner_id=eq.${user.id}`,
        },
        () => debouncedReloadDashboard(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `teacher_id=eq.${user.id}`,
        },
        () => debouncedReloadDashboard(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // user?.id only - see the auth-rotation note on the login-redirect effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, debouncedReloadDashboard]);

  const openRequestDialog = (teacher: TeachOffer) => {
    setRequestDialog({ kind: "request", teacher });
  };

  // Resolves the live teaching row behind a teacher-match suggestion, memoized
  // per tile so hover, focus and click share one roundtrip.
  //
  // The row is re-read rather than trusted from the tile: a cached suggestion
  // can be half an hour old, and the booking has to use the price the teacher
  // charges now. The TTL is what keeps that promise - an entry parked by a
  // hover can't outlive a price edit by more than a minute.
  const resolveBookOffer = useCallback((target: BookTileTarget): Promise<TeachOffer | null> => {
    const key = bookTileKey(target);
    const hit = bookOfferCache.current.get(key);
    if (hit && Date.now() - hit.at < BOOK_OFFER_TTL_MS) return hit.row;

    const row = (async (): Promise<TeachOffer | null> => {
      let skillId = target.skillId;
      if (!skillId && target.skillName) {
        // Tiles cached before the engine started sending skill ids carry only
        // the name. ilike without a wildcard is case-insensitive equality.
        const { data: skillRow } = await supabase
          .from("skills")
          .select("id")
          .eq("is_active", true)
          .ilike("name", target.skillName)
          .limit(1)
          .maybeSingle();
        skillId = skillRow?.id;
      }
      if (!skillId) return null;

      // The profile lookup doesn't depend on the teaching row, so both legs go
      // out together - the dialog needs the teacher's name for its footer.
      const [offerRes, summaries] = await Promise.all([
        supabase
          .from("user_teaching_skills")
          .select(
            "id, skill_id, level, credits_per_hour, user_id, teaching_mode, skills:skill_id(id, name)",
          )
          .eq("user_id", target.userId)
          .eq("skill_id", skillId)
          .limit(1)
          .maybeSingle(),
        loadProfileSummaries([target.userId]),
      ]);
      const offer = (offerRes.data ?? null) as unknown as Omit<TeachOffer, "profiles"> | null;
      if (!offer) return null;
      const summary = summaries.get(target.userId);
      return {
        ...offer,
        profiles: {
          id: target.userId,
          full_name: summary?.full_name ?? null,
          avatar_url: summary?.avatar_url ?? null,
        },
      };
    })().catch((error) => {
      // A failed lookup must not stay cached: the click falls back to the
      // profile, and the next hover gets a clean retry.
      console.error("[dashboard] suggestion booking lookup failed:", error);
      bookOfferCache.current.delete(key);
      return null;
    });

    bookOfferCache.current.set(key, { at: Date.now(), row });
    return row;
  }, []);

  // A teacher-match suggestion names a specific person AND the exact skill they
  // teach ("Sulav teaches Music Theory at 4 credits/hour. Book a session."), so
  // clicking it opens the booking dialog on that pair. The profile detour and
  // the second skill pick were steps the copy never promised.
  //
  // A row that no longer exists (they dropped the skill since the tile was
  // generated) falls back to their profile, which is still a sensible landing.
  const openBookingFromSuggestion = useCallback(
    async (target: BookTileTarget) => {
      setBookingTileKey(bookTileKey(target));
      try {
        const teacher = await resolveBookOffer(target);
        if (!teacher) {
          navigate({ to: "/users/$userId", params: { userId: target.userId } });
          return;
        }
        setRequestDialog({ kind: "request", teacher });
      } finally {
        setBookingTileKey(null);
      }
    },
    [navigate, resolveBookOffer],
  );

  // Pre-acceptance chat: opens (or creates) a pending session with the other
  // user and routes to /messages. The 15-msg/day + 5-unanswered caps are
  // enforced server-side by enforce_pending_message_caps (see migration
  // 20260526010000_pending_session_message_caps.sql), so the client just
  // needs a pending session to attach the messages to.
  const openChatWithTeacher = useCallback(
    async (teacher: TeachOffer) => {
      if (!user) return;
      const busyKey = messageBusyKey(teacher.id);
      markBusy(busyKey);
      try {
        const { sessionId, error } = await getOrCreateSession({
          learnerId: user.id,
          teacherId: teacher.user_id,
          initiatorId: user.id,
          skillId: teacher.skill_id,
          creditsPerHour: teacher.credits_per_hour,
          durationMinutes: 30,
          scheduledAt: null,
        });
        if (error) {
          toastError(error);
          return;
        }
        if (sessionId) navigate({ to: "/messages", search: { s: sessionId } });
      } finally {
        clearBusy(busyKey);
      }
    },
    [clearBusy, markBusy, navigate, user],
  );

  const openChatWithSeeker = useCallback(
    async (seeker: Seeker) => {
      if (!user) return;
      const busyKey = messageBusyKey(seeker.id);
      markBusy(busyKey);
      try {
        const { data: teachingSkill } = await supabase
          .from("user_teaching_skills")
          .select("credits_per_hour")
          .eq("user_id", user.id)
          .eq("skill_id", seeker.skill_id)
          .maybeSingle();
        const { sessionId, error } = await getOrCreateSession({
          learnerId: seeker.user_id,
          teacherId: user.id,
          initiatorId: user.id,
          skillId: seeker.skill_id,
          creditsPerHour: teachingSkill?.credits_per_hour ?? 4,
          durationMinutes: 30,
          scheduledAt: null,
        });
        if (error) {
          toastError(error);
          return;
        }
        if (sessionId) navigate({ to: "/messages", search: { s: sessionId } });
      } finally {
        clearBusy(busyKey);
      }
    },
    [clearBusy, markBusy, navigate, user],
  );

  // ⟳ deals a different hand rather than recomputing the same one: the engine
  // is deterministic per (user, day, rotation), so the counter has to advance
  // before the call. It's persisted client-side, so the tiles the user lands on
  // survive a reload - see nextSuggestionsRotation.
  const refreshSuggestions = async () => {
    if (recsRefreshing) return;
    setRecsRefreshing(true);
    try {
      const r = await fetchAiSuggestions({ force: true, rotation: nextSuggestionsRotation() });
      setRecs(r.suggestions);
      recsRef.current = r.suggestions;
      cacheRecs(user?.id, r.suggestions);
      toast.success("Suggestions refreshed");
    } catch (error) {
      toastError(error, "Could not refresh suggestions");
    } finally {
      setRecsRefreshing(false);
    }
  };

  const openOfferDialog = async (seeker: Seeker) => {
    if (!user) return;
    markBusy(seeker.id);
    try {
      const { data: teachingSkill } = await supabase
        .from("user_teaching_skills")
        .select("credits_per_hour")
        .eq("user_id", user.id)
        .eq("skill_id", seeker.skill_id)
        .maybeSingle();
      setRequestDialog({
        kind: "offer",
        seeker,
        creditsPerHour: teachingSkill?.credits_per_hour ?? 4,
      });
    } finally {
      clearBusy(seeker.id);
    }
  };

  const confirmRequestDialog = async (duration: SessionDuration, scheduledAt: string) => {
    if (!user || !requestDialog) return;
    const subjectId =
      requestDialog.kind === "request" ? requestDialog.teacher.id : requestDialog.seeker.id;
    markBusy(subjectId);
    try {
      const args =
        requestDialog.kind === "request"
          ? {
              learnerId: user.id,
              teacherId: requestDialog.teacher.user_id,
              initiatorId: user.id,
              skillId: requestDialog.teacher.skill_id,
              creditsPerHour: requestDialog.teacher.credits_per_hour,
            }
          : {
              learnerId: requestDialog.seeker.user_id,
              teacherId: user.id,
              initiatorId: user.id,
              skillId: requestDialog.seeker.skill_id,
              creditsPerHour: requestDialog.creditsPerHour,
            };
      const { error, created } = await getOrCreateSession({
        ...args,
        durationMinutes: duration,
        scheduledAt,
      });
      if (error) {
        toastError(error);
        return;
      }
      if (created) playRequestSentChime();
      toast.success(
        requestDialog.kind === "request"
          ? created
            ? "Session requested"
            : "You already have an open session for this skill"
          : created
            ? "Help offered"
            : "You already have an open session for this skill",
      );
      setRequestDialog(null);
      await loadDashboard();
    } finally {
      clearBusy(subjectId);
    }
  };

  // Multi-session path from the same dialog (request kind only): one ordinary
  // pending session per chosen slot, accepted individually by the teacher.
  const confirmRequestDialogMulti = async (params: MultiSessionParams) => {
    if (!user || !requestDialog || requestDialog.kind !== "request") return;
    const subjectId = requestDialog.teacher.id;
    markBusy(subjectId);
    try {
      const { created, error } = await requestSessionsForSlots({
        learnerId: user.id,
        teacherId: requestDialog.teacher.user_id,
        skillId: requestDialog.teacher.skill_id,
        creditsPerHour: requestDialog.teacher.credits_per_hour,
        durationMinutes: params.durationMinutes,
        startTimes: params.startTimes,
      });
      if (error) {
        toastError(error);
        return;
      }
      if (created > 0) {
        playRequestSentChime();
        toast.success(
          `Requested ${created} ${created === 1 ? "session" : "sessions"}. The teacher accepts each one.`,
        );
        setRequestDialog(null);
        await loadDashboard();
      }
    } finally {
      clearBusy(subjectId);
    }
  };

  const acceptSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { createVideoRoom } = await loadJitsi();
      const room = await createVideoRoom({
        sessionId: session.id,
        skillName: session.skills?.name,
      });
      const { error } = await supabase.rpc("accept_session", {
        p_session_id: session.id,
        p_meet_link: room.link,
      });
      if (error) return toastError(error);
      markSelfAction(session.id, ["session_accepted"]);
      toast.success(`Session accepted, ${session.credits} credits held in escrow`);
      void invalidateCreditBalance();
      await loadDashboard();
    } catch (error) {
      toastError(error, "Could not create Jitsi room");
    } finally {
      clearBusy(session.id);
    }
  };

  const rejectSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("reject_session", {
        p_session_id: session.id,
      });
      if (error) return toastError(error);
      markSelfAction(session.id, ["session_rejected"]);
      toast.success("Session rejected");
      void invalidateCreditBalance();
      await loadDashboard();
    } finally {
      clearBusy(session.id);
    }
  };

  // Accept every session in a multi-session request in one go. Each session
  // still gets its own Jitsi room and accept_session call (they're independent
  // rows); we just batch the busy-state, toast, and dashboard reload so the
  // teacher sees one smooth action instead of N. Failures on one session don't
  // abort the rest.
  const acceptSessions = async (sessions: SessionRow[]) => {
    if (sessions.length === 1) return acceptSession(sessions[0]);
    sessions.forEach((s) => markBusy(s.id));
    try {
      const { createVideoRoom } = await loadJitsi();
      let accepted = 0;
      for (const session of sessions) {
        try {
          const room = await createVideoRoom({
            sessionId: session.id,
            skillName: session.skills?.name,
          });
          const { error } = await supabase.rpc("accept_session", {
            p_session_id: session.id,
            p_meet_link: room.link,
          });
          if (error) {
            toastError(error);
            continue;
          }
          markSelfAction(session.id, ["session_accepted"]);
          accepted += 1;
        } catch (error) {
          toastError(error, "Could not create Jitsi room");
        }
      }
      if (accepted > 0) {
        toast.success(`Accepted ${accepted} ${accepted === 1 ? "session" : "sessions"}`);
        void invalidateCreditBalance();
      }
      await loadDashboard();
    } finally {
      sessions.forEach((s) => clearBusy(s.id));
    }
  };

  const rejectSessions = async (sessions: SessionRow[]) => {
    if (sessions.length === 1) return rejectSession(sessions[0]);
    sessions.forEach((s) => markBusy(s.id));
    try {
      let rejected = 0;
      for (const session of sessions) {
        const { error } = await supabase.rpc("reject_session", { p_session_id: session.id });
        if (error) {
          toastError(error);
          continue;
        }
        markSelfAction(session.id, ["session_rejected"]);
        rejected += 1;
      }
      if (rejected > 0) {
        toast.success(`Declined ${rejected} ${rejected === 1 ? "session" : "sessions"}`);
        void invalidateCreditBalance();
      }
      await loadDashboard();
    } finally {
      sessions.forEach((s) => clearBusy(s.id));
    }
  };

  const cancelSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("cancel_session", { p_session_id: session.id });
      if (error) return toastError(error);
      markSelfAction(session.id, ["session_cancelled"]);
      playCancelChime();
      toast.success("Session cancelled. Credits refunded.");
      void invalidateCreditBalance();
      await loadDashboard();
    } finally {
      clearBusy(session.id);
    }
  };

  const completeSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("complete_session", { p_session_id: session.id });
      if (error) return toastError(error);
      markSelfAction(session.id, ["session_completed"]);
      toast.success("Session completed and credits transferred");
      void invalidateCreditBalance();
      // Completion changes streak/momentum signals - regenerate suggestions.
      void invalidateAiSuggestionsCache();
      await loadDashboard();
    } finally {
      clearBusy(session.id);
    }
  };

  // Memoize the per-render derived state. Without this, realtime ticks /
  // busy-set updates / credit-balance pushes all re-run pickNextMoves and
  // both filter passes - wasted work because none of those inputs changed.
  // Calculated BEFORE the early returns to satisfy React's rules-of-hooks.
  // The fallback `user?.id ?? ""` keeps the hook stable on the unauthed
  // render path where `user` is null - the result is discarded by the early
  // return below anyway.
  const userId = user?.id ?? "";
  const nextMoves = useMemo(
    () => pickNextMoves(userId, sessions, teachers, learning),
    [userId, sessions, teachers, learning],
  );
  const featuredTeacherIds = useMemo(
    () =>
      new Set(nextMoves.flatMap((m) => (m.kind === "match" ? m.teachers.map((t) => t.id) : []))),
    [nextMoves],
  );
  const teachersForRow = useMemo(
    () =>
      featuredTeacherIds.size > 0
        ? teachers.filter((t) => !featuredTeacherIds.has(t.id))
        : teachers,
    [teachers, featuredTeacherIds],
  );
  // The Next Move stack already surfaces pending requests and the soonest upcoming
  // session. Drop them from the Active sessions strip so the same cards don't render twice.
  const featuredSessionIds = useMemo(
    () =>
      new Set(
        nextMoves.flatMap((m) =>
          m.kind === "incoming" || m.kind === "upcoming" ? m.sessions.map((s) => s.id) : [],
        ),
      ),
    [nextMoves],
  );
  const sessionsForStrip = useMemo(
    () =>
      featuredSessionIds.size > 0
        ? sessions.filter((s) => !featuredSessionIds.has(s.id))
        : sessions,
    [sessions, featuredSessionIds],
  );
  // Build a skill_id → learning row lookup once per render so the teacher
  // tile loop below doesn't run learning.find() on every iteration.
  // Hard auth gate: if we know the user is signed out, render nothing
  // protected. The useEffect above will navigate to /login on the next tick.
  // Without this early return, the skeleton structure (and any cached profile
  // from sessionStorage) could briefly paint before the redirect fires.
  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Render a neutral spinner - not the dashboard skeleton - until we've
  // verified the user is onboarded. Same visual treatment as /auth/callback so
  // the OAuth handoff into /onboarding is visually one continuous load.
  if (!onboardingGateReady) {
    return <PageLoading variant="simple" />;
  }

  // Whole-page fallback. `loading` now clears the moment the profile lands, so
  // in practice this only covers the frame before that. It renders the exact
  // same component as the router's pending fallback for /dashboard (see
  // router.tsx), so the chunk-loading phase and this data-loading phase paint
  // as one continuous skeleton - nothing moves between them.
  if (loading || !profile) {
    return <PageLoading variant="dashboard" />;
  }

  const firstName = profile.full_name?.split(" ")[0] ?? "Friend";

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 md:py-8 space-y-5 md:space-y-6">
        {/* Hero - landing-inspired soft gradient that shifts with time of day. */}
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          {/* Dark-only wash - see `.hero-wash` in styles.css. Shared across every page's top tile. */}
          <div className="hero-wash" />
          <div className="relative flex flex-col gap-6 p-6 md:p-10 md:flex-row md:items-center md:gap-8">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-muted-foreground">{getGreeting()},</div>
              <h1 className="mt-1 text-3xl md:text-5xl font-bold tracking-tight">{firstName}</h1>
              <p className="mt-3 max-w-xl text-base md:text-lg text-muted-foreground">
                What do you want to learn today?
              </p>
              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
                <Button
                  variant="hero"
                  size="lg"
                  className="w-[88%] mx-auto h-10 rounded-lg px-5 text-sm sm:mx-0 sm:w-auto sm:h-12 sm:rounded-xl sm:px-8 sm:text-base"
                  asChild
                >
                  <Link to="/explore" preload="intent">
                    <Compass className="h-4 w-4" />
                    Find a teacher
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="w-[88%] mx-auto h-10 rounded-lg px-5 text-sm sm:mx-0 sm:w-auto sm:h-12 sm:rounded-xl sm:px-8 sm:text-base"
                  asChild
                >
                  {myTeaching.length > 0 ? (
                    <Link to="/explore" search={{ mode: "learners" }} preload="intent">
                      Find a learner
                    </Link>
                  ) : (
                    <Link to="/profile" preload="intent">
                      Or teach a skill
                    </Link>
                  )}
                </Button>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                {/* Credits - shown until the CreditsCard takes over at lg. */}
                <span className="inline-flex items-center gap-1.5 lg:hidden">
                  <Coins className="h-4 w-4 text-amber-500" />
                  <span className="font-semibold">{liveCreditBalance ?? 0}</span>
                  <span className="text-muted-foreground">credits</span>
                </span>
                {/* "0 day streak" is a demotivating first thing to read, so the
                    chip - and the separator that leads into it - only appears
                    once there's a streak to be proud of. */}
                {streak > 0 && (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <Flame className="h-4 w-4 text-orange-500" />
                      <span className="font-semibold">{streak}</span>
                      <span className="text-muted-foreground">day streak</span>
                    </span>
                    <span className="hidden h-1 w-1 rounded-full bg-muted-foreground/40 sm:inline-block" />
                  </>
                )}
                {/* Held back until the teacher pipeline lands. The page paints
                    before it resolves now, and "0 matches" flicking to "9
                    matches" a beat later reads as a bug. */}
                {matchesHydrated ? (
                  <span className="text-muted-foreground">
                    <span className="font-semibold text-foreground/80">{teachers.length}</span>{" "}
                    match{teachers.length === 1 ? "" : "es"}
                  </span>
                ) : (
                  // h-5 matches the text-sm line box it stands in for - at lg
                  // the credits chip beside it is hidden, so this is the only
                  // thing setting the row's height.
                  <Skeleton className="h-5 w-20 rounded-full" />
                )}
              </div>
            </div>

            {/* Desktop credits card - fills the empty right side with a calm,
                on-brand summary of the user's balance. */}
            <CreditsCard credits={liveCreditBalance ?? 0} />
          </div>
        </section>

        {/* Direct skill swaps - renders only when the user has any. */}
        <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
          <SwapInbox refreshKey={swapRefresh} onChanged={() => loadDashboard()} />
        </div>

        {/* Your Next Move - stacks pending requests + the next upcoming session. */}
        <div className="animate-fade-up space-y-4 md:space-y-5" style={{ animationDelay: "100ms" }}>
          {nextMoves.map((move, i) => (
            <NextMoveCard
              key={
                move.kind === "incoming"
                  ? `incoming-${move.sessions.map((s) => s.id).join("-")}`
                  : move.kind === "upcoming"
                    ? `upcoming-${move.sessions.map((s) => s.id).join("-")}`
                    : `${move.kind}-${i}`
              }
              next={move}
              userId={user.id}
              busyIds={busyIds}
              verifiedPairs={verifiedPairs}
              hydrated={matchesHydrated && sessionsHydrated}
              onAcceptMany={acceptSessions}
              onRejectMany={rejectSessions}
              onCancel={cancelSession}
              onRequest={openRequestDialog}
              onMessageTeacher={(t) => void openChatWithTeacher(t)}
              onScheduleChanged={() => loadDashboard()}
            />
          ))}
        </div>

        {/* AI Insight - one headline, expand for more */}
        {aiSuggestionsEnabled && (
          <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
            <AiInsightCard
              recs={recs}
              refreshing={recsRefreshing}
              onRefresh={() => void refreshSuggestions()}
              onSwap={(target) => setSwapTarget(target)}
              onBook={(target) => void openBookingFromSuggestion(target)}
              onPrefetchBook={(target) => void resolveBookOffer(target)}
              bookingKey={bookingTileKey}
            />
          </div>
        )}

        {/* People who can teach you - same card pattern as AI Insights. Skip the one already shown in Next Move. */}
        {!matchesHydrated && (
          <div className="animate-fade-up" style={{ animationDelay: "180ms" }}>
            <PeopleSectionSkeleton />
          </div>
        )}
        {matchesHydrated && teachersForRow.length > 0 && (
          <div className="animate-fade-up" style={{ animationDelay: "180ms" }}>
            <PeopleSection
              title="People who can teach you"
              icon={<Users className="h-4 w-4 text-brand-purple" />}
              actionLabel="See all"
              actionTo="/explore"
              actionSearch={{ match: true }}
            >
              {teachersForRow.slice(0, 6).map((t) => {
                const creditsOk = (liveCreditBalance ?? 0) >= t.credits_per_hour;
                return (
                  <TeacherScrollCard
                    key={t.id}
                    teacher={t}
                    creditsOk={creditsOk}
                    verified={verifiedPairs.has(verifiedPairKey(t.user_id, t.skill_id))}
                    busy={busyIds.has(t.id)}
                    messageBusy={busyIds.has(messageBusyKey(t.id))}
                    onRequest={() => openRequestDialog(t)}
                    onMessage={() => void openChatWithTeacher(t)}
                  />
                );
              })}
            </PeopleSection>
          </div>
        )}

        {/* People you can help - only renders if you teach something AND there are seekers */}
        {seekers.length > 0 && (
          <div className="animate-fade-up" style={{ animationDelay: "240ms" }}>
            <PeopleSection
              title="People you can help"
              subtitle="Earn credits by teaching"
              icon={<HandHeart className="h-4 w-4 text-brand-cyan" />}
              actionLabel="See all"
              actionTo="/explore"
              actionSearch={{ mode: "learners", match: true }}
            >
              {seekers.slice(0, 6).map((s) => {
                const teachingMode =
                  myTeaching.find((t) => t.skill_id === s.skill_id)?.teaching_mode ??
                  profile.learning_mode;
                return (
                  <SeekerScrollCard
                    key={s.id}
                    seeker={s}
                    matchLabel={deriveMatchLabel(teachingMode, s.learning_mode, "Learner Match")}
                    busy={busyIds.has(s.id)}
                    messageBusy={busyIds.has(messageBusyKey(s.id))}
                    onOffer={() => void openOfferDialog(s)}
                    onMessage={() => void openChatWithSeeker(s)}
                  />
                );
              })}
            </PeopleSection>
          </div>
        )}

        {/* Active sessions - only renders when there are sessions beyond the one already shown in Next Move. */}
        {sessionsForStrip.length > 0 && (
          <div className="animate-fade-up" style={{ animationDelay: "300ms" }}>
            <ActiveSessionsStrip
              sessions={sessionsForStrip}
              userId={user.id}
              busyIds={busyIds}
              onAccept={acceptSession}
              onReject={rejectSession}
              onComplete={completeSession}
            />
          </div>
        )}

        {/* Footer CTA - slim, supportive */}
        <section
          className="animate-fade-up relative overflow-hidden rounded-3xl gradient-brand cta-band p-6 md:p-8 shadow-glow"
          style={{ animationDelay: "360ms" }}
        >
          {/* Light-mode only: this white bloom reads as "lit" over the violet ->
              emerald gradient, but in dark it smears the corner milky. The dark
              band brings its own bloom via .cta-band. */}
          <div className="absolute inset-0 bg-[radial-gradient(at_30%_30%,rgba(255,255,255,0.18),transparent_60%)] dark:hidden" />
          <div className="relative flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-xl md:text-2xl font-bold text-white">
                Teach a skill. Earn credits.
              </h3>
              <p className="mt-1 text-sm md:text-base text-white/85">Help others. Grow together.</p>
            </div>
            {/* In dark the glass variant resolves to an opaque #141416 pill, which
                on the deep violet band reads as a hole punched in the card rather
                than the primary action. Flip it to a light pill so the CTA is the
                brightest thing in the tile. */}
            <Button
              variant="glass"
              size="lg"
              className="w-[88%] mx-auto h-10 rounded-lg px-5 text-sm md:mx-0 md:w-auto md:h-12 md:rounded-xl md:px-8 md:text-base dark:border-transparent dark:bg-zinc-100 dark:text-violet-950 dark:hover:bg-white"
              asChild
            >
              <Link to="/explore" preload="intent">
                Explore matches <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      {requestDialog && (
        <Suspense fallback={null}>
          <SessionRequestDialog
            open={requestDialog !== null}
            onOpenChange={(open) => {
              if (!open) setRequestDialog(null);
            }}
            title={requestDialog.kind === "request" ? "Request a session" : "Offer to help"}
            skillName={
              requestDialog.kind === "request"
                ? (requestDialog.teacher.skills?.name ?? "skill")
                : (requestDialog.seeker.skills?.name ?? "skill")
            }
            creditsPerHour={
              requestDialog.kind === "request"
                ? requestDialog.teacher.credits_per_hour
                : requestDialog.creditsPerHour
            }
            availableCredits={requestDialog.kind === "request" ? (liveCreditBalance ?? null) : null}
            confirmLabel={requestDialog.kind === "request" ? "Send request" : "Send offer"}
            busy={busyIds.has(
              requestDialog.kind === "request" ? requestDialog.teacher.id : requestDialog.seeker.id,
            )}
            learnerId={requestDialog.kind === "request" ? user?.id : requestDialog.seeker.user_id}
            teacherId={requestDialog.kind === "request" ? requestDialog.teacher.user_id : user?.id}
            onConfirm={confirmRequestDialog}
            allowMultiSession={requestDialog.kind === "request"}
            teacherName={
              requestDialog.kind === "request"
                ? (requestDialog.teacher.profiles?.full_name ?? "Teacher")
                : undefined
            }
            onConfirmMulti={
              requestDialog.kind === "request" ? confirmRequestDialogMulti : undefined
            }
          />
        </Suspense>
      )}

      {swapTarget && (
        <Suspense fallback={null}>
          <SwapProposalDialog
            open={swapTarget !== null}
            onOpenChange={(open) => {
              if (!open) setSwapTarget(null);
            }}
            otherUserId={swapTarget.userId}
            preferMySkillName={swapTarget.mySkillName}
            preferMySkillId={swapTarget.mySkillId}
            preferTheirSkillName={swapTarget.theirSkillName}
            preferTheirSkillId={swapTarget.theirSkillId}
            onProposed={() => {
              setSwapRefresh((n) => n + 1);
              void loadDashboard();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function formatTimeUntil(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  if (Number.isNaN(diff)) return "soon";
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

// Absolute, human label for a session's start - used when listing the times in
// a multi-session request (where "in 2d" for each would be ambiguous).
function formatSessionSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time to be decided";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type NextMove =
  | { kind: "incoming"; sessions: SessionRow[] }
  | { kind: "upcoming"; sessions: SessionRow[] }
  | { kind: "match"; teachers: TeachOffer[] }
  | { kind: "empty"; hasLearning: boolean };

// Returns every move worth surfacing in the Next Move area, in priority order:
// each pending incoming request (so the user can accept/decline without scrolling),
// then a single "Up next" card stacking every upcoming accepted/active session
// (soonest first). Falls back to a single match/empty card if there are no
// actionable sessions at all.
function pickNextMoves(
  userId: string,
  sessions: SessionRow[],
  teachers: TeachOffer[],
  learning: LearnRow[],
): NextMove[] {
  const moves: NextMove[] = [];

  // A multi-session request books N separate pending sessions that share one
  // batch_id. Collapse them into a single "Action needed" card so the teacher
  // sees one request with all its times - not N identical cards - and can
  // accept/decline the whole plan at once. Ungrouped requests (no batch_id)
  // each get their own card, keyed by id so they never merge.
  const incoming = sessions.filter(
    (s) => s.status === "pending" && (s.initiator_id ?? s.learner_id) !== userId,
  );
  const batches = new Map<string, SessionRow[]>();
  for (const s of incoming) {
    const key = s.batch_id ?? s.id;
    const group = batches.get(key);
    if (group) group.push(s);
    else batches.set(key, [s]);
  }
  for (const group of batches.values()) {
    group.sort((a, b) => Date.parse(a.scheduled_at ?? "") - Date.parse(b.scheduled_at ?? ""));
    moves.push({ kind: "incoming", sessions: group });
  }

  const now = Date.now();
  const upcoming = sessions
    .filter((s) => (s.status === "accepted" || s.status === "active") && s.scheduled_at)
    .map((s) => ({ s, t: Date.parse(s.scheduled_at!) }))
    .filter(({ t }) => !Number.isNaN(t) && t + 60 * 60 * 1000 > now)
    .sort((a, b) => a.t - b.t)
    .map(({ s }) => s);
  if (upcoming.length > 0) moves.push({ kind: "upcoming", sessions: upcoming });

  if (moves.length > 0) return moves;

  if (teachers.length > 0) return [{ kind: "match", teachers: teachers.slice(0, 2) }];
  return [{ kind: "empty", hasLearning: learning.length > 0 }];
}

// ── Section placeholders ────────────────────────────────────────────────────
// Each of these mirrors the shell of the real section it stands in for - same
// wrapper, radius, padding and grid - so the swap to live content moves
// nothing. They're shared between the in-page "still loading this section"
// state and the whole-page fallback below, which is the only way the two stay
// in agreement as the real cards change.

type NextMoveCardProps = {
  next: NextMove;
  userId: string;
  busyIds: Set<string>;
  verifiedPairs: Set<string>;
  // True once BOTH pipelines this card is built from (teachers, sessions) have
  // answered. Either one alone can produce a card the other would replace.
  hydrated: boolean;
  onAcceptMany: (sessions: SessionRow[]) => void;
  onRejectMany: (sessions: SessionRow[]) => void;
  onCancel: (s: SessionRow) => void;
  onRequest: (t: TeachOffer) => void;
  onMessageTeacher: (t: TeachOffer) => void;
  onScheduleChanged: () => void | Promise<void>;
};

function NextMoveCard({
  next,
  userId,
  busyIds,
  verifiedPairs,
  hydrated,
  onAcceptMany,
  onRejectMany,
  onCancel,
  onRequest,
  onMessageTeacher,
  onScheduleChanged,
}: NextMoveCardProps) {
  if (next.kind === "incoming") {
    const sessions = next.sessions;
    const s = sessions[0];
    const multi = sessions.length > 1;
    const isTeacher = s.teacher_id === userId;
    const otherName = isTeacher ? s.learnerName : s.teacherName;
    // `action` describes what the OTHER person wants to do. If I'm the teacher,
    // they're the learner (they want to learn); if I'm the learner, they're the
    // teacher offering to teach.
    const action = isTeacher ? "learn" : "teach";
    // A multi-session request shares one duration; sum the credits across every
    // session so the teacher sees the whole plan's cost, not a single class.
    const totalCredits = sessions.reduce((sum, x) => sum + x.credits, 0);
    const busy = sessions.some((x) => busyIds.has(x.id));
    return (
      <section className="rounded-3xl border border-brand-purple/25 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
          <Sparkles className="h-3.5 w-3.5" /> Action needed
        </div>
        <h2 className="mt-2 text-xl md:text-2xl font-bold leading-tight">
          {otherName} wants to {action} {s.skills?.name ?? "a skill"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {multi
            ? `${sessions.length} sessions · ${s.duration_minutes} min each · ${totalCredits} credit${totalCredits === 1 ? "" : "s"} total`
            : `${s.duration_minutes} min · ${s.credits} credit${s.credits === 1 ? "" : "s"}`}
        </p>
        {multi && (
          <ul className="mt-3 space-y-1.5">
            {sessions.map((x, i) => (
              <li key={x.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-purple/10 text-[11px] font-semibold text-brand-purple">
                  {i + 1}
                </span>
                {x.scheduled_at ? formatSessionSlot(x.scheduled_at) : "Time to be decided"}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            variant="hero"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => onAcceptMany(sessions)}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {multi ? "Accept all" : "Accept"}
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => onRejectMany(sessions)}
            disabled={busy}
          >
            <X className="h-4 w-4" /> {multi ? "Decline all" : "Decline"}
          </Button>
        </div>
      </section>
    );
  }

  if (next.kind === "upcoming") {
    const sessions = next.sessions;
    return (
      <section className="rounded-3xl border border-brand-cyan/25 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-cyan font-semibold">
          <Clock className="h-3.5 w-3.5" /> Up next
        </div>
        <div className="mt-4 flex flex-col divide-y divide-border/60">
          {sessions.map((s, idx) => {
            const isTeacher = s.teacher_id === userId;
            const otherName = isTeacher ? s.learnerName : s.teacherName;
            const startsIn = formatTimeUntil(s.scheduled_at!);
            const joinable = canJoinSession(s.scheduled_at, s.duration_minutes);
            return (
              <div
                key={s.id}
                className={cn(
                  "flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6",
                  idx > 0 && "pt-5",
                  idx < sessions.length - 1 && "pb-5",
                )}
              >
                <div className="min-w-0 flex-1">
                  <h2 className="text-xl md:text-2xl font-bold leading-tight">
                    {s.skills?.name ?? "Session"} with {otherName}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Starts {startsIn} · {s.duration_minutes} min
                  </p>
                  <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                    {joinable ? (
                      <Button variant="hero" size="lg" className="w-full sm:w-auto" asChild>
                        <Link to="/video/$sessionId" preload="intent" params={{ sessionId: s.id }}>
                          <Video className="h-4 w-4" /> Join now
                        </Link>
                      </Button>
                    ) : (
                      <Button variant="hero" size="lg" className="w-full sm:w-auto" disabled>
                        <Video className="h-4 w-4" /> Join {startsIn}
                      </Button>
                    )}
                    <Button variant="outline" size="lg" className="w-full sm:w-auto" asChild>
                      <Link to="/sessions/$sessionId" preload="intent" params={{ sessionId: s.id }}>
                        Details
                      </Link>
                    </Button>
                  </div>
                </div>
                <div className="flex w-full flex-col gap-2.5 lg:w-80 lg:shrink-0">
                  <UpNextRescheduleActions
                    sessionId={s.id}
                    currentUserId={userId}
                    teacherId={s.teacher_id}
                    durationMinutes={s.duration_minutes}
                    onResolved={onScheduleChanged}
                    className="w-full"
                  />
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" asChild>
                      <Link to="/messages" search={{ s: s.id }}>
                        <MessageCircle className="h-4 w-4" /> Message
                      </Link>
                    </Button>
                    <ConfirmAction
                      title="Cancel this session?"
                      description={`Cancelling refunds the ${s.credits} credit${
                        s.credits === 1 ? "" : "s"
                      } held in escrow. You can re-request later if plans change.`}
                      confirmLabel="Cancel session"
                      cancelLabel="Keep it"
                      destructive
                      onConfirm={() => onCancel(s)}
                    >
                      <Button variant="outline" className="flex-1" disabled={busyIds.has(s.id)}>
                        {busyIds.has(s.id) ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                        Cancel session
                      </Button>
                    </ConfirmAction>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  // Skeleton while the live teacher/session queries are still resolving. We
  // don't restore matches from cache (would flicker as ranking changes once
  // availability lands), so a placeholder card holds the layout instead of
  // paint-then-shift.
  if (!hydrated && (next.kind === "match" || next.kind === "empty")) {
    return <NextMoveSkeleton />;
  }

  if (next.kind === "match") {
    const ts = next.teachers;
    const plural = ts.length > 1;
    return (
      <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
          <Sparkles className="h-3.5 w-3.5" />{" "}
          {plural ? "Top matches for you" : "Top match for you"}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5">
          {ts.map((t) => (
            <TopMatchTile
              key={t.id}
              teacher={t}
              verified={verifiedPairs.has(verifiedPairKey(t.user_id, t.skill_id))}
              busy={busyIds.has(t.id)}
              messageBusy={busyIds.has(`${t.id}:message`)}
              onRequest={() => onRequest(t)}
              onMessage={() => onMessageTeacher(t)}
            />
          ))}
        </div>
      </section>
    );
  }

  // hasLearning=true → user added skills but has zero matches yet. Keep this lean.
  if (next.hasLearning) {
    return (
      <section className="rounded-3xl border border-dashed border-border bg-card/30 p-6 md:p-7">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground font-semibold">
          <GraduationCap className="h-3.5 w-3.5" /> Get started
        </div>
        <h2 className="mt-2 text-xl md:text-2xl font-bold leading-tight">No matches yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Check back soon, or browse Explore to find peers.
        </p>
        <div className="mt-5">
          <Button variant="hero" size="lg" className="w-full sm:w-auto" asChild>
            <Link to="/explore" preload="intent">
              Browse teachers
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  // Truly new user: no learning skills, no teaching skills. Show the 3-step path.
  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/40 bg-gradient-to-br from-brand-purple/[0.08] via-card/60 to-brand-cyan/[0.08] backdrop-blur p-6 md:p-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(at_80%_20%,rgba(124,77,255,0.12),transparent_55%)]" />
      <div className="relative">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
          <Sparkles className="h-3.5 w-3.5" /> Welcome to SkillSwap
        </div>
        <h2 className="mt-3 text-2xl md:text-3xl font-bold tracking-tight leading-tight">
          Book your first session in 3 steps
        </h2>
        <p className="mt-2 text-sm md:text-base text-muted-foreground max-w-xl">
          Pick a skill you want to learn and we'll match you with someone who teaches it.
        </p>
        <ol className="mt-7 grid gap-4 sm:grid-cols-3">
          <WelcomeStep
            n="1"
            Icon={GraduationCap}
            title="Add a skill"
            body="Pick something you want to learn."
          />
          <WelcomeStep
            n="2"
            Icon={Users}
            title="See your matches"
            body="We pair you with peers who teach it."
          />
          <WelcomeStep
            n="3"
            Icon={Video}
            title="Meet & learn"
            body="Hop on a video call and your credits move over after."
          />
        </ol>
        <div className="mt-6">
          <Button variant="hero" size="lg" className="w-full sm:w-auto" asChild>
            <Link to="/profile" preload="intent">
              Add your first skill <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function TopMatchTile({
  teacher,
  verified,
  busy,
  messageBusy,
  onRequest,
  onMessage,
}: {
  teacher: TeachOffer;
  verified: boolean;
  busy: boolean;
  messageBusy: boolean;
  onRequest: () => void;
  onMessage: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/40 bg-card/60 p-4 transition-all hover:-translate-y-0.5 hover:border-brand-purple/40 hover:shadow-md hover:shadow-brand-purple/5">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-brand-purple/10 to-brand-cyan/10 opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative flex flex-col gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: teacher.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
        >
          <UserAvatar
            name={teacher.profiles?.full_name}
            url={teacher.profiles?.avatar_url}
            className="h-11 w-11 shrink-0 ring-2 ring-background"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm md:text-base font-semibold truncate leading-tight">
              {teacher.profiles?.full_name ?? "Student"}
            </h3>
            <p className="flex items-center gap-1 text-xs text-muted-foreground truncate">
              <span className="truncate">Teaches {teacher.skills?.name}</span>
              {verified && <VerifiedTick className="h-3.5 w-3.5" />}
              {teacher.credits_per_hour ? (
                <>
                  {" · "}
                  <span className="font-medium text-foreground/70">
                    {teacher.credits_per_hour} cr/hr
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onMessage}
            disabled={messageBusy}
            aria-label={`Message ${teacher.profiles?.full_name ?? "this teacher"}`}
          >
            {messageBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            Message
          </Button>
          <Button
            variant="hero"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onRequest}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HandHeart className="h-3.5 w-3.5" />
            )}
            Request
          </Button>
        </div>
      </div>
    </div>
  );
}

function CreditsCard({ credits }: { credits: number }) {
  return (
    <div className="relative hidden lg:flex lg:w-56 shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-white/15 bg-[linear-gradient(135deg,#5978c4_0%,#1ead8d_100%)] px-5 py-5 text-white shadow-glow dark:border-white/[0.06] dark:bg-none dark:bg-[#141416] dark:text-foreground dark:shadow-none">
      <div className="absolute -top-2 -right-2 text-white/15 dark:text-white/[0.04]">
        <Coins className="h-16 w-16" strokeWidth={1.5} />
      </div>
      <div className="relative">
        <div className="text-xs font-semibold uppercase tracking-wide text-white/85 dark:text-muted-foreground">
          Your Credits
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-4xl font-bold tabular-nums dark:text-foreground">{credits}</span>
          <Coins className="h-5 w-5 text-amber-200 drop-shadow-[0_0_6px_rgba(253,224,71,0.45)] dark:text-amber-300/80 dark:drop-shadow-none" />
        </div>
      </div>
      <p className="relative mt-3 text-[11px] leading-relaxed text-white/85 dark:text-muted-foreground">
        Use credits to learn.
        <br />
        Earn credits by teaching.
      </p>
    </div>
  );
}

function WelcomeStep({
  n,
  Icon,
  title,
  body,
}: {
  n: string;
  Icon: typeof GraduationCap;
  title: string;
  body: string;
}) {
  return (
    <li className="group relative rounded-2xl border border-border/40 bg-card/60 backdrop-blur p-5 transition-all hover:-translate-y-0.5 hover:border-brand-purple/40 hover:shadow-md hover:shadow-brand-purple/5">
      <div className="relative inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-purple/15 to-brand-cyan/15 ring-1 ring-brand-purple/15">
        <Icon className="h-5 w-5 text-brand-purple" />
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background ring-1 ring-border text-[10px] font-bold text-foreground/70">
          {n}
        </span>
      </div>
      <div className="mt-4 text-sm font-semibold leading-tight">{title}</div>
      <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{body}</p>
    </li>
  );
}

// What a "swap" tile hands back so the dialog can pre-select the exact legs the
// suggestion named. Ids come from the engine and are matched first; the names
// cover cache rows written before the engine sent ids.
type SwapTileTarget = {
  userId: string;
  mySkillName?: string;
  mySkillId?: string;
  theirSkillName?: string;
  theirSkillId?: string;
};

// What a teacher-match tile hands back so the booking dialog can open on the
// exact person + skill the copy named.
type BookTileTarget = { userId: string; skillId?: string; skillName?: string };

// Identifies the tile whose booking lookup is in flight, so only that tile
// shows a spinner. Same shape on both sides of the comparison.
function bookTileKey(target: BookTileTarget): string {
  return `${target.userId}:${target.skillId ?? target.skillName ?? ""}`;
}

type AiInsightCardProps = {
  recs: AiSuggestion[] | null;
  refreshing: boolean;
  onRefresh: () => void;
  // Opens the swap proposal dialog for a reciprocal-match ("swap") tile.
  onSwap?: (target: SwapTileTarget) => void;
  // Opens the booking dialog for a tile that names a teacher + their skill.
  onBook?: (target: BookTileTarget) => void;
  // Warms that tile's teaching-row lookup on hover/focus.
  onPrefetchBook?: (target: BookTileTarget) => void;
  // bookTileKey() of the tile currently resolving its teaching row, if any.
  bookingKey?: string | null;
};

function AiInsightCard({
  recs,
  refreshing,
  onRefresh,
  onSwap,
  onBook,
  onPrefetchBook,
  bookingKey,
}: AiInsightCardProps) {
  if (recs === null) return <SuggestionsSkeleton />;

  if (recs.length === 0) return null;

  const visible = recs.slice(0, 4);

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-gradient-to-br from-brand-purple/15 to-brand-cyan/15 blur-2xl" />
      <div className="relative flex items-center justify-between gap-2">
        {/* Tight icon + label pair: the icon's tile is sized to the glyph so the
            gap you see is the 6px gap, not the box's leftover padding. */}
        <div className="inline-flex items-center gap-1.5">
          <div className="inline-flex h-5 w-5 items-center justify-center rounded-md gradient-brand-soft">
            <Sparkles className="h-3 w-3 text-brand-cyan" />
          </div>
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground font-semibold">
            Suggestions
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Show different suggestions"
          title="Show different suggestions"
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-full text-muted-foreground/70 hover:text-brand-purple hover:bg-brand-purple/10 active:scale-95 transition-all disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
      </div>

      <div className="relative mt-4 grid gap-3 md:grid-cols-2 md:gap-4">
        {visible.map((r, i) => (
          <InsightTile
            key={`v-${i}`}
            suggestion={r}
            onSwap={onSwap}
            onBook={onBook}
            onPrefetchBook={onPrefetchBook}
            bookingKey={bookingKey}
          />
        ))}
      </div>
    </section>
  );
}

function InsightTile({
  suggestion,
  onSwap,
  onBook,
  onPrefetchBook,
  bookingKey,
}: {
  suggestion: AiSuggestion;
  onSwap?: (target: SwapTileTarget) => void;
  onBook?: (target: BookTileTarget) => void;
  onPrefetchBook?: (target: BookTileTarget) => void;
  bookingKey?: string | null;
}) {
  const meta = SUGGESTION_TYPE_META[suggestion.type] ?? SUGGESTION_TYPE_META.general;
  const Icon = meta.icon;
  const action = suggestion.action;

  const bookTarget: BookTileTarget | null =
    action?.kind === "user" && suggestion.type !== "swap" && (action.skillId || action.skillName)
      ? { userId: action.userId, skillId: action.skillId, skillName: action.skillName }
      : null;
  const booking = Boolean(bookTarget && bookingKey && bookingKey === bookTileKey(bookTarget));

  const tileClass =
    "group relative overflow-hidden rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 text-left transition-all hover:border-brand-purple/40 hover:bg-background/70 hover:shadow-sm hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple/40 cursor-pointer block w-full";

  // One colour cue per tile. The type tint used to be painted twice - icon tile
  // plus a left edge stripe - which turned a 2x2 grid into a rainbow.
  const inner = (
    <>
      <div className="flex items-start gap-3">
        <div
          className={cn("h-10 w-10 shrink-0 rounded-xl flex items-center justify-center", meta.bg)}
        >
          <Icon className={cn("h-5 w-5", meta.fg)} />
        </div>
        <p className="text-sm leading-snug pt-1.5 line-clamp-2">{suggestion.message}</p>
        {booking ? (
          <Loader2 className="ml-auto h-4 w-4 shrink-0 mt-2 animate-spin text-brand-purple" />
        ) : (
          <ArrowRight className="ml-auto h-4 w-4 shrink-0 mt-2 text-muted-foreground/40 transition-all group-hover:text-brand-purple group-hover:translate-x-0.5" />
        )}
      </div>
    </>
  );

  if (!action) {
    return <div className={cn(tileClass, "cursor-default")}>{inner}</div>;
  }

  // Each Link variant has different param/search typing, so switch on kind
  // rather than building the props dynamically. Server always sends one of
  // these four; an unknown kind would silently render a non-link tile.
  if (action.kind === "user") {
    // A reciprocal match ("swap") opens the swap proposal dialog directly -
    // that's the "Direct swap, no credits" the message promises.
    if (suggestion.type === "swap" && onSwap) {
      // `skillName`/`skillId` is the skill they teach (you'd learn);
      // `swapMySkill*` is the skill you teach back. Passing both lets the
      // dialog open on exactly the legs the message promised.
      return (
        <button
          type="button"
          onClick={() =>
            onSwap({
              userId: action.userId,
              mySkillName: action.swapMySkillName,
              mySkillId: action.swapMySkillId,
              theirSkillName: action.skillName,
              theirSkillId: action.skillId,
            })
          }
          className={tileClass}
        >
          {inner}
        </button>
      );
    }
    // Any other user tile names a teacher AND the skill they teach, so it opens
    // the booking dialog on that pair rather than the profile - "Book a
    // session" should be one click, not profile → Request → pick the skill.
    if (bookTarget && onBook) {
      return (
        <button
          type="button"
          disabled={booking}
          onClick={() => onBook(bookTarget)}
          onMouseEnter={() => onPrefetchBook?.(bookTarget)}
          onFocus={() => onPrefetchBook?.(bookTarget)}
          className={tileClass}
        >
          {inner}
        </button>
      );
    }
    return (
      <Link
        to="/users/$userId"
        params={{ userId: action.userId }}
        preload="intent"
        className={tileClass}
      >
        {inner}
      </Link>
    );
  }
  if (action.kind === "explore") {
    const search: { q?: string; mode?: "learners" } = {};
    if (action.q) search.q = action.q;
    // Honor an explicit learner mode from the server; otherwise infer it from
    // the message so teach-oriented tips cached before this fix still route to
    // Find-a-learner instead of the default Find-a-teacher.
    const mode = action.mode ?? inferExploreMode(suggestion.message);
    if (mode === "learners") search.mode = "learners";
    return (
      <Link to="/explore" search={search} preload="intent" className={tileClass}>
        {inner}
      </Link>
    );
  }
  if (action.kind === "profile") {
    return (
      <Link to="/profile" preload="intent" className={tileClass}>
        {inner}
      </Link>
    );
  }
  if (action.kind === "skills") {
    // "Add a teaching/learning skill" tiles. Skills are added and managed on the
    // user's own profile page - /skills is the PUBLIC catalog browse, not a
    // place to edit your own skills - so route to /profile, which is where the
    // message ("add a teaching skill") actually leads.
    return (
      <Link to="/profile" preload="intent" className={tileClass}>
        {inner}
      </Link>
    );
  }
  return <div className={cn(tileClass, "cursor-default")}>{inner}</div>;
}

type PeopleSectionProps = {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  actionLabel?: string;
  actionTo?: string;
  actionSearch?: Record<string, string | boolean>;
  children: React.ReactNode;
};

// Wraps a list of people tiles in the same card shell as AI Insights:
// rounded card with header, 2-column grid of the first two tiles, and a
// centered chevron that expands to reveal the rest.
function PeopleSection({
  title,
  subtitle,
  icon,
  actionLabel,
  actionTo,
  actionSearch,
  children,
}: PeopleSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  const visible = items.slice(0, 2);
  const rest = items.slice(2);

  return (
    <section className="rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-2 text-sm md:text-base font-semibold">
            {icon} {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {actionLabel && actionTo && (
          <Link
            to={actionTo}
            search={actionSearch}
            preload="intent"
            className="group shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-background/40 px-3 py-1 text-xs font-medium text-muted-foreground hover:border-brand-purple/40 hover:bg-brand-purple/5 hover:text-brand-purple transition-all"
          >
            {actionLabel}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 md:gap-4">{visible}</div>

      {rest.length > 0 && (
        <>
          {expanded && (
            <div className="mt-3 grid gap-3 border-t border-border/40 pt-4 md:grid-cols-2 md:gap-4">
              {rest}
            </div>
          )}
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Show fewer" : "Show more"}
              title={expanded ? "Show fewer" : "Show more"}
              className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
              />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type TeacherScrollCardProps = {
  teacher: TeachOffer;
  creditsOk: boolean;
  verified: boolean;
  busy: boolean;
  messageBusy: boolean;
  onRequest: () => void;
  onMessage: () => void;
};

function TeacherScrollCard({
  teacher,
  creditsOk,
  verified,
  busy,
  messageBusy,
  onRequest,
  onMessage,
}: TeacherScrollCardProps) {
  return (
    <div className="group rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 transition-all hover:border-brand-purple/40 hover:bg-background/70 hover:shadow-sm">
      <div className="flex flex-col gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: teacher.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
        >
          <UserAvatar
            name={teacher.profiles?.full_name}
            url={teacher.profiles?.avatar_url}
            className="h-11 w-11 shrink-0 ring-2 ring-background"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate leading-tight">
              {teacher.profiles?.full_name ?? "Student"}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground truncate">
              <span className="truncate">
                {teacher.skills?.name} · <span className="capitalize">{teacher.level}</span>
              </span>
              {verified && <VerifiedTick className="h-3.5 w-3.5" />}
            </div>
            {!creditsOk ? (
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <Coins className="h-3 w-3" />
                Need {teacher.credits_per_hour} cr/hr
              </span>
            ) : (
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-brand-cyan">
                <Sparkles className="h-3 w-3" />
                Matches your interests
              </span>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onMessage}
            disabled={messageBusy}
            aria-label={`Message ${teacher.profiles?.full_name ?? "this teacher"}`}
          >
            {messageBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            Message
          </Button>
          <Button
            variant="hero"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onRequest}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HandHeart className="h-3.5 w-3.5" />
            )}
            Request
          </Button>
        </div>
      </div>
    </div>
  );
}

type SeekerScrollCardProps = {
  seeker: Seeker;
  matchLabel: string;
  busy: boolean;
  messageBusy: boolean;
  onOffer: () => void;
  onMessage: () => void;
};

function SeekerScrollCard({
  seeker,
  matchLabel,
  busy,
  messageBusy,
  onOffer,
  onMessage,
}: SeekerScrollCardProps) {
  return (
    <div className="group rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 transition-all hover:border-brand-cyan/40 hover:bg-background/70 hover:shadow-sm">
      <div className="flex flex-col gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: seeker.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
        >
          <UserAvatar
            name={seeker.profiles?.full_name}
            url={seeker.profiles?.avatar_url}
            className="h-11 w-11 shrink-0 ring-2 ring-background"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate leading-tight">
              {seeker.profiles?.full_name ?? "Student"}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              Wants {seeker.skills?.name} ·{" "}
              <span className="capitalize">{seeker.current_level}</span>
            </div>
            <span className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-full border border-brand-cyan/30 bg-brand-cyan/10 px-2 py-0.5 text-[10px] font-medium text-brand-cyan">
              <HandHeart className="h-2.5 w-2.5" /> {matchLabel}
            </span>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onMessage}
            disabled={messageBusy}
            aria-label={`Message ${seeker.profiles?.full_name ?? "this learner"}`}
          >
            {messageBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            Message
          </Button>
          <Button
            variant="hero"
            size="sm"
            className="flex-1 rounded-full"
            onClick={onOffer}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HandHeart className="h-3.5 w-3.5" />
            )}
            Offer
          </Button>
        </div>
      </div>
    </div>
  );
}

type ActiveSessionsStripProps = {
  sessions: SessionRow[];
  userId: string;
  busyIds: Set<string>;
  onAccept: (s: SessionRow) => void;
  onReject: (s: SessionRow) => void;
  onComplete: (s: SessionRow) => void;
};

function ActiveSessionsStrip({
  sessions,
  userId,
  busyIds,
  onAccept,
  onReject,
  onComplete,
}: ActiveSessionsStripProps) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="inline-flex items-center gap-2 text-base md:text-lg font-semibold">
          <Calendar className="h-4 w-4 text-brand-purple" /> Active sessions
        </h2>
        <Link
          to="/history"
          preload="intent"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          See all <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur divide-y divide-border/40">
        {sessions.slice(0, 4).map((session) => {
          const isTeacher = session.teacher_id === userId;
          const sessionInitiatorId = session.initiator_id ?? session.learner_id;
          const canRespondToPending = session.status === "pending" && userId !== sessionInitiatorId;
          const otherName = isTeacher ? session.learnerName : session.teacherName;
          const isAcceptedSession = session.status === "accepted" || session.status === "active";
          const earlyReleaseUnlockAt = session.scheduled_at
            ? Date.parse(session.scheduled_at) + (session.duration_minutes * 60_000) / 2
            : null;
          const earlyReleaseAvailable =
            isAcceptedSession &&
            !isTeacher &&
            earlyReleaseUnlockAt !== null &&
            earlyReleaseUnlockAt <= Date.now();
          const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
          const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);

          return (
            <div key={session.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-medium truncate">{session.skills?.name ?? "Session"}</div>
                  <Badge
                    variant="outline"
                    className="capitalize bg-secondary/40 border-border/60 text-[10px]"
                  >
                    {session.status}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground truncate">
                  {isTeacher ? "Learner" : "Teacher"}: {otherName} · {session.duration_minutes} min
                  · {session.credits} cr
                </div>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                {canRespondToPending && (
                  <>
                    <Button
                      variant="hero"
                      size="sm"
                      onClick={() => onAccept(session)}
                      disabled={busyIds.has(session.id)}
                    >
                      {busyIds.has(session.id) ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Accept
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onReject(session)}
                      disabled={busyIds.has(session.id)}
                      aria-label="Decline"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                )}
                {isAcceptedSession &&
                  (joinAllowed ? (
                    <Button variant="hero" size="sm" asChild>
                      <Link
                        to="/video/$sessionId"
                        preload="intent"
                        params={{ sessionId: session.id }}
                      >
                        <Video className="h-4 w-4" /> Join
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title={joinHint ?? "Not in session window"}
                    >
                      <Video className="h-4 w-4" /> {joinHint ?? "Join"}
                    </Button>
                  ))}
                {session.status !== "rejected" && (
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/sessions/$sessionId"
                      preload="intent"
                      params={{ sessionId: session.id }}
                    >
                      Details
                    </Link>
                  </Button>
                )}
                {earlyReleaseAvailable && (
                  <ConfirmAction
                    title="Release credits to your teacher now?"
                    description={`This sends ${session.credits} credits to ${session.teacherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room, otherwise the release will be blocked.`}
                    confirmLabel="Release now"
                    onConfirm={() => onComplete(session)}
                  >
                    <Button variant="hero" size="sm" disabled={busyIds.has(session.id)}>
                      {busyIds.has(session.id) && <Loader2 className="h-4 w-4 animate-spin" />}
                      Complete
                    </Button>
                  </ConfirmAction>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
