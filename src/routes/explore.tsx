import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ReportDialog } from "@/components/ReportDialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuthGate } from "@/lib/auth-gate";
import { useAuth } from "@/lib/auth-context";
import { findAcceptedSession, getOrCreateSession, type SessionDuration } from "@/lib/sessions";
import { playRequestSentChime } from "@/lib/sounds";
import { SessionRequestDialog } from "@/components/SessionRequestDialog";
import { fetchTeacherRatings, type TeacherRating } from "@/lib/ratings";
import { TeacherRatingBadge } from "@/components/TeacherRatingBadge";
import { UserAvatar } from "@/components/UserAvatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { signAvatarUrls } from "@/lib/avatars";
import {
  Search,
  MessageCircle,
  Calendar,
  GraduationCap,
  Loader2,
  UserRound,
  Compass,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useFeatureEnabled } from "@/lib/feature-flags";

type ExploreSearch = {
  q?: string;
  category?: string;
  level?: SkillLevelFilter;
  sort?: SortOption;
  available?: boolean;
};

export const Route = createFileRoute("/explore")({
  validateSearch: (s: Record<string, unknown>): ExploreSearch => ({
    q: typeof s.q === "string" && s.q.length > 0 ? s.q : undefined,
    category: typeof s.category === "string" && s.category.length > 0 ? s.category : undefined,
    level:
      typeof s.level === "string" && LEVELS.some((o) => o.key === s.level)
        ? (s.level as SkillLevelFilter)
        : undefined,
    sort:
      typeof s.sort === "string" && SORTS.some((o) => o.key === s.sort)
        ? (s.sort as SortOption)
        : undefined,
    available: s.available === true || s.available === "1" || s.available === "true",
  }),
  head: () => ({
    meta: [
      { title: "Explore Skills — SkillSwap" },
      {
        name: "description",
        content:
          "Browse skills students can teach you on SkillSwap. Sign up to message and book sessions.",
      },
      { property: "og:title", content: "Explore Skills — SkillSwap" },
      {
        property: "og:description",
        content: "Browse and discover skills shared by students around the world.",
      },
    ],
  }),
  component: ExplorePage,
});

type TeachingSkillRow = {
  id: string;
  user_id: string;
  level: "basic" | "intermediate" | "advanced";
  credits_per_hour: number;
  created_at: string;
  skills: { id: string; name: string; category: string | null } | null;
  profiles: {
    id: string;
    full_name: string | null;
    bio: string | null;
    avatar_url: string | null;
  } | null;
};

type SkillLevelFilter = "all" | "basic" | "intermediate" | "advanced";
type SortOption = "default" | "rated" | "newest" | "available_soon";

const LEVELS: { key: SkillLevelFilter; label: string }[] = [
  { key: "all", label: "All levels" },
  { key: "basic", label: "Basic" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
];

const SORTS: { key: SortOption; label: string }[] = [
  { key: "default", label: "Recommended" },
  { key: "available_soon", label: "Available soonest" },
  { key: "rated", label: "Highest rated" },
  { key: "newest", label: "Newest" },
];

type OpenSessionInfo = {
  sessionId: string;
  status: "pending" | "accepted" | "active";
};

type ExploreProfile = {
  id: string;
  full_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

type ExploreCache = {
  savedAt: number;
  rows: TeachingSkillRow[];
  ratings: [string, TeacherRating][];
};

const LEVEL_COLORS: Record<string, string> = {
  basic: "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20",
  intermediate: "bg-brand-blue/15 text-brand-blue border-brand-blue/25",
  advanced: "bg-brand-purple/15 text-brand-purple border-brand-purple/25",
};

type ExploreSkillCardProps = {
  row: TeachingSkillRow;
  currentUserId: string | undefined;
  matchesUser: boolean;
  openSession: OpenSessionInfo | undefined;
  rating: TeacherRating | undefined;
  hasTimeMatch: boolean;
  messageBusy: boolean;
  requestBusy: boolean;
  onOpenChat: (row: TeachingSkillRow) => void;
  onRequestSession: (row: TeachingSkillRow) => void;
};

// Memoized to prevent the whole grid from re-rendering when only filter/search
// input or a single card's busy state changes.
const ExploreSkillCard = memo(function ExploreSkillCard({
  row: r,
  currentUserId,
  matchesUser,
  openSession,
  rating,
  hasTimeMatch,
  messageBusy,
  requestBusy,
  onOpenChat,
  onRequestSession,
}: ExploreSkillCardProps) {
  const hasOpenSession = Boolean(openSession);
  const sessionStateLabel = openSession
    ? openSession.status === "pending"
      ? "Pending request"
      : "Session active"
    : null;
  return (
    <article className="glass glow-border rounded-2xl p-6 group hover:translate-y-[-2px] transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/users/$userId"
            params={{ userId: r.user_id }}
            className="rounded-full shadow-glow-blue hover:scale-105 transition-transform"
          >
            <UserAvatar
              name={r.profiles?.full_name}
              url={r.profiles?.avatar_url}
              className="h-11 w-11"
            />
          </Link>
          <div>
            <Link
              to="/users/$userId"
              params={{ userId: r.user_id }}
              className="font-semibold hover:text-brand-cyan transition-colors"
            >
              {r.profiles?.full_name ?? "Student"}
            </Link>
            <div className="text-xs text-muted-foreground">{r.skills?.category ?? "Skill"}</div>
          </div>
        </div>
        <Badge variant="outline" className={LEVEL_COLORS[r.level] + " capitalize"}>
          {r.level}
        </Badge>
      </div>

      <h3 className="mt-4 text-lg font-semibold">
        Teaches <span className="gradient-brand-text">{r.skills?.name}</span>
      </h3>
      {r.profiles?.bio && (
        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{r.profiles.bio}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {currentUserId &&
          (matchesUser ? (
            <Badge
              variant="outline"
              className="bg-brand-cyan/15 text-brand-cyan border-brand-cyan/30 text-[10px] uppercase tracking-wide"
            >
              Matches your interests
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="bg-red-500/10 text-red-400 border-red-500/30 text-[10px] uppercase tracking-wide"
            >
              Not in your interests
            </Badge>
          ))}
        {sessionStateLabel && (
          <Badge
            variant="outline"
            className={
              openSession?.status === "pending"
                ? "bg-amber-500/15 text-amber-500 border-amber-500/30 text-[10px] uppercase tracking-wide"
                : "bg-emerald-500/15 text-emerald-500 border-emerald-500/30 text-[10px] uppercase tracking-wide"
            }
          >
            {sessionStateLabel}
          </Badge>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>{r.credits_per_hour} credits / hour</span>
        <TeacherRatingBadge rating={rating} />
      </div>

      {currentUserId && (
        <div className="mt-2">
          {hasTimeMatch ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
              <Sparkles className="h-3 w-3" />
              Free this week
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-muted-foreground">
              No free times posted
            </span>
          )}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/users/$userId" preload="intent" params={{ userId: r.user_id }}>
            <UserRound className="h-4 w-4" />
            Profile
          </Link>
        </Button>
        <ReportDialog reportedUserId={r.user_id} label="Report" />
        {openSession && openSession.status !== "pending" ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/messages" preload="intent" search={{ s: openSession.sessionId }}>
              <MessageCircle className="h-4 w-4" />
              Open Chat
            </Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={messageBusy || hasOpenSession}
            title={hasOpenSession ? "Chat opens after the teacher accepts" : undefined}
            onClick={() => onOpenChat(r)}
          >
            {messageBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageCircle className="h-4 w-4" />
            )}
            Message
          </Button>
        )}
        {openSession ? (
          <Button variant="hero" size="sm" asChild>
            <Link
              to="/sessions/$sessionId"
              preload="intent"
              params={{ sessionId: openSession.sessionId }}
            >
              <Calendar className="h-4 w-4" />
              View Session
            </Link>
          </Button>
        ) : (
          <Button
            variant="hero"
            size="sm"
            disabled={requestBusy}
            onClick={() => onRequestSession(r)}
          >
            {requestBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calendar className="h-4 w-4" />
            )}
            Request
          </Button>
        )}
      </div>
    </article>
  );
});

const EXPLORE_CACHE_KEY = "skillswap-explore-cache";
const EXPLORE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

function getExploreCache() {
  try {
    const raw = sessionStorage.getItem(EXPLORE_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as ExploreCache;
    if (Date.now() - cache.savedAt > EXPLORE_CACHE_MAX_AGE_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function setExploreCache(rows: TeachingSkillRow[], ratings: Map<string, TeacherRating>) {
  try {
    sessionStorage.setItem(
      EXPLORE_CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        rows,
        ratings: Array.from(ratings.entries()),
      } satisfies ExploreCache),
    );
  } catch {
    // Cache is only used to avoid skeleton flashes.
  }
}

function ExplorePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const publicExploreEnabled = useFeatureEnabled("features.public_explore.enabled", true);
  const [rows, setRows] = useState<TeachingSkillRow[]>([]);
  // teacher_id → next free slot the teacher offers (or null if they haven't
  // posted any free `teach` time / are fully booked in the horizon). Loaded
  // after teachers are fetched; sort/filter waits for this so the first
  // render isn't disrupted by a reshuffle.
  const [intersections, setIntersections] = useState<Map<string, string | null>>(new Map());
  const [ratings, setRatings] = useState<Map<string, TeacherRating>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [requestRow, setRequestRow] = useState<TeachingSkillRow | null>(null);
  const [myCredits, setMyCredits] = useState<number | null>(null);
  const [myLearningSkillIds, setMyLearningSkillIds] = useState<Set<string>>(new Set());
  const [openSessions, setOpenSessions] = useState<Map<string, OpenSessionInfo>>(new Map());
  const { user } = useAuth();
  const { requireAuth } = useAuthGate();

  // URL-backed filters. Mirrors the pattern used in /admin/sessions so a back-
  // navigation into /explore restores the user's category/level/sort/search.
  const query = search.q ?? "";
  const categoryFilter = search.category ?? "All";
  const levelFilter: SkillLevelFilter = search.level ?? "all";
  const sortOption: SortOption = search.sort ?? "default";
  const onlyAvailable = Boolean(search.available);
  const updateSearch = (partial: Partial<ExploreSearch>) => {
    void navigate({ to: "/explore", search: { ...search, ...partial }, replace: true });
  };
  const setQuery = (next: string) => updateSearch({ q: next.length > 0 ? next : undefined });
  const setCategoryFilter = (next: string) =>
    updateSearch({ category: next === "All" ? undefined : next });
  const setLevelFilter = (next: SkillLevelFilter) =>
    updateSearch({ level: next === "all" ? undefined : next });
  const setSortOption = (next: SortOption) =>
    updateSearch({ sort: next === "default" ? undefined : next });
  const setOnlyAvailable = (next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(onlyAvailable) : next;
    updateSearch({ available: value ? true : undefined });
  };

  useEffect(() => {
    if (!user) {
      setMyCredits(null);
      setMyLearningSkillIds(new Set());
      setOpenSessions(new Map());
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const [{ data: creditBalance }, { data: learning }, { data: sessions }] = await Promise.all([
        supabase.rpc("my_credit_balance").abortSignal(controller.signal),
        supabase
          .from("user_learning_skills")
          .select("skill_id")
          .eq("user_id", user.id)
          .abortSignal(controller.signal),
        supabase
          .from("sessions")
          .select("id, teacher_id, skill_id, status")
          .eq("learner_id", user.id)
          .in("status", ["pending", "accepted", "active"])
          .abortSignal(controller.signal),
      ]);
      if (!alive) return;
      setMyCredits(creditBalance ?? null);
      setMyLearningSkillIds(new Set((learning ?? []).map((row) => row.skill_id)));
      const map = new Map<string, OpenSessionInfo>();
      for (const session of sessions ?? []) {
        map.set(`${session.teacher_id}:${session.skill_id}`, {
          sessionId: session.id,
          status: session.status as OpenSessionInfo["status"],
        });
      }
      setOpenSessions(map);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [user]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const cached = getExploreCache();
    if (cached) {
      setRows(cached.rows);
      setRatings(new Map(cached.ratings));
      setLoading(false);
    }

    const loadExplore = async () => {
      if (!cached) setLoading(true);
      try {
        const { data, error } = await supabase
          .from("user_teaching_skills")
          .select(
            "id, user_id, level, credits_per_hour, created_at, skills:skill_id(id, name, category)",
          )
          .limit(60)
          .abortSignal(controller.signal);

        if (error) throw error;
        if (!alive) return;

        const teachingRows = data as unknown as TeachingSkillRow[];
        const userIds = Array.from(new Set(teachingRows.map((row) => row.user_id)));
        const profileMap = new Map<string, ExploreProfile>();

        if (userIds.length) {
          const { data: profiles, error: profileError } = await supabase
            .from("profiles")
            .select("id, full_name, bio, avatar_url")
            .in("id", userIds)
            .abortSignal(controller.signal);
          if (profileError) throw profileError;

          for (const profile of profiles ?? []) {
            profileMap.set(profile.id, profile);
          }
        }

        const initialRows = teachingRows.map((row) => ({
          ...row,
          profiles: profileMap.get(row.user_id)
            ? { ...profileMap.get(row.user_id)!, avatar_url: null }
            : null,
        }));

        setRows(initialRows);
        setLoading(false);
        setExploreCache(initialRows, new Map());

        if (!userIds.length) return;

        const profileAvatarPaths = Array.from(profileMap.values()).map((p) => p.avatar_url);
        const [ratingResult, avatarResult] = await Promise.allSettled([
          fetchTeacherRatings(userIds),
          signAvatarUrls(profileAvatarPaths),
        ]);

        if (!alive) return;

        const ratingMap =
          ratingResult.status === "fulfilled"
            ? ratingResult.value
            : new Map<string, TeacherRating>();
        const signedUrlMap =
          avatarResult.status === "fulfilled" ? avatarResult.value : new Map<string, string>();

        const finalRows = teachingRows.map((row) => {
          const profile = profileMap.get(row.user_id);
          return {
            ...row,
            profiles: profile
              ? {
                  ...profile,
                  avatar_url: profile.avatar_url
                    ? (signedUrlMap.get(profile.avatar_url) ?? null)
                    : null,
                }
              : null,
          };
        });

        setRows(finalRows);
        setRatings(ratingMap);
        setExploreCache(finalRows, ratingMap);

        // Bulk teacher-availability lookup. Only makes sense if the viewer
        // is signed in — anonymous explorers see the page without
        // availability badges.
        if (user) {
          const uniqueTeacherIds = Array.from(new Set(userIds)).filter((id) => id !== user.id);
          if (uniqueTeacherIds.length > 0) {
            // Cap at the RPC's 100-ID limit; first page is usually fewer
            // than that anyway.
            const batch = uniqueTeacherIds.slice(0, 100);
            const { data: intRows } = await supabase
              .rpc("teachers_free_time_status", {
                p_teacher_ids: batch,
                p_duration_minutes: 30,
                p_horizon_days: 7,
              })
              .abortSignal(controller.signal);
            if (!alive) return;
            const map = new Map<string, string | null>();
            for (const r of intRows ?? []) {
              map.set(r.teacher_id, r.next_slot);
            }
            setIntersections(map);
          }
        }
      } catch (error) {
        if (!alive) return;
        toast.error(error instanceof Error ? error.message : "Could not load skills");
        if (!cached) setRows([]);
        setLoading(false);
      }
    };

    void loadExplore();
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  const categories = Array.from(
    new Set(rows.map((r) => r.skills?.category).filter((c): c is string => Boolean(c))),
  ).sort();

  const isMatchForUser = (row: TeachingSkillRow) =>
    Boolean(row.skills && myLearningSkillIds.has(row.skills.id));

  const intersectionSlotMs = (uid: string) => {
    const slot = intersections.get(uid);
    if (!slot) return null;
    const t = Date.parse(slot);
    return Number.isNaN(t) ? null : t;
  };

  const filtered = rows
    .filter((r) => {
      if (user && r.user_id === user.id) return false;
      if (categoryFilter !== "All" && r.skills?.category !== categoryFilter) return false;
      if (levelFilter !== "all" && r.level !== levelFilter) return false;
      if (onlyAvailable && intersectionSlotMs(r.user_id) == null) return false;
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        r.skills?.name.toLowerCase().includes(q) ||
        r.skills?.category?.toLowerCase().includes(q) ||
        r.profiles?.full_name?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sortOption === "available_soon") {
        // Teachers with a known next-free slot come first, ordered by
        // soonest. Teachers without posted free times fall to the bottom.
        const aSlot = intersectionSlotMs(a.user_id);
        const bSlot = intersectionSlotMs(b.user_id);
        if (aSlot != null && bSlot != null) return aSlot - bSlot;
        if (aSlot != null) return -1;
        if (bSlot != null) return 1;
        // Tie-breaker: rating.
        const aAvg = ratings.get(a.user_id)?.average ?? 0;
        const bAvg = ratings.get(b.user_id)?.average ?? 0;
        return bAvg - aAvg;
      }
      if (sortOption === "rated") {
        const aAvg = ratings.get(a.user_id)?.average ?? 0;
        const bAvg = ratings.get(b.user_id)?.average ?? 0;
        if (aAvg !== bAvg) return bAvg - aAvg;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if (sortOption === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      // default: availability boost > skill match > rating > recency
      const aSlot = intersectionSlotMs(a.user_id);
      const bSlot = intersectionSlotMs(b.user_id);
      const aAvail = aSlot != null ? 1 : 0;
      const bAvail = bSlot != null ? 1 : 0;
      if (aAvail !== bAvail) return bAvail - aAvail;
      const aMatch = isMatchForUser(a) ? 1 : 0;
      const bMatch = isMatchForUser(b) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      const aAvg = ratings.get(a.user_id)?.average ?? 0;
      const bAvg = ratings.get(b.user_id)?.average ?? 0;
      if (aAvg !== bAvg) return bAvg - aAvg;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const openChat = useCallback(
    (row: TeachingSkillRow) => {
      requireAuth(() => {
        void (async () => {
          if (!user || !row.skills) return;
          setBusyAction(`message-${row.id}`);
          const { data, error } = await findAcceptedSession(user.id, row.user_id, row.skills.id);
          setBusyAction(null);
          if (error) return toast.error(error.message);
          if (!data?.id) {
            toast.error("You can message after the teacher accepts your session request.");
            return;
          }
          navigate({ to: "/messages", search: { s: data.id } });
        })();
      }, "Sign in to message this student.");
    },
    [navigate, requireAuth, user],
  );

  const requestSession = useCallback(
    (row: TeachingSkillRow) => {
      requireAuth(() => {
        if (!row.skills) return;
        setRequestRow(row);
      }, "Sign in to request a session.");
    },
    [requireAuth],
  );

  const confirmRequest = async (duration: SessionDuration, scheduledAt: string): Promise<void> => {
    if (!user || !requestRow?.skills) return;
    setBusyAction(`request-${requestRow.id}`);
    try {
      const { sessionId, error } = await getOrCreateSession({
        learnerId: user.id,
        teacherId: requestRow.user_id,
        initiatorId: user.id,
        skillId: requestRow.skills.id,
        creditsPerHour: requestRow.credits_per_hour,
        durationMinutes: duration,
        scheduledAt,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (sessionId) {
        playRequestSentChime();
        toast.success("Session requested. You can message after it is accepted.");
        setRequestRow(null);
      }
    } finally {
      setBusyAction(null);
    }
  };

  if (!publicExploreEnabled) {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-10">
          <div className="glass flex w-full flex-col items-center rounded-3xl p-8 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Compass className="h-6 w-6" />
            </div>
            <h1 className="text-xl font-semibold">Explore is temporarily unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              An administrator has disabled public skill discovery. Logged-in students can still
              continue active sessions from the dashboard.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button asChild variant="outline">
                <Link to="/">Back to home</Link>
              </Button>
              {user && (
                <Button asChild>
                  <Link to="/dashboard" preload="intent">
                    Open dashboard
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 gradient-hero opacity-60 pointer-events-none" />
        <div className="relative mx-auto max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div>
              <h1 className="text-4xl md:text-5xl font-bold">
                Explore <span className="gradient-brand-text">Skills</span>
              </h1>
              <p className="text-muted-foreground mt-2 max-w-xl">
                Browse what students are teaching. Message them and book a session.
              </p>
            </div>
            <div className="relative w-full md:max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills, people, categories…"
                className="pl-9 h-11 glass border-white/10"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl w-full px-5 sm:px-6 pb-16">
        {!loading && categories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {["All", ...categories].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={
                  "rounded-full border px-3 py-1 text-xs transition-colors " +
                  (categoryFilter === cat
                    ? "bg-brand-cyan/20 border-brand-cyan/40 text-brand-cyan"
                    : "bg-white/5 border-white/10 text-muted-foreground hover:text-foreground")
                }
              >
                {cat}
              </button>
            ))}
          </div>
        )}
        {!loading && (
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setLevelFilter(option.key)}
                  className={
                    "rounded-full border px-3 py-1 text-xs transition-colors " +
                    (levelFilter === option.key
                      ? "bg-brand-purple/20 border-brand-purple/40 text-brand-purple"
                      : "bg-white/5 border-white/10 text-muted-foreground hover:text-foreground")
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {user && intersections.size > 0 && (
                <button
                  type="button"
                  onClick={() => setOnlyAvailable((v) => !v)}
                  aria-pressed={onlyAvailable}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors " +
                    (onlyAvailable
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:text-foreground")
                  }
                >
                  <Sparkles className="h-3 w-3" />
                  Only with free times
                </button>
              )}
              <div className="flex items-center gap-2">
                <label htmlFor="explore-sort">Sort by</label>
                <Select
                  value={sortOption}
                  onValueChange={(value) => setSortOption(value as SortOption)}
                >
                  <SelectTrigger
                    id="explore-sort"
                    className="h-auto rounded-full border-white/10 bg-white/5 px-3 py-1 text-xs text-foreground shadow-none focus:ring-2 focus:ring-primary/40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl">
                    {SORTS.map((option) => (
                      <SelectItem key={option.key} value={option.key} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}
        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-6 h-48 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass rounded-3xl p-12 text-center">
            <GraduationCap className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-lg font-semibold">No skills yet</p>
            <p className="text-muted-foreground mt-1 max-w-md mx-auto">
              {user
                ? "Add a teaching skill to become the first match in the community."
                : "Be the first to share a skill with the community."}
            </p>
            <Button variant="hero" className="mt-6" asChild>
              <Link to={user ? "/profile" : "/signup"}>
                {user ? "Add Teaching Skill" : "Join SkillSwap"}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((r) => (
              <ExploreSkillCard
                key={r.id}
                row={r}
                currentUserId={user?.id}
                matchesUser={isMatchForUser(r)}
                openSession={r.skills ? openSessions.get(`${r.user_id}:${r.skills.id}`) : undefined}
                rating={ratings.get(r.user_id)}
                hasTimeMatch={Boolean(intersections.get(r.user_id))}
                messageBusy={busyAction === `message-${r.id}`}
                requestBusy={busyAction === `request-${r.id}`}
                onOpenChat={openChat}
                onRequestSession={requestSession}
              />
            ))}
          </div>
        )}
      </section>

      {requestRow && (
        <SessionRequestDialog
          open={requestRow !== null}
          onOpenChange={(open) => {
            if (!open) setRequestRow(null);
          }}
          title="Request a session"
          skillName={requestRow.skills?.name ?? "skill"}
          creditsPerHour={requestRow.credits_per_hour}
          availableCredits={myCredits}
          busy={busyAction === `request-${requestRow.id}`}
          learnerId={user?.id}
          teacherId={requestRow.user_id}
          onConfirm={confirmRequest}
        />
      )}
    </div>
  );
}
