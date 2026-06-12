import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ReportDialog } from "@/components/ReportDialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuthGate } from "@/lib/auth-gate";
import { useAuth } from "@/lib/auth-context";
import { getOrCreateSession, requestSessionsForSlots, type SessionDuration } from "@/lib/sessions";
import { getOrCreateConversation } from "@/lib/conversations";
import { playRequestSentChime } from "@/lib/sounds";
import type { TeacherRating } from "@/lib/ratings";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { TeacherRatingBadge } from "@/components/TeacherRatingBadge";
import { UserAvatar } from "@/components/UserAvatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { signAvatarUrls } from "@/lib/avatars";
import {
  Search,
  MessageCircle,
  Calendar,
  ArrowLeftRight,
  GraduationCap,
  Loader2,
  UserRound,
  Compass,
  Sparkles,
  SlidersHorizontal,
  X,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { useFeatureEnabled } from "@/lib/feature-flags";

// Lazy: SessionRequestDialog pulls in react-day-picker via the Calendar UI.
// Keeping it out of the explore route chunk strips ~40–60kb from first paint
// since the request/offer dialogs only mount when a user actually opens one.
const SessionRequestDialog = lazy(() =>
  import("@/components/SessionRequestDialog").then((m) => ({ default: m.SessionRequestDialog })),
);
import type { MultiSessionParams } from "@/components/SessionRequestDialog";

// Lazy for the same reason: the swap dialog pulls in TeacherSlotPicker and
// only mounts when a mutual-match card's swap button is clicked.
const SwapProposalDialog = lazy(() =>
  import("@/components/SwapProposalDialog").then((m) => ({ default: m.SwapProposalDialog })),
);

type ExploreMode = "teachers" | "learners";

type ExploreSearch = {
  q?: string;
  category?: string;
  level?: SkillLevelFilter;
  sort?: SortOption;
  available?: boolean;
  mode?: ExploreMode;
  match?: boolean;
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
    mode: s.mode === "learners" ? "learners" : undefined,
    match: s.match === true || s.match === "1" || s.match === "true" ? true : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Explore Skills | SkillSwap" },
      {
        name: "description",
        content:
          "Browse skills students can teach you on SkillSwap. Sign up to message and book sessions.",
      },
      { property: "og:title", content: "Explore Skills | SkillSwap" },
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
  // Server-computed "viewer wants to learn this" flag from the explore_teachers
  // RPC. Optional so cached snapshots written before the flag existed still
  // parse; isMatchForUser falls back to the local learning-skill set.
  matches_viewer?: boolean;
  // Server-computed "a direct swap is possible" flag: the viewer wants this
  // skill AND this user wants something the viewer teaches. Optional for the
  // same cached-snapshot reason; absent just hides the swap shortcut.
  swap_match?: boolean;
  skills: { id: string; name: string; category: string | null } | null;
  profiles: {
    id: string;
    full_name: string | null;
    bio: string | null;
    avatar_url: string | null;
  } | null;
};

type LearningSkillRow = {
  id: string;
  user_id: string;
  current_level: "basic" | "intermediate" | "advanced";
  created_at: string;
  // Server-computed "viewer teaches this" flag from the explore_learners RPC.
  matches_viewer?: boolean;
  // Server-computed "a direct swap is possible" flag (mirror of the teacher
  // card: viewer teaches this skill AND this user teaches something the
  // viewer wants to learn).
  swap_match?: boolean;
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
  hasMore?: boolean;
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
  swapMatch: boolean;
  openSession: OpenSessionInfo | undefined;
  rating: TeacherRating | undefined;
  messageBusy: boolean;
  requestBusy: boolean;
  onOpenChat: (row: TeachingSkillRow) => void;
  onRequestSession: (row: TeachingSkillRow) => void;
  onProposeSwap: (userId: string, name: string | null) => void;
};

// Memoized to prevent the whole grid from re-rendering when only filter/search
// input or a single card's busy state changes.
const ExploreSkillCard = memo(function ExploreSkillCard({
  row: r,
  currentUserId,
  matchesUser,
  swapMatch,
  openSession,
  rating,
  messageBusy,
  requestBusy,
  onOpenChat,
  onRequestSession,
  onProposeSwap,
}: ExploreSkillCardProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const hasOpenSession = Boolean(openSession);
  const isSessionActive = openSession && openSession.status !== "pending";
  return (
    <article className="group glass flex h-full flex-col rounded-2xl border border-white/10 p-5 transition-all hover:-translate-y-0.5 hover:border-brand-cyan/30 hover:shadow-glow-blue">
      <div className="flex items-start justify-between gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: r.user_id }}
          preload="intent"
          className="flex min-w-0 items-center gap-3 -m-1 rounded-xl p-1 transition-colors hover:bg-white/5"
        >
          <UserAvatar
            name={r.profiles?.full_name}
            url={r.profiles?.avatar_url}
            className="h-11 w-11 ring-2 ring-white/10 transition-all group-hover:ring-brand-cyan/30"
          />
          <div className="min-w-0">
            <div className="truncate font-semibold">{r.profiles?.full_name ?? "Student"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {r.skills?.category ?? "Skill"}
            </div>
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant="outline" className={LEVEL_COLORS[r.level] + " capitalize"}>
            {r.level}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More actions"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl">
              <DropdownMenuItem asChild>
                <Link to="/users/$userId" params={{ userId: r.user_id }} preload="intent">
                  <UserRound className="h-4 w-4" />
                  View profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setReportOpen(true)}>
                <X className="h-4 w-4" />
                Report
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ReportDialog reportedUserId={r.user_id} open={reportOpen} onOpenChange={setReportOpen} />
        </div>
      </div>

      <h3 className="mt-4 text-lg font-semibold leading-tight">
        Teaches <span className="gradient-brand-text">{r.skills?.name}</span>
      </h3>
      <p className="mt-1.5 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {r.profiles?.bio ?? ""}
      </p>

      {/* Single status line — session state wins over match indicator. */}
      {hasOpenSession ? (
        <div className="mt-3">
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium " +
              (openSession?.status === "pending"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-emerald-500/15 text-emerald-400")
            }
          >
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (openSession?.status === "pending" ? "bg-amber-400" : "bg-emerald-400")
              }
            />
            {openSession?.status === "pending" ? "Pending request" : "Session active"}
          </span>
        </div>
      ) : currentUserId && swapMatch ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-brand-purple">
          <ArrowLeftRight className="h-3 w-3" />
          Mutual match — you can swap
        </div>
      ) : currentUserId && matchesUser ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-brand-cyan">
          <Sparkles className="h-3 w-3" />
          Matches your interests
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between border-t border-white/5 pt-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {r.credits_per_hour}{" "}
          <span className="font-normal text-muted-foreground">credits / hr</span>
        </span>
        <TeacherRatingBadge rating={rating} />
      </div>

      <div className="mt-4 flex gap-2">
        {isSessionActive ? (
          <Button variant="outline" size="icon" aria-label="Open chat" asChild>
            <Link to="/messages" preload="intent" search={{ s: openSession!.sessionId }}>
              <MessageCircle className="h-4 w-4" />
            </Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="icon"
            aria-label="Message"
            disabled={messageBusy}
            title="Message"
            onClick={() => onOpenChat(r)}
          >
            {messageBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageCircle className="h-4 w-4" />
            )}
          </Button>
        )}
        {swapMatch && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Propose swap"
            title="Propose a skill swap — teach each other, no credits"
            onClick={() => onProposeSwap(r.user_id, r.profiles?.full_name ?? null)}
          >
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        )}
        {openSession ? (
          <Button variant="hero" size="sm" className="flex-1" asChild>
            <Link
              to="/sessions/$sessionId"
              preload="intent"
              params={{ sessionId: openSession.sessionId }}
            >
              <Calendar className="h-4 w-4" />
              View session
            </Link>
          </Button>
        ) : (
          <Button
            variant="hero"
            size="sm"
            className="flex-1"
            disabled={requestBusy}
            onClick={() => onRequestSession(r)}
          >
            {requestBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calendar className="h-4 w-4" />
            )}
            Request session
          </Button>
        )}
      </div>
    </article>
  );
});

type ExploreLearnerCardProps = {
  row: LearningSkillRow;
  currentUserId: string | undefined;
  matchesUser: boolean;
  swapMatch: boolean;
  busy: boolean;
  onOffer: (row: LearningSkillRow) => void;
  onProposeSwap: (userId: string, name: string | null) => void;
};

const ExploreLearnerCard = memo(function ExploreLearnerCard({
  row: r,
  currentUserId,
  matchesUser,
  swapMatch,
  busy,
  onOffer,
  onProposeSwap,
}: ExploreLearnerCardProps) {
  const isSelf = currentUserId === r.user_id;
  return (
    <article className="group glass flex h-full flex-col rounded-2xl border border-white/10 p-5 transition-all hover:-translate-y-0.5 hover:border-brand-cyan/30 hover:shadow-glow-blue">
      <div className="flex items-start justify-between gap-3">
        <Link
          to="/users/$userId"
          params={{ userId: r.user_id }}
          preload="intent"
          className="flex min-w-0 items-center gap-3 -m-1 rounded-xl p-1 transition-colors hover:bg-white/5"
        >
          <UserAvatar
            name={r.profiles?.full_name}
            url={r.profiles?.avatar_url}
            className="h-11 w-11 ring-2 ring-white/10 transition-all group-hover:ring-brand-cyan/30"
          />
          <div className="min-w-0">
            <div className="truncate font-semibold">{r.profiles?.full_name ?? "Student"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {r.skills?.category ?? "Skill"}
            </div>
          </div>
        </Link>
        <Badge variant="outline" className={LEVEL_COLORS[r.current_level] + " capitalize shrink-0"}>
          {r.current_level}
        </Badge>
      </div>

      <h3 className="mt-4 text-lg font-semibold leading-tight">
        Wants <span className="gradient-brand-text">{r.skills?.name ?? "a skill"}</span>
      </h3>
      <p className="mt-1.5 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {r.profiles?.bio ?? ""}
      </p>

      {swapMatch ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-brand-purple">
          <ArrowLeftRight className="h-3 w-3" />
          Mutual match — you can swap
        </div>
      ) : matchesUser ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-400">
          <Sparkles className="h-3 w-3" />
          You teach this
        </div>
      ) : null}

      <div className="mt-auto flex gap-2 pt-4">
        {swapMatch && !isSelf && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Propose swap"
            title="Propose a skill swap — teach each other, no credits"
            onClick={() => onProposeSwap(r.user_id, r.profiles?.full_name ?? null)}
          >
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="hero"
          size="sm"
          className="flex-1"
          onClick={() => onOffer(r)}
          disabled={busy || isSelf}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MessageCircle className="h-4 w-4" />
          )}
          Offer help
        </Button>
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

function setExploreCache(
  rows: TeachingSkillRow[],
  ratings: Map<string, TeacherRating>,
  hasMore: boolean,
) {
  try {
    sessionStorage.setItem(
      EXPLORE_CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        rows,
        ratings: Array.from(ratings.entries()),
        hasMore,
      } satisfies ExploreCache),
    );
  } catch {
    // Cache is only used to avoid skeleton flashes.
  }
}

// Page size for the server-side discovery RPCs. Each fetch asks for one extra
// row to learn whether another page exists without a second count query.
const EXPLORE_PAGE_SIZE = 24;

function isAbortError(error: unknown) {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : String((error as { message?: string }).message ?? "");
  return message.includes("AbortError") || message.includes("aborted");
}

type DiscoveryPageParams = {
  query: string;
  category: string;
  level: SkillLevelFilter;
  matchOnly: boolean;
  sort: string;
  offset: number;
  signal?: AbortSignal;
};

// One page of the teacher directory, filtered/ranked/paginated in Postgres by
// the explore_teachers RPC. Rows are reshaped into the embedded-select shape
// the cards already render; ratings ride along from the same query.
async function fetchTeacherPage({
  query,
  category,
  level,
  matchOnly,
  sort,
  offset,
  signal,
}: DiscoveryPageParams) {
  const rpc = supabase.rpc("explore_teachers", {
    p_query: query.length > 0 ? query : null,
    p_category: category !== "All" ? category : null,
    p_level: level !== "all" ? level : null,
    p_match_only: matchOnly,
    p_sort: sort,
    p_limit: EXPLORE_PAGE_SIZE + 1,
    p_offset: offset,
  });
  const { data, error } = await (signal ? rpc.abortSignal(signal) : rpc);
  if (error) throw error;
  const all = data ?? [];
  const pageRows = all.slice(0, EXPLORE_PAGE_SIZE);
  const rows: TeachingSkillRow[] = pageRows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    level: r.level as TeachingSkillRow["level"],
    credits_per_hour: r.credits_per_hour,
    created_at: r.created_at,
    matches_viewer: r.matches_viewer,
    swap_match: r.swap_match,
    skills: { id: r.skill_id, name: r.skill_name, category: r.skill_category },
    profiles: { id: r.user_id, full_name: r.full_name, bio: r.bio, avatar_url: r.avatar_url },
  }));
  const ratings: [string, TeacherRating][] = pageRows
    .filter((r) => Number(r.rating_count) > 0)
    .map((r) => [r.user_id, { average: Number(r.rating_average), count: Number(r.rating_count) }]);
  return { rows, ratings, hasMore: all.length > EXPLORE_PAGE_SIZE };
}

async function fetchLearnerPage({
  query,
  category,
  level,
  matchOnly,
  sort,
  offset,
  signal,
}: DiscoveryPageParams) {
  const rpc = supabase.rpc("explore_learners", {
    p_query: query.length > 0 ? query : null,
    p_category: category !== "All" ? category : null,
    p_level: level !== "all" ? level : null,
    p_match_only: matchOnly,
    p_sort: sort,
    p_limit: EXPLORE_PAGE_SIZE + 1,
    p_offset: offset,
  });
  const { data, error } = await (signal ? rpc.abortSignal(signal) : rpc);
  if (error) throw error;
  const all = data ?? [];
  const pageRows = all.slice(0, EXPLORE_PAGE_SIZE);
  const rows: LearningSkillRow[] = pageRows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    current_level: r.current_level as LearningSkillRow["current_level"],
    created_at: r.created_at,
    matches_viewer: r.matches_viewer,
    swap_match: r.swap_match,
    skills: { id: r.skill_id, name: r.skill_name, category: r.skill_category },
    profiles: { id: r.user_id, full_name: r.full_name, bio: r.bio, avatar_url: r.avatar_url },
  }));
  return { rows, hasMore: all.length > EXPLORE_PAGE_SIZE };
}

// Swap raw storage paths for signed display URLs on a page of rows. Returns
// the same shape so callers can drop the result straight into state.
async function withSignedAvatars<T extends { profiles: ExploreProfile | null }>(
  rows: T[],
): Promise<T[]> {
  const paths = Array.from(
    new Set(rows.map((r) => r.profiles?.avatar_url).filter((p): p is string => Boolean(p))),
  );
  if (paths.length === 0) return rows;
  const signed = await signAvatarUrls(paths, {
    width: 128,
    height: 128,
    quality: 75,
    resize: "cover",
  });
  return rows.map((row) =>
    row.profiles
      ? {
          ...row,
          profiles: {
            ...row.profiles,
            avatar_url: row.profiles.avatar_url
              ? (signed.get(row.profiles.avatar_url) ?? null)
              : null,
          },
        }
      : row,
  );
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
  const [hasMore, setHasMore] = useState(false);
  const [teacherLoadingMore, setTeacherLoadingMore] = useState(false);
  // Skill categories for the filter popover — the full catalog, fetched once,
  // instead of just whatever categories appear on the loaded page.
  const [categories, setCategories] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [requestRow, setRequestRow] = useState<TeachingSkillRow | null>(null);
  // Learner mode: rows of people seeking skills + the seeker we're offering help to.
  const [learnerRows, setLearnerRows] = useState<LearningSkillRow[]>([]);
  const [learnerHasMore, setLearnerHasMore] = useState(false);
  const [learnerLoadingMore, setLearnerLoadingMore] = useState(false);
  const [offerRow, setOfferRow] = useState<LearningSkillRow | null>(null);
  // Swap shortcut from a mutual-match card — the dialog loads the full
  // reciprocal match itself, so only the counterpart's id/name is needed.
  const [swapTarget, setSwapTarget] = useState<{ userId: string; name?: string } | null>(null);
  const [myCredits, setMyCredits] = useState<number | null>(null);
  const [myLearningSkillIds, setMyLearningSkillIds] = useState<Set<string>>(new Set());
  // Skills the viewer can teach — used in learner mode to highlight rows that
  // match what they offer and to default the offer dialog's credits/hour.
  const [myTeachingPrices, setMyTeachingPrices] = useState<Map<string, number>>(new Map());
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
  const mode: ExploreMode = search.mode === "learners" ? "learners" : "teachers";
  const matchOnly = Boolean(search.match) && Boolean(user);
  const updateSearch = (partial: Partial<ExploreSearch>) => {
    void navigate({ to: "/explore", search: { ...search, ...partial }, replace: true });
  };
  const setMatchOnly = (next: boolean) => updateSearch({ match: next ? true : undefined });
  const setMode = (next: ExploreMode) =>
    updateSearch({ mode: next === "learners" ? "learners" : undefined });
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

  // Search box: keep keystrokes local and only push to the URL (which drives
  // the server-side query) after the user pauses, so we don't fire one RPC per
  // character.
  const [searchText, setSearchText] = useState(query);
  useEffect(() => {
    setSearchText(query);
  }, [query]);
  const pushQueryToUrl = useDebouncedCallback((next: string) => {
    updateSearch({ q: next.length > 0 ? next : undefined });
  }, 300);
  const onSearchChange = (next: string) => {
    setSearchText(next);
    pushQueryToUrl(next);
  };

  // Server sort key. "available_soon" has no server-side ranking (next-slot
  // needs teachers_free_time_status, which is too heavy to ORDER BY across all
  // candidates) so it fetches by rating and reorders the page locally.
  const serverSort =
    sortOption === "newest" ? "newest" : sortOption === "default" ? "default" : "rated";

  useEffect(() => {
    if (!user) {
      setMyCredits(null);
      setMyLearningSkillIds(new Set());
      setMyTeachingPrices(new Map());
      setOpenSessions(new Map());
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const [{ data: creditBalance }, { data: learning }, { data: teaching }, { data: sessions }] =
        await Promise.all([
          supabase.rpc("my_credit_balance").abortSignal(controller.signal),
          supabase
            .from("user_learning_skills")
            .select("skill_id")
            .eq("user_id", user.id)
            .abortSignal(controller.signal),
          supabase
            .from("user_teaching_skills")
            .select("skill_id, credits_per_hour")
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
      const priceMap = new Map<string, number>();
      for (const row of teaching ?? []) {
        if (row.skill_id) priceMap.set(row.skill_id, row.credits_per_hour ?? 4);
      }
      setMyTeachingPrices(priceMap);
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

  // Monotonic tokens so a late response from a previous filter generation (or
  // a stale "load more") can never clobber newer state.
  const teacherSeqRef = useRef(0);
  const learnerSeqRef = useRef(0);
  // Teacher ids whose availability has already been requested — avoids
  // re-fetching the same ids when more pages append.
  const availabilityFetchedRef = useRef(new Set<string>());

  // Availability is per-teacher, not per-filter; accumulate it as pages load.
  const loadAvailabilityFor = useCallback(
    async (teacherIds: string[], seq: number, signal?: AbortSignal) => {
      if (!user) return;
      const fresh = Array.from(new Set(teacherIds)).filter(
        (id) => id !== user.id && !availabilityFetchedRef.current.has(id),
      );
      if (fresh.length === 0) return;
      for (const id of fresh) availabilityFetchedRef.current.add(id);
      // The RPC caps at 100 ids per call.
      for (let i = 0; i < fresh.length; i += 100) {
        const batch = fresh.slice(i, i + 100);
        const rpc = supabase.rpc("teachers_free_time_status", {
          p_teacher_ids: batch,
          p_duration_minutes: 30,
          p_horizon_days: 7,
        });
        const { data, error } = await (signal ? rpc.abortSignal(signal) : rpc);
        if (error || seq !== teacherSeqRef.current) return;
        setIntersections((prev) => {
          const next = new Map(prev);
          for (const r of data ?? []) next.set(r.teacher_id, r.next_slot);
          return next;
        });
      }
    },
    [user],
  );

  useEffect(() => {
    // Availability is viewer-independent but only fetched for signed-in
    // viewers; reset the dedupe set when the viewer changes.
    availabilityFetchedRef.current = new Set();
    setIntersections(new Map());
  }, [user?.id]);

  // Full category catalog for the filter popover, fetched once.
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const { data, error } = await supabase
        .from("skills")
        .select("category")
        .not("category", "is", null)
        .limit(1000)
        .abortSignal(controller.signal);
      if (!alive || error) return;
      setCategories(
        Array.from(
          new Set((data ?? []).map((r) => r.category).filter((c): c is string => Boolean(c))),
        ).sort(),
      );
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  // Load learners (people seeking skills) lazily — only when the user toggles
  // to learner mode. Filtered/paginated server-side by explore_learners.
  useEffect(() => {
    if (mode !== "learners") return;
    const seq = ++learnerSeqRef.current;
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const page = await fetchLearnerPage({
          query,
          category: categoryFilter,
          level: levelFilter,
          matchOnly,
          sort: sortOption === "newest" ? "newest" : "default",
          offset: 0,
          signal: controller.signal,
        });
        if (!alive || seq !== learnerSeqRef.current) return;
        // First paint without avatars (initials only) so cards show instantly.
        setLearnerRows(
          page.rows.map((row) => ({
            ...row,
            profiles: row.profiles ? { ...row.profiles, avatar_url: null } : null,
          })),
        );
        setLearnerHasMore(page.hasMore);
        setLoading(false);

        const signedRows = await withSignedAvatars(page.rows);
        if (!alive || seq !== learnerSeqRef.current) return;
        setLearnerRows(signedRows);
      } catch (error) {
        if (!alive || seq !== learnerSeqRef.current || isAbortError(error)) return;
        toast.error(error instanceof Error ? error.message : "Could not load learners");
        setLearnerRows([]);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [mode, query, categoryFilter, levelFilter, matchOnly, sortOption, user?.id]);

  const loadMoreLearners = async () => {
    if (learnerLoadingMore || !learnerHasMore || loading) return;
    const seq = learnerSeqRef.current;
    setLearnerLoadingMore(true);
    try {
      const page = await fetchLearnerPage({
        query,
        category: categoryFilter,
        level: levelFilter,
        matchOnly,
        sort: sortOption === "newest" ? "newest" : "default",
        offset: learnerRows.length,
      });
      if (seq !== learnerSeqRef.current) return;
      const signedRows = await withSignedAvatars(page.rows);
      if (seq !== learnerSeqRef.current) return;
      setLearnerRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...signedRows.filter((r) => !seen.has(r.id))];
      });
      setLearnerHasMore(page.hasMore);
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(error instanceof Error ? error.message : "Could not load more learners");
      }
    } finally {
      setLearnerLoadingMore(false);
    }
  };

  // Teacher directory: one server-filtered page at a time. Re-runs whenever a
  // server-relevant input changes; the seq token + abort controller make any
  // in-flight previous load a no-op.
  useEffect(() => {
    if (mode !== "teachers") return;
    const seq = ++teacherSeqRef.current;
    let alive = true;
    const controller = new AbortController();

    // The sessionStorage snapshot only matches the pristine view (no filters,
    // default sort); anything else must hit the server.
    const pristine =
      query.length === 0 &&
      categoryFilter === "All" &&
      levelFilter === "all" &&
      !matchOnly &&
      sortOption === "default";
    const cached = pristine ? getExploreCache() : null;
    if (cached) {
      setRows(cached.rows);
      setRatings(new Map(cached.ratings));
      setHasMore(Boolean(cached.hasMore));
      setLoading(false);
    } else {
      setLoading(true);
    }

    (async () => {
      try {
        const page = await fetchTeacherPage({
          query,
          category: categoryFilter,
          level: levelFilter,
          matchOnly,
          sort: serverSort,
          offset: 0,
          signal: controller.signal,
        });
        if (!alive || seq !== teacherSeqRef.current) return;

        // First paint without avatars (initials only) so cards show instantly;
        // signed avatar URLs are merged in once they resolve.
        const initialRows = page.rows.map((row) => ({
          ...row,
          profiles: row.profiles ? { ...row.profiles, avatar_url: null } : null,
        }));
        setRows(initialRows);
        setRatings(new Map(page.ratings));
        setHasMore(page.hasMore);
        setLoading(false);
        if (pristine) setExploreCache(initialRows, new Map(page.ratings), page.hasMore);

        const signedRows = await withSignedAvatars(page.rows);
        if (!alive || seq !== teacherSeqRef.current) return;
        setRows(signedRows);
        if (pristine) setExploreCache(signedRows, new Map(page.ratings), page.hasMore);

        await loadAvailabilityFor(
          page.rows.map((r) => r.user_id),
          seq,
          controller.signal,
        );
      } catch (error) {
        if (!alive || seq !== teacherSeqRef.current || isAbortError(error)) return;
        toast.error(error instanceof Error ? error.message : "Could not load skills");
        if (!cached) setRows([]);
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [
    mode,
    query,
    categoryFilter,
    levelFilter,
    matchOnly,
    serverSort,
    sortOption,
    user?.id,
    loadAvailabilityFor,
  ]);

  const loadMoreTeachers = async () => {
    if (teacherLoadingMore || !hasMore || loading) return;
    const seq = teacherSeqRef.current;
    setTeacherLoadingMore(true);
    try {
      const page = await fetchTeacherPage({
        query,
        category: categoryFilter,
        level: levelFilter,
        matchOnly,
        sort: serverSort,
        offset: rows.length,
      });
      if (seq !== teacherSeqRef.current) return;
      const signedRows = await withSignedAvatars(page.rows);
      if (seq !== teacherSeqRef.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...signedRows.filter((r) => !seen.has(r.id))];
      });
      setRatings((prev) => new Map([...prev, ...page.ratings]));
      setHasMore(page.hasMore);
      void loadAvailabilityFor(
        page.rows.map((r) => r.user_id),
        seq,
      );
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(error instanceof Error ? error.message : "Could not load more skills");
      }
    } finally {
      setTeacherLoadingMore(false);
    }
  };

  const isMatchForUser = useCallback(
    (row: TeachingSkillRow) =>
      row.matches_viewer ?? Boolean(row.skills && myLearningSkillIds.has(row.skills.id)),
    [myLearningSkillIds],
  );

  const intersectionSlotMs = useCallback(
    (uid: string) => {
      const slot = intersections.get(uid);
      if (!slot) return null;
      const t = Date.parse(slot);
      return Number.isNaN(t) ? null : t;
    },
    [intersections],
  );

  // Search / category / level / match filtering and the default / rated /
  // newest orderings now happen server-side in explore_teachers. Locally we
  // only hide the viewer's own rows (a cached snapshot can predate sign-in),
  // apply the availability toggle, and reorder for "available soonest" —
  // whose next-slot signal arrives per page after first paint.
  const filtered = useMemo(() => {
    const visible = rows.filter((r) => {
      if (user && r.user_id === user.id) return false;
      if (onlyAvailable && intersectionSlotMs(r.user_id) == null) return false;
      return true;
    });
    if (sortOption !== "available_soon") return visible;
    return [...visible].sort((a, b) => {
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
    });
  }, [rows, user, onlyAvailable, sortOption, ratings, intersectionSlotMs]);

  const learnerMatchesMe = useCallback(
    (row: LearningSkillRow) =>
      row.matches_viewer ?? Boolean(row.skills && myTeachingPrices.has(row.skills.id)),
    [myTeachingPrices],
  );

  const filteredLearners = useMemo(
    () => learnerRows.filter((r) => !(user && r.user_id === user.id)),
    [learnerRows, user],
  );

  const proposeSwapTo = useCallback(
    (userId: string, name: string | null) => {
      requireAuth(() => {
        setSwapTarget({ userId, name: name ?? undefined });
      }, "Sign in to propose a swap.");
    },
    [requireAuth],
  );

  const offerHelp = useCallback(
    (row: LearningSkillRow) => {
      requireAuth(() => {
        if (!row.skills) return;
        setOfferRow(row);
      }, "Sign in to offer help.");
    },
    [requireAuth],
  );

  const confirmOffer = async (duration: SessionDuration, scheduledAt: string): Promise<void> => {
    if (!user || !offerRow?.skills) return;
    setBusyAction(`offer-${offerRow.id}`);
    try {
      const creditsPerHour = myTeachingPrices.get(offerRow.skills.id) ?? 4;
      const { sessionId, error } = await getOrCreateSession({
        learnerId: offerRow.user_id,
        teacherId: user.id,
        initiatorId: user.id,
        skillId: offerRow.skills.id,
        creditsPerHour,
        durationMinutes: duration,
        scheduledAt,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (sessionId) {
        playRequestSentChime();
        toast.success("Help offered. Message them now to discuss before they accept.");
        setOfferRow(null);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const openChat = useCallback(
    (row: TeachingSkillRow) => {
      requireAuth(() => {
        void (async () => {
          if (!user) return;
          setBusyAction(`message-${row.id}`);
          // Chat is decoupled from sessions: open (or lazily create) the
          // conversation with this user. No session request is created — that
          // stays an explicit action via the "Request session" button.
          const { conversationId, error } = await getOrCreateConversation(row.user_id);
          setBusyAction(null);
          if (error) {
            toast.error(error.message);
            return;
          }
          if (conversationId) navigate({ to: "/messages", search: { u: row.user_id } });
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
        toast.success("Session requested. You can message them now while you wait.");
        setRequestRow(null);
      }
    } finally {
      setBusyAction(null);
    }
  };

  // Multi-session path from the same dialog: book one ordinary pending session
  // per chosen slot. Each shows up for the teacher to accept individually, just
  // like a single request — credits are only escrowed as each is accepted.
  const requestMultiple = async (params: MultiSessionParams): Promise<void> => {
    if (!user || !requestRow?.skills) return;
    setBusyAction(`request-${requestRow.id}`);
    try {
      const { created, error } = await requestSessionsForSlots({
        learnerId: user.id,
        teacherId: requestRow.user_id,
        skillId: requestRow.skills.id,
        creditsPerHour: requestRow.credits_per_hour,
        durationMinutes: params.durationMinutes,
        startTimes: params.startTimes,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (created > 0) {
        playRequestSentChime();
        toast.success(
          `Requested ${created} ${created === 1 ? "session" : "sessions"}. The teacher accepts each one.`,
        );
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

  const availabilityFilterAvailable = Boolean(user) && intersections.size > 0;
  const activeFilterCount =
    (categoryFilter !== "All" ? 1 : 0) +
    (levelFilter !== "all" ? 1 : 0) +
    (onlyAvailable && availabilityFilterAvailable ? 1 : 0) +
    (matchOnly ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;
  const clearAllFilters = () => {
    void navigate({
      to: "/explore",
      search: { q: search.q, mode: search.mode, sort: search.sort },
      replace: true,
    });
  };
  const activeLevelLabel = LEVELS.find((l) => l.key === levelFilter)?.label ?? "All levels";

  return (
    <div className="min-h-screen flex flex-col">
      <section className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 md:pt-8">
        <div className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong shadow-glow border border-white/10">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          <div className="relative flex flex-col gap-6 p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
              <div>
                <h1 className="text-4xl md:text-5xl font-bold">
                  Explore <span className="gradient-brand-text">Skills</span>
                </h1>
                <p className="text-muted-foreground mt-2 max-w-xl">
                  {mode === "teachers"
                    ? "Browse what students are teaching. Message them and book a session."
                    : "Browse students looking to learn. Offer help in a skill you teach."}
                </p>
              </div>
              <div className="relative w-full md:max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchText}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Search skills, people, categories…"
                  className="pl-9 h-11 glass border-white/10"
                />
              </div>
            </div>

            {/* Mode toggle + control bar share one row on desktop. */}
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div
                role="tablist"
                aria-label="Explore mode"
                className="inline-flex rounded-full border border-border/40 bg-card/60 p-1 backdrop-blur self-start"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "teachers"}
                  onClick={() => setMode("teachers")}
                  className={
                    "rounded-full px-4 py-1.5 text-sm font-medium transition-colors " +
                    (mode === "teachers"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  Find a teacher
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "learners"}
                  onClick={() => setMode("learners")}
                  className={
                    "rounded-full px-4 py-1.5 text-sm font-medium transition-colors " +
                    (mode === "learners"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  Find a learner
                </button>
              </div>

              {!loading && (
                <div className="flex items-center gap-2 self-start md:self-auto">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className={
                          "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors " +
                          (hasActiveFilters
                            ? "border-brand-purple/40 bg-brand-purple/15 text-brand-purple hover:bg-brand-purple/20"
                            : "border-white/10 bg-white/5 text-foreground hover:bg-white/10")
                        }
                      >
                        <SlidersHorizontal className="h-4 w-4" />
                        Filters
                        {hasActiveFilters && (
                          <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-purple/30 px-1.5 text-[11px] font-semibold text-brand-purple">
                            {activeFilterCount}
                          </span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      sideOffset={8}
                      className="w-80 rounded-2xl border-white/10 bg-popover/95 p-0 backdrop-blur-xl shadow-glow"
                    >
                      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                        <p className="text-sm font-semibold">Filters</p>
                        <button
                          type="button"
                          onClick={clearAllFilters}
                          disabled={!hasActiveFilters}
                          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Clear all
                        </button>
                      </div>
                      <div className="max-h-[60vh] overflow-y-auto p-4 space-y-5">
                        {categories.length > 0 && (
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Category
                            </p>
                            <div className="flex flex-wrap gap-1.5">
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
                          </div>
                        )}

                        <div>
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Skill level
                          </p>
                          <div className="flex flex-wrap gap-1.5">
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
                        </div>

                        {availabilityFilterAvailable && (
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Availability
                            </p>
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
                          </div>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>

                  <Select
                    value={sortOption}
                    onValueChange={(value) => setSortOption(value as SortOption)}
                  >
                    <SelectTrigger
                      id="explore-sort"
                      aria-label="Sort by"
                      className="h-auto rounded-full border-white/10 bg-white/5 px-4 py-2 text-sm text-foreground shadow-none focus:ring-2 focus:ring-primary/40"
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
              )}
            </div>

            {/* Active filter chips — only render when something is set so the
                row collapses entirely otherwise. */}
            {hasActiveFilters && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Active:</span>
                {categoryFilter !== "All" && (
                  <button
                    type="button"
                    onClick={() => setCategoryFilter("All")}
                    className="inline-flex items-center gap-1 rounded-full border border-brand-cyan/40 bg-brand-cyan/15 px-2.5 py-1 text-xs text-brand-cyan hover:bg-brand-cyan/25 transition-colors"
                  >
                    {categoryFilter}
                    <X className="h-3 w-3" />
                  </button>
                )}
                {levelFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => setLevelFilter("all")}
                    className="inline-flex items-center gap-1 rounded-full border border-brand-purple/40 bg-brand-purple/15 px-2.5 py-1 text-xs text-brand-purple hover:bg-brand-purple/25 transition-colors"
                  >
                    {activeLevelLabel}
                    <X className="h-3 w-3" />
                  </button>
                )}
                {onlyAvailable && availabilityFilterAvailable && (
                  <button
                    type="button"
                    onClick={() => setOnlyAvailable(false)}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Sparkles className="h-3 w-3" />
                    Free this week
                    <X className="h-3 w-3" />
                  </button>
                )}
                {matchOnly && (
                  <button
                    type="button"
                    onClick={() => setMatchOnly(false)}
                    className="inline-flex items-center gap-1 rounded-full border border-brand-cyan/40 bg-brand-cyan/15 px-2.5 py-1 text-xs text-brand-cyan hover:bg-brand-cyan/25 transition-colors"
                  >
                    {mode === "teachers" ? "Matches what I want to learn" : "Matches what I teach"}
                    <X className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl w-full px-4 sm:px-6 pt-6 pb-16">
        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-6 h-48 animate-pulse" />
            ))}
          </div>
        ) : mode === "teachers" ? (
          filtered.length === 0 ? (
            <div
              className="animate-fade-up glass rounded-3xl p-12 text-center"
              style={{ animationDelay: "120ms" }}
            >
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
            <>
              <div className="grid auto-rows-fr sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map((r, i) => (
                  <div
                    key={r.id}
                    className="animate-fade-up h-full"
                    style={{ animationDelay: `${Math.min(120 + i * 40, 440)}ms` }}
                  >
                    <ExploreSkillCard
                      row={r}
                      currentUserId={user?.id}
                      matchesUser={isMatchForUser(r)}
                      swapMatch={Boolean(user) && Boolean(r.swap_match)}
                      openSession={
                        r.skills ? openSessions.get(`${r.user_id}:${r.skills.id}`) : undefined
                      }
                      rating={ratings.get(r.user_id)}
                      messageBusy={busyAction === `message-${r.id}`}
                      requestBusy={busyAction === `request-${r.id}`}
                      onOpenChat={openChat}
                      onRequestSession={requestSession}
                      onProposeSwap={proposeSwapTo}
                    />
                  </div>
                ))}
              </div>
              {hasMore && (
                <div className="mt-8 flex justify-center">
                  <Button
                    variant="outline"
                    disabled={teacherLoadingMore}
                    onClick={() => void loadMoreTeachers()}
                  >
                    {teacherLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                    Load more teachers
                  </Button>
                </div>
              )}
            </>
          )
        ) : filteredLearners.length === 0 ? (
          <div
            className="animate-fade-up glass rounded-3xl p-12 text-center"
            style={{ animationDelay: "120ms" }}
          >
            <UserRound className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-lg font-semibold">No learners yet</p>
            <p className="text-muted-foreground mt-1 max-w-md mx-auto">
              Nobody is currently looking for a skill that matches your filters. Try a different
              category, or check back soon.
            </p>
          </div>
        ) : (
          <>
            <div className="grid auto-rows-fr sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredLearners.map((r, i) => (
                <div
                  key={r.id}
                  className="animate-fade-up h-full"
                  style={{ animationDelay: `${Math.min(120 + i * 40, 440)}ms` }}
                >
                  <ExploreLearnerCard
                    row={r}
                    currentUserId={user?.id}
                    matchesUser={learnerMatchesMe(r)}
                    swapMatch={Boolean(user) && Boolean(r.swap_match)}
                    busy={busyAction === `offer-${r.id}`}
                    onOffer={offerHelp}
                    onProposeSwap={proposeSwapTo}
                  />
                </div>
              ))}
            </div>
            {learnerHasMore && (
              <div className="mt-8 flex justify-center">
                <Button
                  variant="outline"
                  disabled={learnerLoadingMore}
                  onClick={() => void loadMoreLearners()}
                >
                  {learnerLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load more learners
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {requestRow && (
        <Suspense fallback={null}>
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
            allowMultiSession
            teacherName={requestRow.profiles?.full_name ?? "Teacher"}
            onConfirmMulti={requestMultiple}
          />
        </Suspense>
      )}

      {offerRow && (
        <Suspense fallback={null}>
          <SessionRequestDialog
            open={offerRow !== null}
            onOpenChange={(open) => {
              if (!open) setOfferRow(null);
            }}
            title="Offer to help"
            skillName={offerRow.skills?.name ?? "skill"}
            creditsPerHour={offerRow.skills ? (myTeachingPrices.get(offerRow.skills.id) ?? 4) : 4}
            availableCredits={null}
            confirmLabel="Send offer"
            busy={busyAction === `offer-${offerRow.id}`}
            learnerId={offerRow.user_id}
            teacherId={user?.id}
            onConfirm={confirmOffer}
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
            otherName={swapTarget.name}
          />
        </Suspense>
      )}
    </div>
  );
}
