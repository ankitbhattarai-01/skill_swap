import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search-config";
import {
  ChevronRight,
  Clock,
  Coins,
  Compass,
  History as HistoryIcon,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  Tag,
  Trash2,
  User as UserIcon,
  Video,
  X,
} from "lucide-react";

type Scope = "all" | "pages" | "skills" | "people" | "sessions" | "messages";

type BaseResult = {
  id: string;
  title: string;
  subtitle: string;
  section: SectionKey;
};

type PageResult = BaseResult & {
  type: "page";
  to: string;
  search?: Record<string, unknown>;
};
type CategoryResult = BaseResult & { type: "category"; category: string };
type SkillResult = BaseResult & { type: "skill"; skillName: string };
type PersonResult = BaseResult & { type: "person"; userId: string };
type SessionResult = BaseResult & { type: "session"; sessionId: string };
type MessageResult = BaseResult & {
  type: "message";
  sessionId: string;
  snippet: string;
};
type RecentResult = BaseResult & { type: "recent"; query: string };
type ActionResult = BaseResult & { type: "action"; query: string };

type SearchResult =
  | PageResult
  | CategoryResult
  | SkillResult
  | PersonResult
  | SessionResult
  | MessageResult
  | RecentResult
  | ActionResult;

type SectionKey =
  | "Pages"
  | "Categories"
  | "Skills"
  | "People"
  | "Sessions"
  | "Messages"
  | "Recent"
  | "Actions";

const SECTION_ORDER: SectionKey[] = [
  "Actions",
  "Pages",
  "Categories",
  "Skills",
  "People",
  "Sessions",
  "Messages",
  "Recent",
];

const RECENT_SEARCH_KEY = "skillswap-recent-searches";
const MAX_RECENT_SEARCHES = 6;
const MIN_QUERY_LENGTH = 2;

const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pages", label: "Pages" },
  { key: "skills", label: "Skills" },
  { key: "people", label: "People" },
  { key: "sessions", label: "Sessions" },
  { key: "messages", label: "Messages" },
];

const PAGES: PageResult[] = [
  {
    type: "page",
    id: "page-dashboard",
    title: "Dashboard",
    subtitle: "Your home base",
    section: "Pages",
    to: "/dashboard",
  },
  {
    type: "page",
    id: "page-explore",
    title: "Explore Skills",
    subtitle: "Browse what students teach",
    section: "Pages",
    to: "/explore",
  },
  {
    type: "page",
    id: "page-history",
    title: "History",
    subtitle: "Past sessions and reviews",
    section: "Pages",
    to: "/history",
  },
  {
    type: "page",
    id: "page-credits",
    title: "Credits",
    subtitle: "Earn and spend credits",
    section: "Pages",
    to: "/credits",
  },
  {
    type: "page",
    id: "page-messages",
    title: "Messages",
    subtitle: "Conversations with teachers",
    section: "Pages",
    to: "/messages",
  },
  {
    type: "page",
    id: "page-profile",
    title: "Profile",
    subtitle: "Edit your skills and bio",
    section: "Pages",
    to: "/profile",
  },
];

const SUGGESTED_SEARCHES = ["guitar", "python", "design", "spanish", "math", "writing"];

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function pushRecent(term: string) {
  const trimmed = term.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return;
  try {
    const existing = loadRecent();
    const next = [
      trimmed,
      ...existing.filter((s) => s.toLowerCase() !== trimmed.toLowerCase()),
    ].slice(0, MAX_RECENT_SEARCHES);
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch {
    // Ignored — recent searches are best-effort only.
  }
}

function highlight(text: string, term: string): ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const idx = lower.indexOf(lowerTerm);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-primary/20 px-0.5 text-primary">
        {text.slice(idx, idx + term.length)}
      </mark>
      {text.slice(idx + term.length)}
    </>
  );
}

function ResultIcon({ type }: { type: SearchResult["type"] }) {
  const className = "h-4 w-4";
  switch (type) {
    case "page":
      return <Compass className={className} />;
    case "category":
      return <Tag className={className} />;
    case "skill":
      return <Sparkles className={className} />;
    case "person":
      return <UserIcon className={className} />;
    case "session":
      return <Video className={className} />;
    case "message":
      return <MessageSquare className={className} />;
    case "recent":
      return <Clock className={className} />;
    case "action":
      return <Search className={className} />;
    default:
      return <Search className={className} />;
  }
}

function PageBadge({ to }: { to: string }) {
  const className = "h-3.5 w-3.5";
  if (to === "/dashboard") return <LayoutDashboard className={className} />;
  if (to === "/explore") return <Compass className={className} />;
  if (to === "/history") return <HistoryIcon className={className} />;
  if (to === "/credits") return <Coins className={className} />;
  if (to === "/messages") return <MessageSquare className={className} />;
  if (to === "/profile") return <UserIcon className={className} />;
  return <Compass className={className} />;
}

export function GlobalSearch({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allCategories, setAllCategories] = useState<string[]>([]);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;

  // Load distinct categories once for category suggestions and empty-state chips.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("skills")
        .select("category")
        .not("category", "is", null)
        .limit(200);
      if (cancelled) return;
      const unique = Array.from(
        new Set((data ?? []).map((row) => row.category).filter((c): c is string => Boolean(c))),
      ).sort();
      setAllCategories(unique);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global keyboard shortcuts: Ctrl/Cmd+K and `/` to focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      } else if (event.key === "/" && !isTyping) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Reset selection when results or query change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [trimmedQuery, scope, open]);

  // Debounced search across selected scopes.
  useEffect(() => {
    if (!hasQuery) {
      setResults([]);
      setLoading(false);
      return;
    }

    // PostgREST .or() parses commas and parentheses as syntax separators and
    // treats * % _ as wildcards inside ILIKE. Anything else risks 400s or
    // very expensive scans (VAL-002 in the audit). Whitelist what we keep
    // rather than trying to enumerate everything that's hostile.
    const safeTerm = trimmedQuery
      .replace(/[^\p{L}\p{N}\s.\-_'@]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (safeTerm.length < MIN_QUERY_LENGTH) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const includeSkills = scope === "all" || scope === "skills";
        const includePeople = scope === "all" || scope === "people";
        const includeSessions = (scope === "all" || scope === "sessions") && Boolean(user);
        const includeMessages = (scope === "all" || scope === "messages") && Boolean(user);

        const skillsPromise = includeSkills
          ? supabase
              .from("skills")
              .select("id, name, category")
              .or(`name.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`)
              .limit(6)
          : Promise.resolve({ data: [], error: null });

        const profilesPromise = includePeople
          ? supabase
              .from("profiles")
              .select("id, full_name, bio")
              .or(`full_name.ilike.%${safeTerm}%,bio.ilike.%${safeTerm}%`)
              .limit(6)
          : Promise.resolve({ data: [], error: null });

        // Push the skill-name/category match down to PostgREST via a foreign
        // filter on the joined skills row instead of pulling the user's 40
        // most-recent sessions and filtering on the client. `!inner` forces
        // the join so the foreign filter narrows the result set; sessions
        // without a skill_id are already excluded from the client filter
        // below, so this is the same shape.
        const sessionsPromise = includeSessions
          ? supabase
              .from("sessions")
              .select(
                "id, status, scheduled_at, learner_id, teacher_id, skills:skill_id!inner(name, category)",
              )
              .or(`learner_id.eq.${user!.id},teacher_id.eq.${user!.id}`)
              .or(`name.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`, {
                foreignTable: "skills",
              })
              .order("updated_at", { ascending: false })
              .limit(20)
          : Promise.resolve({ data: [], error: null });

        const messagesPromise = includeMessages
          ? supabase
              .from("messages")
              .select("id, session_id, text, created_at, sender_id")
              .ilike("text", `%${safeTerm}%`)
              .order("created_at", { ascending: false })
              .limit(6)
          : Promise.resolve({ data: [], error: null });

        const [skillsResult, profilesResult, sessionsResult, messagesResult] = await Promise.all([
          skillsPromise,
          profilesPromise,
          sessionsPromise,
          messagesPromise,
        ]);
        if (cancelled) return;

        const collected: SearchResult[] = [];

        // Pages — match against the static page list.
        if (scope === "all" || scope === "pages") {
          const lower = safeTerm.toLowerCase();
          for (const page of PAGES) {
            if (
              page.title.toLowerCase().includes(lower) ||
              page.subtitle.toLowerCase().includes(lower)
            ) {
              collected.push(page);
            }
          }
        }

        // Categories — match the cached distinct list.
        if (includeSkills) {
          const lower = safeTerm.toLowerCase();
          const matchingCategories = allCategories
            .filter((c) => c.toLowerCase().includes(lower))
            .slice(0, 4);
          for (const category of matchingCategories) {
            collected.push({
              type: "category",
              id: `category-${category}`,
              title: category,
              subtitle: "Browse this category in Explore",
              section: "Categories",
              category,
            });
          }
        }

        // Skills.
        for (const skill of (skillsResult.data ?? []) as {
          id: string;
          name: string;
          category: string | null;
        }[]) {
          collected.push({
            type: "skill",
            id: `skill-${skill.id}`,
            title: skill.name,
            subtitle: skill.category ? `Skill in ${skill.category}` : "Skill",
            section: "Skills",
            skillName: skill.name,
          });
        }

        // People.
        for (const profile of (profilesResult.data ?? []) as {
          id: string;
          full_name: string | null;
          bio: string | null;
        }[]) {
          if (profile.id === user?.id) continue;
          collected.push({
            type: "person",
            id: `person-${profile.id}`,
            title: profile.full_name ?? "Student",
            subtitle: profile.bio ? profile.bio.slice(0, 60) : "View profile",
            section: "People",
            userId: profile.id,
          });
        }

        // Sessions — server already narrowed by skill name/category via the
        // foreign filter; this client pass is now just a defensive belt-and-
        // suspenders in case the foreign filter ever returns extra rows.
        type SessionRowShape = {
          id: string;
          status: string;
          scheduled_at: string | null;
          learner_id: string | null;
          teacher_id: string | null;
          skills: { name: string; category: string | null } | null;
        };
        const sessionRows = (sessionsResult.data ?? []) as SessionRowShape[];
        const lower = safeTerm.toLowerCase();
        for (const session of sessionRows) {
          const skillName = session.skills?.name ?? "";
          const skillCat = session.skills?.category ?? "";
          if (!skillName.toLowerCase().includes(lower) && !skillCat.toLowerCase().includes(lower))
            continue;
          const role = session.teacher_id === user?.id ? "Teaching" : "Learning";
          const when = session.scheduled_at
            ? new Date(session.scheduled_at).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : null;
          collected.push({
            type: "session",
            id: `session-${session.id}`,
            title: skillName || "Session",
            subtitle: `${role} - ${session.status}${when ? ` - ${when}` : ""}`,
            section: "Sessions",
            sessionId: session.id,
          });
          if (collected.filter((r) => r.section === "Sessions").length >= 5) break;
        }

        // Messages — RLS scopes to sessions the user belongs to.
        for (const msg of (messagesResult.data ?? []) as {
          id: string;
          session_id: string;
          text: string;
          created_at: string;
          sender_id: string | null;
        }[]) {
          const snippetSource = msg.text;
          const idx = snippetSource.toLowerCase().indexOf(lower);
          const start = Math.max(0, idx - 24);
          const end = Math.min(snippetSource.length, (idx < 0 ? 0 : idx) + safeTerm.length + 32);
          const prefix = start > 0 ? "..." : "";
          const suffix = end < snippetSource.length ? "..." : "";
          const snippet = `${prefix}${snippetSource.slice(start, end)}${suffix}`;
          collected.push({
            type: "message",
            id: `message-${msg.id}`,
            title: snippet || msg.text.slice(0, 60),
            subtitle: new Date(msg.created_at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
            section: "Messages",
            sessionId: msg.session_id,
            snippet,
          });
        }

        // Trailing "Search all" action so Enter is always meaningful.
        collected.push({
          type: "action",
          id: "action-search-all",
          title: `Search Explore for "${trimmedQuery}"`,
          subtitle: "Open the full Explore results",
          section: "Actions",
          query: trimmedQuery,
        });

        setResults(collected);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedQuery, hasQuery, scope, user, allCategories]);

  const emptyStateResults: SearchResult[] = useMemo(() => {
    if (hasQuery) return [];
    const list: SearchResult[] = [];
    if (scope === "all" || scope === "pages") {
      list.push(...PAGES);
    }
    if (scope === "all" || scope === "skills") {
      for (const category of allCategories.slice(0, 4)) {
        list.push({
          type: "category",
          id: `category-${category}`,
          title: category,
          subtitle: "Browse this category in Explore",
          section: "Categories",
          category,
        });
      }
    }
    for (const term of recent) {
      list.push({
        type: "recent",
        id: `recent-${term}`,
        title: term,
        subtitle: "Recent search",
        section: "Recent",
        query: term,
      });
    }
    return list;
  }, [hasQuery, scope, recent, allCategories]);

  const visibleResults = hasQuery ? results : emptyStateResults;

  const grouped = useMemo(() => {
    const groups = new Map<SectionKey, SearchResult[]>();
    for (const result of visibleResults) {
      const arr = groups.get(result.section) ?? [];
      arr.push(result);
      groups.set(result.section, arr);
    }
    const ordered: { section: SectionKey; items: SearchResult[] }[] = [];
    for (const section of SECTION_ORDER) {
      const items = groups.get(section);
      if (items?.length) ordered.push({ section, items });
    }
    return ordered;
  }, [visibleResults]);

  // Flat array used for keyboard navigation indexing.
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  const openResult = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      switch (result.type) {
        case "page":
          // Use as-cast string navigation. /messages and /explore have validateSearch
          // but when search is undefined they default to {}; passing nothing is fine.
          if (result.to === "/explore") {
            navigate({ to: "/explore" });
          } else if (result.to === "/messages") {
            navigate({ to: "/messages" });
          } else if (result.to === "/dashboard") {
            navigate({ to: "/dashboard" });
          } else if (result.to === "/history") {
            navigate({ to: "/history" });
          } else if (result.to === "/credits") {
            navigate({ to: "/credits" });
          } else if (result.to === "/profile") {
            navigate({ to: "/profile" });
          }
          setQuery("");
          break;
        case "category":
          pushRecent(result.category);
          setQuery("");
          navigate({ to: "/explore", search: { q: result.category } });
          break;
        case "skill":
          pushRecent(result.skillName);
          setQuery("");
          navigate({ to: "/explore", search: { q: result.skillName } });
          break;
        case "person":
          if (trimmedQuery) pushRecent(trimmedQuery);
          setQuery("");
          navigate({ to: "/users/$userId", params: { userId: result.userId } });
          break;
        case "session":
          if (trimmedQuery) pushRecent(trimmedQuery);
          setQuery("");
          navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: result.sessionId },
          });
          break;
        case "message":
          if (trimmedQuery) pushRecent(trimmedQuery);
          setQuery("");
          navigate({ to: "/messages", search: { s: result.sessionId } });
          break;
        case "recent":
          setQuery(result.query);
          setOpen(true);
          break;
        case "action":
          pushRecent(result.query);
          setQuery("");
          navigate({ to: "/explore", search: { q: result.query } });
          break;
      }
      setRecent(loadRecent());
    },
    [navigate, trimmedQuery],
  );

  const goToFullSearch = useCallback(() => {
    if (!trimmedQuery) return;
    pushRecent(trimmedQuery);
    setRecent(loadRecent());
    setOpen(false);
    setQuery("");
    navigate({ to: "/explore", search: { q: trimmedQuery } });
  }, [navigate, trimmedQuery]);

  const handleClearRecent = () => {
    try {
      window.localStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      // Ignored.
    }
    setRecent([]);
  };

  // Scroll the highlighted item into view as the selection moves.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-result-index="${selectedIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, open]);

  return (
    <div ref={containerRef} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            if (flat.length === 0) return;
            setSelectedIndex((idx) => (idx + 1) % flat.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (flat.length === 0) return;
            setSelectedIndex((idx) => (idx - 1 + flat.length) % flat.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (flat[selectedIndex]) {
              openResult(flat[selectedIndex]);
            } else {
              goToFullSearch();
            }
          } else if (event.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (event.key === "Tab") {
            // Cycle scopes with Tab/Shift+Tab when dropdown is open.
            if (!open) return;
            event.preventDefault();
            const idx = SCOPES.findIndex((s) => s.key === scope);
            const next = event.shiftKey
              ? (idx - 1 + SCOPES.length) % SCOPES.length
              : (idx + 1) % SCOPES.length;
            setScope(SCOPES[next].key);
          }
        }}
        placeholder={compact ? "Search..." : "Search skills, people, sessions..."}
        className={cn(
          "h-10 rounded-full border-border/50 bg-card/50 pl-10 text-sm placeholder:text-muted-foreground/70 transition-all hover:bg-card/70 focus-visible:border-primary/40 focus-visible:bg-background focus-visible:ring-primary/30",
          query ? "pr-10" : "pr-3",
        )}
        aria-label="Global search"
        aria-expanded={open}
        aria-controls="global-search-listbox"
        role="combobox"
      />
      {query && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery("");
            setResults([]);
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {open && (
        <div
          id="global-search-listbox"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-xl backdrop-blur-xl"
        >
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border/60 px-2 py-2">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setScope(s.key);
                  inputRef.current?.focus();
                }}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                  scope === s.key
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-transparent bg-secondary/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching...
              </div>
            ) : visibleResults.length > 0 ? (
              grouped.map((group) => (
                <div key={group.section} className="mb-1 last:mb-0">
                  <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>{group.section}</span>
                    {group.section === "Recent" && recent.length > 0 && (
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleClearRecent}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium normal-case text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Trash2 className="h-3 w-3" />
                        Clear
                      </button>
                    )}
                  </div>
                  {group.items.map((result) => {
                    const flatIndex = flat.indexOf(result);
                    const isSelected = flatIndex === selectedIndex;
                    return (
                      <button
                        key={result.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-result-index={flatIndex}
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openResult(result)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                          isSelected ? "bg-secondary/80" : "hover:bg-secondary/60",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                            isSelected
                              ? "bg-primary/15 text-primary"
                              : "bg-primary/10 text-primary",
                          )}
                        >
                          {result.type === "page" ? (
                            <PageBadge to={result.to} />
                          ) : (
                            <ResultIcon type={result.type} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {hasQuery ? highlight(result.title, trimmedQuery) : result.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {result.subtitle}
                          </span>
                        </span>
                        {isSelected && (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            ) : hasQuery ? (
              <div className="flex flex-col gap-2 p-3">
                <div className="text-sm text-muted-foreground">
                  No matches for "{trimmedQuery}".
                </div>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={goToFullSearch}
                  className="flex items-center justify-between rounded-xl bg-primary/10 px-3 py-2 text-left text-sm font-semibold text-primary hover:bg-primary/20"
                >
                  Search Explore for "{trimmedQuery}"
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="space-y-3 p-3">
                <div>
                  <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Try searching for
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_SEARCHES.map((term) => (
                      <button
                        key={term}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setQuery(term);
                          inputRef.current?.focus();
                        }}
                        className="rounded-full border border-border/70 bg-secondary/60 px-3 py-1 text-xs font-medium text-foreground/80 hover:bg-secondary"
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="hidden items-center justify-between border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground md:flex">
            <span className="flex items-center gap-3">
              <span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono">↑↓</kbd>{" "}
                navigate
              </span>
              <span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono">↵</kbd> open
              </span>
              <span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono">Tab</kbd>{" "}
                scope
              </span>
              <span>
                <kbd className="rounded border border-border bg-muted px-1 font-mono">Esc</kbd>{" "}
                close
              </span>
            </span>
            <span>
              {flat.length} result{flat.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
