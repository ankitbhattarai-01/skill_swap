import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
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
  buildSessionIcsFile,
  downloadSessionIcs,
  type SessionDuration,
} from "@/lib/sessions";
import { playRequestSentChime } from "@/lib/sounds";
import { markSelfAction } from "@/lib/self-action";
import { SessionRequestDialog } from "@/components/SessionRequestDialog";
import { StrikeBanner } from "@/components/StrikeBanner";
import { fetchTeacherRatings, type TeacherRating } from "@/lib/ratings";
import { ConfirmAction } from "@/components/ConfirmAction";
import { UserAvatar } from "@/components/UserAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { signAvatarUrls } from "@/lib/avatars";
import {
  deriveMatchLabel,
  formatLearningMode,
  modeCompatibilityScore,
  rankCandidate,
  type LearningMode,
  type SkillLevel,
} from "@/lib/match";
import type { Enums } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";
import { useInvalidateMyCreditBalance, useMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { queryUserSessions } from "@/lib/session-queries";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

const LEVEL_RANK: Record<string, number> = { basic: 1, intermediate: 2, advanced: 3 };

function MatchChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-red-500/30 bg-red-500/10 text-red-400",
      )}
    >
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label}
    </span>
  );
}

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — SkillSwap" }] }),
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

const LEVEL_COLORS: Record<string, string> = {
  basic: "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20",
  intermediate: "bg-brand-blue/15 text-brand-blue border-brand-blue/25",
  advanced: "bg-brand-purple/15 text-brand-purple border-brand-purple/25",
};

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
  const [recs, setRecs] = useState<AiSuggestion[] | null>(null);
  const [recsRefreshing, setRecsRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    if (!user) return;
    const cache = getDashboardCache(user.id);
    if (!cache) return;

    setProfile(cache.profile);
    setLearning(cache.learning ?? []);
    setTeachers(cache.teachers ?? []);
    setSeekers(cache.seekers ?? []);
    setMyTeaching(cache.myTeaching ?? []);
    setSessions(cache.sessions ?? []);
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
          const { error: onboardedFlipError } = await supabase
            .from("profiles")
            .update({ onboarded: true })
            .eq("id", user.id);
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

      const [learn, myTeach, rawSessions] = await Promise.all([
        loadMyLearningSkills(user.id),
        loadMyTeachingSkills(user.id),
        queryDashboardSessionRows(user.id),
      ]);

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
      });

      setLoading(false);

      void fetchAiSuggestions()
        .then((r) => setRecs(r.suggestions))
        .catch(() => setRecs([]));
    } catch (error) {
      setLoading(false);
      setRecs([]);
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

  if (loading || !profile) {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6">
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-40 rounded-3xl lg:col-span-2" />
            <Skeleton className="h-40 rounded-3xl" />
          </div>
          <Skeleton className="h-44 rounded-3xl" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72 rounded-3xl" />
            <Skeleton className="h-72 rounded-3xl" />
            <Skeleton className="h-72 rounded-3xl" />
            <Skeleton className="h-72 rounded-3xl" />
          </div>
        </main>
      </div>
    );
  }

  const firstName = profile.full_name?.split(" ")[0] ?? "Friend";

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6">
        <StrikeBanner />
        {/* Welcome + Credits */}
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 glass rounded-3xl p-6 md:p-8">
            <div className="text-sm text-muted-foreground">Welcome back,</div>
            <h1 className="text-3xl md:text-4xl font-bold mt-1">{firstName}</h1>
            <p className="text-muted-foreground mt-2 italic">
              "Keep Learning. Keep Teaching. Keep Growing."
            </p>
          </div>
          <div className="relative overflow-hidden rounded-3xl gradient-brand p-6 shadow-glow">
            <div className="absolute inset-0 bg-[radial-gradient(at_80%_20%,rgba(255,255,255,0.18),transparent_60%)]" />
            <div className="relative flex items-start justify-between">
              <div>
                <div className="text-white/80 text-sm font-medium">Your Credits</div>
                <div className="text-5xl font-bold text-white mt-1 flex items-center gap-2">
                  {liveCreditBalance ?? 0}
                  <Coins className="h-7 w-7 text-yellow-300" />
                </div>
                <div className="mt-3 text-white/80 text-xs">
                  Use credits to learn.
                  <br />
                  Earn credits by teaching.
                </div>
              </div>
              <Coins className="h-10 w-10 text-white/30" />
            </div>
          </div>
        </div>

        {/* AI Suggestions */}
        {aiSuggestionsEnabled && (
          <section className="glass rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-brand-cyan" /> AI Suggestions
              </h2>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => void refreshSuggestions()}
                  disabled={recsRefreshing}
                  className="group inline-flex h-10 w-10 items-center justify-center rounded-full border border-brand-purple/20 bg-white/80 text-brand-purple shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-cyan/40 hover:bg-gradient-to-br hover:from-brand-purple/15 hover:via-brand-blue/15 hover:to-brand-cyan/15 hover:text-brand-cyan hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
                  title="Refresh suggestions"
                  aria-label="Refresh AI suggestions"
                >
                  <RefreshCw
                    className={`h-4 w-4 transition-transform group-hover:rotate-90 ${
                      recsRefreshing ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {recs === null &&
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="glass rounded-xl p-4">
                    <Skeleton className="h-8 w-8 rounded-lg mb-2" />
                    <Skeleton className="h-3 w-full mb-1.5" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ))}
              {(recs ?? []).slice(0, 4).map((r, i) => {
                const meta = SUGGESTION_TYPE_META[r.type] ?? SUGGESTION_TYPE_META.general;
                const Icon = meta.icon;
                return (
                  <div
                    key={i}
                    className="glass rounded-xl p-4 hover:bg-white/[0.06] transition-colors"
                  >
                    <div
                      className={`h-8 w-8 rounded-lg ${meta.bg} flex items-center justify-center mb-2`}
                    >
                      <Icon className={`h-4 w-4 ${meta.fg}`} />
                    </div>
                    <p className="text-sm leading-snug">{r.message}</p>
                  </div>
                );
              })}
              {recs && recs.length === 0 && (
                <div className="col-span-full text-sm text-muted-foreground text-center py-4">
                  Add more skills to get personalized suggestions.
                </div>
              )}
            </div>
          </section>
        )}

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Skills I want to learn */}
          <section className="glass rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <GraduationCap className="h-4 w-4 text-brand-cyan" /> Skills I Want to Learn
              </h2>
              <Link
                to="/profile"
                preload="intent"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Edit →
              </Link>
            </div>
            <div className="space-y-3">
              {learning.length === 0 && (
                <EmptyHint text="Add skills you want to learn from your profile." to="/profile" />
              )}
              {learning.map((l) => (
                <div key={l.id} className="glass rounded-xl p-4 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl gradient-brand-soft flex items-center justify-center">
                    <GraduationCap className="h-4 w-4 text-brand-cyan" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{l.skills?.name}</div>
                    <Badge
                      variant="outline"
                      className={LEVEL_COLORS[l.current_level] + " capitalize text-xs mt-0.5"}
                    >
                      {l.current_level}
                    </Badge>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/explore" preload="intent">
                      View
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          </section>

          {/* People who can teach me */}
          <section className="glass rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-brand-purple" /> People Who Can Teach Me
              </h2>
            </div>
            <div className="space-y-3">
              {teachers.length === 0 && (
                <EmptyHint text="No matches yet. Add what you want to learn." to="/profile" />
              )}
              {teachers.map((t) => {
                const learningRow = learning.find((learn) => learn.skill_id === t.skill_id);
                const learningMode = learningRow?.learning_mode ?? profile.learning_mode;
                const myLevel = (learningRow?.current_level ?? "basic") as SkillLevel;
                const teacherLevel = t.level as SkillLevel;
                const timeOk = Boolean(teacherAvailability.get(t.user_id));
                const modeOk = modeCompatibilityScore(learningMode, t.teaching_mode) >= 3;
                const levelOk = (LEVEL_RANK[teacherLevel] ?? 0) >= (LEVEL_RANK[myLevel] ?? 0);
                const creditsOk = (liveCreditBalance ?? 0) >= t.credits_per_hour;
                return (
                  <div
                    key={t.id}
                    className="glass rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center"
                  >
                    <UserAvatar
                      name={t.profiles?.full_name}
                      url={t.profiles?.avatar_url}
                      className="h-10 w-10"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {t.profiles?.full_name ?? "Student"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {t.skills?.name} • <span className="capitalize">{t.level}</span> •{" "}
                        {t.credits_per_hour} cr/hr
                      </div>
                      <div className="mt-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                          Match:
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <MatchChip
                            ok={timeOk}
                            label={
                              timeOk
                                ? `Free ${new Date(teacherAvailability.get(t.user_id)!).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
                                : "No free times posted"
                            }
                          />
                          <MatchChip
                            ok={modeOk}
                            label={
                              modeOk
                                ? `${formatLearningMode(t.teaching_mode)} match`
                                : `Wants ${formatLearningMode(t.teaching_mode)}`
                            }
                          />
                          <MatchChip
                            ok={levelOk}
                            label={levelOk ? `${t.level} level fit` : `Above your ${myLevel} level`}
                          />
                          <MatchChip
                            ok={creditsOk}
                            label={
                              creditsOk
                                ? `${t.credits_per_hour} cr/hr affordable`
                                : `Need ${t.credits_per_hour} cr/hr`
                            }
                          />
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="hero"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => openRequestDialog(t)}
                      disabled={busyIds.has(t.id)}
                    >
                      {busyIds.has(t.id) ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MessageCircle className="h-4 w-4" />
                      )}
                      Request Session
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          {/* People looking for my skills */}
          <section className="glass rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <HandHeart className="h-4 w-4 text-brand-cyan" /> People Looking for My Skills
              </h2>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              You can earn credits by teaching them.
            </p>
            <div className="space-y-3">
              {seekers.length === 0 && (
                <EmptyHint
                  text={
                    myTeaching.length === 0
                      ? "Add skills you can teach to earn credits."
                      : "Nobody is looking yet."
                  }
                  to="/profile"
                />
              )}
              {seekers.map((s) => {
                const teachingMode =
                  myTeaching.find((teach) => teach.skill_id === s.skill_id)?.teaching_mode ??
                  profile.learning_mode;
                return (
                  <div
                    key={s.id}
                    className="glass rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center"
                  >
                    <UserAvatar
                      name={s.profiles?.full_name}
                      url={s.profiles?.avatar_url}
                      className="h-10 w-10"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {s.profiles?.full_name ?? "Student"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        Wants to learn {s.skills?.name} •{" "}
                        <span className="capitalize">{s.current_level}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Badge
                          variant="outline"
                          className="bg-brand-cyan/10 border-brand-cyan/20 text-xs"
                        >
                          {deriveMatchLabel(teachingMode, s.learning_mode, "Learner Match")}
                        </Badge>
                        <Badge variant="outline" className="bg-white/5 border-white/10 text-xs">
                          Learns by {formatLearningMode(s.learning_mode)}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="hero"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => void openOfferDialog(s)}
                      disabled={busyIds.has(s.id)}
                    >
                      {busyIds.has(s.id) && <Loader2 className="h-4 w-4 animate-spin" />}
                      Offer Help
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Active sessions */}
          <section className="glass rounded-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Calendar className="h-4 w-4 text-brand-purple" /> Active Sessions
              </h2>
            </div>
            <div className="space-y-3">
              {sessions.length === 0 && (
                <EmptyHint
                  text="No active sessions yet. Request one from your matches."
                  to="/explore"
                />
              )}
              {sessions.map((session) => {
                const isTeacher = session.teacher_id === user?.id;
                const sessionInitiatorId = session.initiator_id ?? session.learner_id;
                const canRespondToPending =
                  session.status === "pending" &&
                  Boolean(user?.id && user.id !== sessionInitiatorId);
                const otherName = isTeacher ? session.learnerName : session.teacherName;
                const isAcceptedSession =
                  session.status === "accepted" || session.status === "active";
                // Early-release is learner-only and unlocks at the session's
                // halfway point (scheduled_at + duration/2). Server
                // (private.complete_session) re-checks the same time gate
                // AND requires both parties to have attended ≥ 50% of the
                // planned duration via Jitsi. The UI time gate gives the
                // user a clear "appears after HH:MM" expectation; the
                // attendance gate is what kills the Sybil farming path.
                const earlyReleaseUnlockAt = session.scheduled_at
                  ? Date.parse(session.scheduled_at) + (session.duration_minutes * 60_000) / 2
                  : null;
                const earlyReleaseAvailable =
                  isAcceptedSession &&
                  !isTeacher &&
                  earlyReleaseUnlockAt !== null &&
                  earlyReleaseUnlockAt <= Date.now();
                const roomLink = isAcceptedSession
                  ? getVideoRoomUrl({
                      link: session.meet_link,
                      sessionId: session.id,
                      skillName: session.skills?.name,
                    })
                  : "";
                const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
                const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
                const handleAddToCalendar = () => {
                  if (!session.scheduled_at) {
                    toast.error("This session is not scheduled yet.");
                    return;
                  }
                  const ics = buildSessionIcsFile({
                    sessionId: session.id,
                    skillName: session.skills?.name ?? "Skill session",
                    scheduledAt: session.scheduled_at,
                    durationMinutes: session.duration_minutes,
                    meetLink: roomLink || null,
                    organizerName: session.teacherName,
                    attendeeName: session.learnerName,
                  });
                  downloadSessionIcs(`skillswap-${session.id}.ics`, ics);
                };
                return (
                  <div key={session.id} className="glass rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {session.skills?.name ?? "Skill session"}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {isTeacher ? "Learner" : "Teacher"}: {otherName} •{" "}
                          {session.duration_minutes} min • {session.credits} credits
                        </div>
                      </div>
                      <Badge variant="outline" className="capitalize bg-white/5 border-white/10">
                        {session.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canRespondToPending && (
                        <>
                          <Button
                            variant="hero"
                            size="sm"
                            onClick={() => acceptSession(session)}
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
                            onClick={() => rejectSession(session)}
                            disabled={busyIds.has(session.id)}
                          >
                            <X className="h-4 w-4" />
                            Reject
                          </Button>
                        </>
                      )}
                      {isAcceptedSession &&
                        (roomLink ? (
                          <>
                            {joinAllowed ? (
                              <Button variant="outline" size="sm" asChild>
                                <Link
                                  to="/video/$sessionId"
                                  preload="intent"
                                  params={{ sessionId: session.id }}
                                >
                                  <Video className="h-4 w-4" />
                                  Join
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled
                                title={joinHint ?? "Not in session window"}
                              >
                                <Video className="h-4 w-4" />
                                {joinHint ?? "Join"}
                              </Button>
                            )}
                            {session.scheduled_at && (
                              <Button variant="outline" size="sm" onClick={handleAddToCalendar}>
                                <Calendar className="h-4 w-4" />
                                Add to Calendar
                              </Button>
                            )}
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              toast.error(
                                "Video room is unavailable. Open the session details and try again.",
                              )
                            }
                          >
                            <Video className="h-4 w-4" />
                            Join
                          </Button>
                        ))}
                      {session.status !== "rejected" && (
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/sessions/$sessionId"
                            preload="intent"
                            params={{ sessionId: session.id }}
                          >
                            <Eye className="h-4 w-4" />
                            Details
                          </Link>
                        </Button>
                      )}
                      {isAcceptedSession && (
                        <Button variant="outline" size="sm" asChild>
                          <Link to="/messages" preload="intent" search={{ s: session.id }}>
                            <MessageCircle className="h-4 w-4" />
                            Chat
                          </Link>
                        </Button>
                      )}
                      {earlyReleaseAvailable && (
                        <ConfirmAction
                          title="Release credits to your teacher now?"
                          description={`This sends ${session.credits} credits to ${session.teacherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room — otherwise the release will be blocked.`}
                          confirmLabel="Release now"
                          onConfirm={() => completeSession(session)}
                        >
                          <Button variant="hero" size="sm" disabled={busyIds.has(session.id)}>
                            {busyIds.has(session.id) && (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            Complete Session
                          </Button>
                        </ConfirmAction>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* CTA */}
        <section className="relative overflow-hidden rounded-3xl gradient-brand p-8 md:p-10 shadow-glow">
          <div className="absolute inset-0 bg-[radial-gradient(at_30%_30%,rgba(255,255,255,0.18),transparent_60%)]" />
          <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-2xl font-bold text-white">Teach a skill. Earn credits.</h3>
              <p className="text-white/85 mt-1">Help others. Grow together.</p>
            </div>
            <Button variant="glass" size="lg" asChild>
              <Link to="/explore" preload="intent">
                Explore Matches <ArrowRight className="h-4 w-4" />
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

function EmptyHint({ text, to }: { text: string; to: string }) {
  return (
    <div className="text-sm text-muted-foreground py-4 px-4 rounded-xl border border-dashed border-white/10 flex items-center justify-between gap-3">
      <span>{text}</span>
      <Button variant="ghost" size="sm" asChild>
        <Link to={to}>Open</Link>
      </Button>
    </div>
  );
}
