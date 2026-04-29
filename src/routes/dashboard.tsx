import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Children, useCallback, useEffect, useState } from "react";
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
  Eye,
  RefreshCw,
  ArrowLeftRight,
  TrendingUp,
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
import { fetchAiSuggestions, type AiSuggestion } from "@/lib/ai-suggestions";
import { useFeatureEnabled } from "@/lib/feature-flags";
import { createVideoRoom, getVideoRoomUrl } from "@/lib/jitsi";
import {
  getOrCreateSession,
  canJoinSession,
  describeJoinWindow,
  type SessionDuration,
} from "@/lib/sessions";
import { playRequestSentChime } from "@/lib/sounds";
import { markSelfAction } from "@/lib/self-action";
import { SessionRequestDialog } from "@/components/SessionRequestDialog";
import { fetchTeacherRatings, type TeacherRating } from "@/lib/ratings";
import { ConfirmAction } from "@/components/ConfirmAction";
import { UserAvatar } from "@/components/UserAvatar";
import { PageLoading } from "@/components/PageLoading";
import { Skeleton } from "@/components/ui/skeleton";
import { signAvatarUrls } from "@/lib/avatars";
import { deriveMatchLabel, rankCandidate, type LearningMode, type SkillLevel } from "@/lib/match";
import type { Enums } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { useInvalidateMyCreditBalance, useMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { queryUserSessions } from "@/lib/session-queries";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

const LEVEL_RANK: Record<string, number> = { basic: 1, intermediate: 2, advanced: 3 };

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

async function loadProfiles(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids));
  const profileMap = new Map<string, ProfileSummary>();
  if (!uniqueIds.length) return profileMap;

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, learning_mode, avatar_url, updated_at")
    .in("id", uniqueIds);
  const rows = data ?? [];
  const signedUrlMap = await signAvatarUrls(rows.map((r) => r.avatar_url));
  for (const person of rows) {
    profileMap.set(person.id, {
      full_name: person.full_name ?? "Student",
      learning_mode: person.learning_mode ?? null,
      avatar_url: person.avatar_url ? (signedUrlMap.get(person.avatar_url) ?? null) : null,
      updated_at: person.updated_at ?? null,
    });
  }
  return profileMap;
}

async function loadCandidateLearningSkillIds(userIds: string[]) {
  const map = new Map<string, Set<string>>();
  if (!userIds.length) return map;
  const { data } = await supabase
    .from("user_learning_skills")
    .select("user_id, skill_id")
    .in("user_id", userIds);
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
  const { data } = await supabase
    .from("user_teaching_skills")
    .select("user_id, skill_id")
    .in("user_id", userIds);
  for (const row of data ?? []) {
    const set = map.get(row.user_id) ?? new Set<string>();
    set.add(row.skill_id);
    map.set(row.user_id, set);
  }
  return map;
}

async function loadCompletedSessionCounts(userIds: string[]) {
  const counts = new Map<string, number>();
  if (!userIds.length) return counts;
  const [{ data: asTeacher }, { data: asLearner }] = await Promise.all([
    supabase
      .from("sessions")
      .select("teacher_id")
      .in("teacher_id", userIds)
      .eq("status", "completed"),
    supabase
      .from("sessions")
      .select("learner_id")
      .in("learner_id", userIds)
      .eq("status", "completed"),
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
// yesterday — the day isn't over, so a missing entry shouldn't kill the streak.
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
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  // Single source of truth shared with the header. Realtime push from
  // credit_transactions keeps this fresh without any manual fetch.
  const { data: liveCreditBalance } = useMyCreditBalance();
  const aiSuggestionsEnabled = useFeatureEnabled("features.ai_suggestions.enabled", true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [learning, setLearning] = useState<LearnRow[]>([]);
  const [teachers, setTeachers] = useState<TeachOffer[]>([]);
  // teacher_id → next free slot the teacher offers (or null = no free
  // `teach` time posted / fully booked in the 7-day horizon).
  const [teacherAvailability, setTeacherAvailability] = useState<Map<string, string | null>>(
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
  const [streak, setStreak] = useState(0);
  const [recs, setRecs] = useState<AiSuggestion[] | null>(null);
  const [recsRefreshing, setRecsRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  // True once the live teacher/seeker query has resolved this mount. The
  // dashboard cache deliberately does NOT pre-paint teachers/seekers because
  // their ranking depends on availability data that arrives separately —
  // hydrating from cache produced a visible flicker on refresh (Top Match
  // tile A → tile B once live data landed). Keeping these lists unhydrated
  // and showing a skeleton in NextMoveCard is the right trade.
  const [matchesHydrated, setMatchesHydrated] = useState(false);
  // State value isn't read anywhere on this page — the setter exists only so
  // cache hydration can persist the rating map for next mount. Prefixed with
  // `_` to opt out of the unused-vars lint without breaking the cache wire-up.
  const [_teacherRatings, setTeacherRatings] = useState<Map<string, TeacherRating>>(new Map());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [requestDialog, setRequestDialog] = useState<
    | { kind: "request"; teacher: TeachOffer }
    | { kind: "offer"; seeker: Seeker; creditsPerHour: number }
    | null
  >(null);
  // Gate to prevent the dashboard skeleton from painting before we know the
  // user finished onboarding. Without this, a brand-new OAuth user — e.g. a
  // GitHub signup that lands here because Supabase's project redirect URLs
  // point straight at /dashboard rather than /auth/callback — sees the
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

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/dashboard" } });
    }
  }, [authLoading, user, navigate]);

  // Fast onboarded pre-check that runs ahead of the full loadDashboard
  // pipeline. If the user hasn't finished onboarding we bounce immediately
  // before any dashboard chrome paints. Skipped once the gate is already open
  // (e.g. cache hydration confirmed it) so we don't issue a redundant query.
  useEffect(() => {
    if (authLoading || !user || onboardingGateReady) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("onboarded")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!data?.onboarded) {
        navigate({ to: "/onboarding", replace: true });
        return;
      }
      setOnboardingGateReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, onboardingGateReady, navigate]);

  useEffect(() => {
    if (!user) return;
    const cache = getDashboardCache(user.id);
    if (!cache) return;

    // Cached profiles are only ever written after a successful dashboard load,
    // which implies onboarded=true. Trust it to open the gate synchronously so
    // returning users skip the spinner entirely.
    if (cache.profile?.onboarded) setOnboardingGateReady(true);
    setProfile(cache.profile);
    setLearning(cache.learning ?? []);
    // teachers/seekers intentionally NOT restored from cache. Their ranking
    // depends on availability/credit data that arrives later in loadDashboard,
    // so painting the cached order causes a visible "Top Match A → B" flicker
    // on refresh. We render a skeleton (matchesHydrated=false) until the live
    // query lands instead.
    setMyTeaching(cache.myTeaching ?? []);
    setSessions(cache.sessions ?? []);
    setStreak(cache.streak ?? 0);
    setRecs(cache.recs ?? null);
    setTeacherRatings(new Map(cache.teacherRatings ?? []));
    setLoading(false);
  }, [user]);

  const loadDashboard = useCallback(async () => {
    if (!user) return;
    // auto_complete_due_sessions / notify_upcoming_sessions are now run on a
    // schedule (pg_cron or an external worker using the service role) rather
    // than fired from every dashboard load. The grants were tightened in
    // migration 20260511040000_lock_sweep_rpcs_to_service_role.sql.
    setLoading((current) => (profile ? false : current));
    try {
      const [{ data: p, error: profileError }, { data: creditBalance }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, bio, onboarded, learning_mode")
          .eq("id", user.id)
          .maybeSingle(),
        supabase.rpc("my_credit_balance"),
      ]);

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
        // no bio — the dashboard hero ends up rendering "Welcome back, Friend".
        const hasSkills =
          (existingTeaching?.length ?? 0) > 0 || (existingLearning?.length ?? 0) > 0;
        const hasName = Boolean(p.full_name && p.full_name.trim());

        if (hasSkills && hasName) {
          // Server-side complete_onboarding re-checks the same conditions
          // before flipping the flag — see the migration that locks the
          // column down. We still pre-check on the client so we don't
          // bounce a brand-new user through a doomed RPC call.
          const { error: onboardedFlipError } = await supabase.rpc("complete_onboarding" as never);
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

      const [learn, myTeach, rawSessions, streakCount] = await Promise.all([
        loadMyLearningSkills(user.id),
        loadMyTeachingSkills(user.id),
        queryDashboardSessionRows(user.id),
        loadStreak(user.id),
      ]);
      setStreak(streakCount);

      const learnRows = learn ?? [];
      setLearning(learnRows);

      const learnSkillIds = learnRows.map((l) => l.skill_id);
      let teacherList: TeachOffer[] = [];
      let ratings = new Map<string, TeacherRating>();
      if (learnSkillIds.length) {
        let teacherResult = await supabase
          .from("user_teaching_skills")
          .select(
            "id, skill_id, level, credits_per_hour, user_id, teaching_mode, skills:skill_id(id, name)",
          )
          .in("skill_id", learnSkillIds)
          .neq("user_id", user.id)
          .limit(50);
        if (teacherResult.error) {
          teacherResult = (await supabase
            .from("user_teaching_skills")
            .select("id, skill_id, level, credits_per_hour, user_id, skills:skill_id(id, name)")
            .in("skill_id", learnSkillIds)
            .neq("user_id", user.id)
            .limit(50)) as unknown as typeof teacherResult;
        }
        const { data: t } = teacherResult;
        const teacherRows = (t ?? []) as unknown as TeachOffer[];
        const teacherUserIds = teacherRows.map((row) => row.user_id);
        const [teacherProfiles, teacherRatingMap, teacherLearningMap, teacherSessionsMap] =
          await Promise.all([
            loadProfiles(teacherUserIds),
            fetchTeacherRatings(teacherUserIds),
            loadCandidateLearningSkillIds(teacherUserIds),
            loadCompletedSessionCounts(teacherUserIds),
          ]);
        ratings = teacherRatingMap;
        setTeacherRatings(ratings);
        const myTeachSkillIdSetForRanking = new Set((myTeach ?? []).map((row) => row.skill_id));
        teacherList = teacherRows
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
              rating: ratings.get(a.user_id)?.average ?? null,
              completedSessions: teacherSessionsMap.get(a.user_id) ?? 0,
              profileUpdatedAt: teacherProfiles.get(a.user_id)?.updated_at ?? null,
              myCredits: creditBalance ?? null,
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
              rating: ratings.get(b.user_id)?.average ?? null,
              completedSessions: teacherSessionsMap.get(b.user_id) ?? 0,
              profileUpdatedAt: teacherProfiles.get(b.user_id)?.updated_at ?? null,
              myCredits: creditBalance ?? null,
              theirCreditsPerHour: b.credits_per_hour,
              reciprocal: bReciprocal,
              candidateId: b.user_id + ":" + b.skill_id,
              viewerId: user.id,
            }).total;
            return bScore - aScore;
          })
          .slice(0, 10);

        // Bulk teacher-free-time lookup for the matched teachers, then
        // sort so teachers with posted free time appear first. Doing this
        // BEFORE setTeachers avoids the visible reshuffle from the previous
        // two-step pattern (initial list paint, then re-sort once
        // availability lands).
        const intersectionTeacherIds = Array.from(new Set(teacherList.map((t) => t.user_id)));
        let finalTeacherList = teacherList;
        if (intersectionTeacherIds.length > 0) {
          const { data: intRows } = await supabase.rpc("teachers_free_time_status", {
            p_teacher_ids: intersectionTeacherIds,
            p_duration_minutes: 30,
            p_horizon_days: 7,
          });
          const availMap = new Map<string, string | null>();
          for (const r of intRows ?? []) availMap.set(r.teacher_id, r.next_slot);
          setTeacherAvailability(availMap);

          // Stable re-sort: teachers with an upcoming slot float to top.
          const slotMs = (uid: string) => {
            const slot = availMap.get(uid);
            if (!slot) return null;
            const t = Date.parse(slot);
            return Number.isNaN(t) ? null : t;
          };
          finalTeacherList = [...teacherList].sort((a, b) => {
            const aSlot = slotMs(a.user_id);
            const bSlot = slotMs(b.user_id);
            if (aSlot != null && bSlot != null) return aSlot - bSlot;
            if (aSlot != null) return -1;
            if (bSlot != null) return 1;
            return 0;
          });
        }
        setTeachers(finalTeacherList);
      } else {
        setTeachers([]);
        setTeacherRatings(new Map());
      }

      const myTeachRows = myTeach ?? [];
      setMyTeaching(myTeachRows);

      const teachSkillIds = myTeachRows.map((s) => s.skill_id);
      let seekerList: Seeker[] = [];
      if (teachSkillIds.length) {
        let seekerResult = await supabase
          .from("user_learning_skills")
          .select("id, user_id, skill_id, current_level, learning_mode, skills:skill_id(id, name)")
          .in("skill_id", teachSkillIds)
          .neq("user_id", user.id)
          .limit(50);
        if (seekerResult.error) {
          seekerResult = (await supabase
            .from("user_learning_skills")
            .select("id, user_id, skill_id, current_level, skills:skill_id(id, name)")
            .in("skill_id", teachSkillIds)
            .neq("user_id", user.id)
            .limit(50)) as unknown as typeof seekerResult;
        }
        const { data: s } = seekerResult;
        const seekerRows = (s ?? []) as unknown as Seeker[];
        const seekerUserIds = seekerRows.map((row) => row.user_id);
        const [seekerProfiles, seekerTeachingMap, seekerSessionsMap] = await Promise.all([
          loadProfiles(seekerUserIds),
          loadCandidateTeachingSkillIds(seekerUserIds),
          loadCompletedSessionCounts(seekerUserIds),
        ]);
        const myLearnSkillIdSetForRanking = new Set(learnRows.map((row) => row.skill_id));
        const myTeachLevelBySkill = new Map(myTeachRows.map((row) => [row.skill_id, row.level]));
        seekerList = seekerRows
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
        setSeekers(seekerList);
      } else {
        setSeekers([]);
      }
      setMatchesHydrated(true);

      const participantIds = Array.from(
        new Set(rawSessions.flatMap((s) => [s.learner_id, s.teacher_id])),
      );
      const profileMap = new Map<string, string>();
      if (participantIds.length) {
        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", participantIds);
        for (const person of people ?? []) {
          profileMap.set(person.id, person.full_name ?? "Student");
        }
      }
      const sessionList = rawSessions.map((s) => {
        const normalizedLink =
          s.status === "accepted" || s.status === "active"
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
      setSessions(sessionList);

      setDashboardCache(user.id, {
        profile: p as Profile,
        learning: learnRows,
        teachers: teacherList,
        seekers: seekerList,
        myTeaching: myTeachRows,
        sessions: sessionList,
        recs,
        teacherRatings: Array.from(ratings.entries()),
        streak: streakCount,
      });

      setLoading(false);

      void fetchAiSuggestions()
        .then((r) => setRecs(r.suggestions))
        .catch(() => setRecs([]));
    } catch (error) {
      setLoading(false);
      setRecs([]);
      setMatchesHydrated(true);
      toastError(error, "Could not load dashboard");
    }
  }, [user, navigate]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // Keep the active sessions list live: a new request from another user, or a
  // status change made elsewhere, should appear without a manual refresh.
  // Debounce 250ms so a burst of postgres_changes from a single transaction
  // (accept → trigger → audit insert → notification insert) collapses into
  // one reload instead of three.
  const debouncedReloadDashboard = useDebouncedCallback(() => {
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
  }, [user, debouncedReloadDashboard]);

  const openRequestDialog = (teacher: TeachOffer) => {
    setRequestDialog({ kind: "request", teacher });
  };

  const refreshSuggestions = async () => {
    if (recsRefreshing) return;
    setRecsRefreshing(true);
    try {
      const r = await fetchAiSuggestions({ force: true });
      setRecs(r.suggestions);
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

  const acceptSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
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

  const completeSession = async (session: SessionRow) => {
    markBusy(session.id);
    try {
      const { error } = await supabase.rpc("complete_session", { p_session_id: session.id });
      if (error) return toastError(error);
      markSelfAction(session.id, ["session_completed"]);
      toast.success("Session completed and credits transferred");
      void invalidateCreditBalance();
      await loadDashboard();
    } finally {
      clearBusy(session.id);
    }
  };

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

  // Render a neutral spinner — not the dashboard skeleton — until we've
  // verified the user is onboarded. Same visual treatment as /auth/callback so
  // the OAuth handoff into /onboarding is visually one continuous load.
  if (!onboardingGateReady) {
    return <PageLoading variant="simple" />;
  }

  if (loading || !profile) {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 md:py-8 space-y-5 md:space-y-6">
          <Skeleton className="h-56 md:h-72 rounded-3xl" />
          <Skeleton className="h-32 md:h-40 rounded-3xl" />
          <Skeleton className="h-24 rounded-3xl" />
          <div>
            <Skeleton className="mb-3 h-5 w-48 rounded-md" />
            <div className="grid gap-3 md:gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-40 rounded-2xl" />
              <Skeleton className="h-40 rounded-2xl hidden md:block" />
              <Skeleton className="h-40 rounded-2xl hidden lg:block" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  const firstName = profile.full_name?.split(" ")[0] ?? "Friend";
  const nextMoves = pickNextMoves(user.id, sessions, teachers, learning);
  const featuredTeacherIds = new Set(
    nextMoves.flatMap((m) => (m.kind === "match" ? m.teachers.map((t) => t.id) : [])),
  );
  const teachersForRow =
    featuredTeacherIds.size > 0
      ? teachers.filter((t) => !featuredTeacherIds.has(t.id))
      : teachers;
  // The Next Move stack already surfaces pending requests and the soonest upcoming
  // session. Drop them from the Active sessions strip so the same cards don't render twice.
  const featuredSessionIds = new Set(
    nextMoves.flatMap((m) =>
      m.kind === "incoming" || m.kind === "upcoming" ? [m.session.id] : [],
    ),
  );
  const sessionsForStrip =
    featuredSessionIds.size > 0
      ? sessions.filter((s) => !featuredSessionIds.has(s.id))
      : sessions;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 md:py-8 space-y-5 md:space-y-6">
        {/* Hero — landing-inspired soft gradient that shifts with time of day. */}
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
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
                      Or find a learner
                    </Link>
                  ) : (
                    <Link to="/profile" preload="intent">
                      Or teach a skill
                    </Link>
                  )}
                </Button>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                {/* Credits — shown until the CreditsCard takes over at lg. */}
                <span className="inline-flex items-center gap-1.5 lg:hidden">
                  <Coins className="h-4 w-4 text-amber-500" />
                  <span className="font-semibold">{liveCreditBalance ?? 0}</span>
                  <span className="text-muted-foreground">credits</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Flame className="h-4 w-4 text-orange-500" />
                  <span className="font-semibold">{streak}</span>
                  <span className="text-muted-foreground">day streak</span>
                </span>
                <span className="hidden h-1 w-1 rounded-full bg-muted-foreground/40 sm:inline-block" />
                <span className="text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{teachers.length}</span> match
                  {teachers.length === 1 ? "" : "es"}
                </span>
              </div>
            </div>

            {/* Desktop credits card — fills the empty right side with a calm,
                on-brand summary of the user's balance. */}
            <CreditsCard credits={liveCreditBalance ?? 0} />

          </div>
        </section>

        {/* Your Next Move — stacks pending requests + the next upcoming session. */}
        <div className="animate-fade-up space-y-4 md:space-y-5" style={{ animationDelay: "60ms" }}>
          {nextMoves.map((move, i) => (
            <NextMoveCard
              key={
                move.kind === "incoming" || move.kind === "upcoming"
                  ? `${move.kind}-${move.session.id}`
                  : `${move.kind}-${i}`
              }
              next={move}
              userId={user.id}
              busyIds={busyIds}
              matchesHydrated={matchesHydrated}
              onAccept={acceptSession}
              onReject={rejectSession}
              onRequest={openRequestDialog}
            />
          ))}
        </div>

        {/* AI Insight — one headline, expand for more */}
        {aiSuggestionsEnabled && (
          <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
            <AiInsightCard
              recs={recs}
              refreshing={recsRefreshing}
              onRefresh={() => void refreshSuggestions()}
            />
          </div>
        )}

        {/* People who can teach you — same card pattern as AI Insights. Skip the one already shown in Next Move. */}
        {teachersForRow.length > 0 && (
          <div className="animate-fade-up" style={{ animationDelay: "180ms" }}>
            <PeopleSection
              title="People who can teach you"
              icon={<Users className="h-4 w-4 text-brand-purple" />}
              actionLabel="See all"
              actionTo="/explore"
              actionSearch={{ match: true }}
            >
              {teachersForRow.slice(0, 6).map((t) => {
                const learningRow = learning.find((l) => l.skill_id === t.skill_id);
                const myLevel = (learningRow?.current_level ?? "basic") as SkillLevel;
                const nextSlot = teacherAvailability.get(t.user_id);
                const creditsOk = (liveCreditBalance ?? 0) >= t.credits_per_hour;
                const levelOk = (LEVEL_RANK[t.level] ?? 0) >= (LEVEL_RANK[myLevel] ?? 0);
                return (
                  <TeacherScrollCard
                    key={t.id}
                    teacher={t}
                    nextSlot={nextSlot}
                    creditsOk={creditsOk}
                    levelOk={levelOk}
                    busy={busyIds.has(t.id)}
                    onRequest={() => openRequestDialog(t)}
                  />
                );
              })}
            </PeopleSection>
          </div>
        )}

        {/* People you can help — only renders if you teach something AND there are seekers */}
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
                    onOffer={() => void openOfferDialog(s)}
                  />
                );
              })}
            </PeopleSection>
          </div>
        )}

        {/* Active sessions — only renders when there are sessions beyond the one already shown in Next Move. */}
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

        {/* Footer CTA — slim, supportive */}
        <section
          className="animate-fade-up relative overflow-hidden rounded-3xl gradient-brand p-6 md:p-8 shadow-glow"
          style={{ animationDelay: "360ms" }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(at_30%_30%,rgba(255,255,255,0.18),transparent_60%)]" />
          <div className="relative flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-xl md:text-2xl font-bold text-white">
                Teach a skill. Earn credits.
              </h3>
              <p className="mt-1 text-sm md:text-base text-white/85">Help others. Grow together.</p>
            </div>
            <Button
              variant="glass"
              size="lg"
              className="w-[88%] mx-auto h-10 rounded-lg px-5 text-sm md:mx-0 md:w-auto md:h-12 md:rounded-xl md:px-8 md:text-base"
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
        />
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

type NextMove =
  | { kind: "incoming"; session: SessionRow }
  | { kind: "upcoming"; session: SessionRow }
  | { kind: "match"; teachers: TeachOffer[] }
  | { kind: "empty"; hasLearning: boolean };

// Returns every move worth surfacing in the Next Move area, in priority order:
// each pending incoming request (so the user can accept/decline without scrolling),
// then the next upcoming accepted session. Falls back to a single match/empty card
// if there are no actionable sessions at all.
function pickNextMoves(
  userId: string,
  sessions: SessionRow[],
  teachers: TeachOffer[],
  learning: LearnRow[],
): NextMove[] {
  const moves: NextMove[] = [];

  for (const s of sessions) {
    if (s.status === "pending" && (s.initiator_id ?? s.learner_id) !== userId) {
      moves.push({ kind: "incoming", session: s });
    }
  }

  const now = Date.now();
  const upcoming = sessions
    .filter((s) => (s.status === "accepted" || s.status === "active") && s.scheduled_at)
    .map((s) => ({ s, t: Date.parse(s.scheduled_at!) }))
    .filter(({ t }) => !Number.isNaN(t) && t + 60 * 60 * 1000 > now)
    .sort((a, b) => a.t - b.t)[0];
  if (upcoming) moves.push({ kind: "upcoming", session: upcoming.s });

  if (moves.length > 0) return moves;

  if (teachers.length > 0) return [{ kind: "match", teachers: teachers.slice(0, 2) }];
  return [{ kind: "empty", hasLearning: learning.length > 0 }];
}

type NextMoveCardProps = {
  next: NextMove;
  userId: string;
  busyIds: Set<string>;
  matchesHydrated: boolean;
  onAccept: (s: SessionRow) => void;
  onReject: (s: SessionRow) => void;
  onRequest: (t: TeachOffer) => void;
};

function NextMoveCard({
  next,
  userId,
  busyIds,
  matchesHydrated,
  onAccept,
  onReject,
  onRequest,
}: NextMoveCardProps) {
  if (next.kind === "incoming") {
    const s = next.session;
    const isTeacher = s.teacher_id === userId;
    const otherName = isTeacher ? s.learnerName : s.teacherName;
    const action = isTeacher ? "teach" : "learn from";
    return (
      <section className="rounded-3xl border border-brand-purple/25 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
          <Sparkles className="h-3.5 w-3.5" /> Action needed
        </div>
        <h2 className="mt-2 text-xl md:text-2xl font-bold leading-tight">
          {otherName} wants to {action} {s.skills?.name ?? "a skill"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {s.duration_minutes} min · {s.credits} credit{s.credits === 1 ? "" : "s"}
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            variant="hero"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => onAccept(s)}
            disabled={busyIds.has(s.id)}
          >
            {busyIds.has(s.id) ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Accept
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => onReject(s)}
            disabled={busyIds.has(s.id)}
          >
            <X className="h-4 w-4" /> Decline
          </Button>
        </div>
      </section>
    );
  }

  if (next.kind === "upcoming") {
    const s = next.session;
    const isTeacher = s.teacher_id === userId;
    const otherName = isTeacher ? s.learnerName : s.teacherName;
    const startsIn = formatTimeUntil(s.scheduled_at!);
    const joinable = canJoinSession(s.scheduled_at, s.duration_minutes);
    return (
      <section className="rounded-3xl border border-brand-cyan/25 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-cyan font-semibold">
          <Clock className="h-3.5 w-3.5" /> Up next
        </div>
        <h2 className="mt-2 text-xl md:text-2xl font-bold leading-tight">
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
              <Eye className="h-4 w-4" /> Details
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  // Skeleton while the live teacher/seeker query is still resolving. We don't
  // restore these from cache (would flicker as ranking changes once availability
  // lands), so a placeholder card holds the layout instead of paint-then-shift.
  if (!matchesHydrated && (next.kind === "match" || next.kind === "empty")) {
    return (
      <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
          <Sparkles className="h-3.5 w-3.5" /> Top matches for you
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border/40 bg-card/60 p-4"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-8 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
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
        <div className={cn("mt-4 grid gap-4", plural && "md:grid-cols-2 md:gap-5")}>
          {ts.map((t) => (
            <TopMatchTile
              key={t.id}
              teacher={t}
              busy={busyIds.has(t.id)}
              onRequest={() => onRequest(t)}
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
  busy,
  onRequest,
}: {
  teacher: TeachOffer;
  busy: boolean;
  onRequest: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/40 bg-card/60 p-4 transition-all hover:-translate-y-0.5 hover:border-brand-purple/40 hover:shadow-md hover:shadow-brand-purple/5">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-brand-purple/10 to-brand-cyan/10 opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative flex items-center gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: teacher.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 flex-1 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
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
            <p className="text-xs text-muted-foreground truncate">
              Teaches {teacher.skills?.name}
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
        <Button
          variant="hero"
          size="sm"
          className="shrink-0 rounded-full px-4"
          onClick={onRequest}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageCircle className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Request</span>
        </Button>
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

type AiInsightCardProps = {
  recs: AiSuggestion[] | null;
  refreshing: boolean;
  onRefresh: () => void;
};

function AiInsightCard({ recs, refreshing, onRefresh }: AiInsightCardProps) {
  if (recs === null) {
    return (
      <section className="rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-11 w-11 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </section>
    );
  }

  if (recs.length === 0) return null;

  const visible = recs.slice(0, 4);

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-gradient-to-br from-brand-purple/15 to-brand-cyan/15 blur-2xl" />
      <div className="relative flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <div className="inline-flex h-7 w-7 items-center justify-center rounded-lg gradient-brand-soft">
            <Sparkles className="h-3.5 w-3.5 text-brand-cyan" />
          </div>
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground font-semibold">
            AI Suggestions
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh insights"
          title="Refresh insights"
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-full text-muted-foreground/70 hover:text-brand-purple hover:bg-brand-purple/10 active:scale-95 transition-all disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
      </div>

      <div className="relative mt-4 grid gap-3 md:grid-cols-2 md:gap-4">
        {visible.map((r, i) => (
          <InsightTile key={`v-${i}`} suggestion={r} />
        ))}
      </div>
    </section>
  );
}

function InsightTile({ suggestion }: { suggestion: AiSuggestion }) {
  const meta = SUGGESTION_TYPE_META[suggestion.type] ?? SUGGESTION_TYPE_META.general;
  const Icon = meta.icon;

  const tileClass =
    "group relative overflow-hidden rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 text-left transition-all hover:border-brand-purple/40 hover:bg-background/70 hover:shadow-sm hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple/40 cursor-pointer block";

  const inner = (
    <>
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-xl opacity-70 group-hover:opacity-100 transition-opacity",
          meta.bg,
        )}
      />
      <div className="flex items-start gap-3 pl-1">
        <div
          className={cn(
            "h-10 w-10 shrink-0 rounded-xl flex items-center justify-center",
            meta.bg,
          )}
        >
          <Icon className={cn("h-5 w-5", meta.fg)} />
        </div>
        <p className="text-sm leading-snug pt-1.5 line-clamp-2">{suggestion.message}</p>
        <ArrowRight className="ml-auto h-4 w-4 shrink-0 mt-2 text-muted-foreground/40 transition-all group-hover:text-brand-purple group-hover:translate-x-0.5" />
      </div>
    </>
  );

  const action = suggestion.action;
  if (!action) {
    return <div className={cn(tileClass, "cursor-default")}>{inner}</div>;
  }

  // Each Link variant has different param/search typing, so switch on kind
  // rather than building the props dynamically. Server always sends one of
  // these four; an unknown kind would silently render a non-link tile.
  if (action.kind === "user") {
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
    if (action.mode === "learners") search.mode = "learners";
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
    return (
      <Link to="/skills" preload="intent" className={tileClass}>
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
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
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
  nextSlot: string | null | undefined;
  creditsOk: boolean;
  levelOk: boolean;
  busy: boolean;
  onRequest: () => void;
};

function TeacherScrollCard({
  teacher,
  nextSlot,
  creditsOk,
  levelOk,
  busy,
  onRequest,
}: TeacherScrollCardProps) {
  const chip = !creditsOk
    ? { label: `Need ${teacher.credits_per_hour} cr/hr`, tone: "warn" as const }
    : nextSlot
      ? {
          label: `Free ${new Date(nextSlot).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
          tone: "ok" as const,
        }
      : !levelOk
        ? { label: `Above your level`, tone: "neutral" as const }
        : { label: `${teacher.credits_per_hour} cr/hr`, tone: "neutral" as const };

  return (
    <div className="group rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 transition-all hover:border-brand-purple/40 hover:bg-background/70 hover:shadow-sm">
      <div className="flex items-start gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: teacher.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 flex-1 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
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
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {teacher.skills?.name} · <span className="capitalize">{teacher.level}</span>
            </div>
            <span
              className={cn(
                "mt-1.5 inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                chip.tone === "ok"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : chip.tone === "warn"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "border-border bg-secondary text-muted-foreground",
              )}
            >
              {chip.tone === "ok" && <Check className="h-2.5 w-2.5" />}
              {chip.label}
            </span>
          </div>
        </Link>
        <Button
          variant="hero"
          size="sm"
          className="shrink-0 rounded-full px-3"
          onClick={onRequest}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageCircle className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Request</span>
        </Button>
      </div>
    </div>
  );
}

type SeekerScrollCardProps = {
  seeker: Seeker;
  matchLabel: string;
  busy: boolean;
  onOffer: () => void;
};

function SeekerScrollCard({ seeker, matchLabel, busy, onOffer }: SeekerScrollCardProps) {
  return (
    <div className="group rounded-xl border border-border/40 bg-background/40 p-3 md:p-4 transition-all hover:border-brand-cyan/40 hover:bg-background/70 hover:shadow-sm">
      <div className="flex items-start gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: seeker.user_id }}
          preload="intent"
          className="flex items-center gap-3 min-w-0 flex-1 -m-1 p-1 rounded-xl transition-colors hover:bg-secondary/50"
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
        <Button
          variant="hero"
          size="sm"
          className="shrink-0 rounded-full px-3"
          onClick={onOffer}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <HandHeart className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Offer</span>
        </Button>
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
