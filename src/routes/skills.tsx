import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowRight,
  Compass,
  MessageCircle,
  Search,
  Sparkles,
  Users,
} from "lucide-react";

type SkillsSearch = { q?: string };

export const Route = createFileRoute("/skills")({
  validateSearch: (s: Record<string, unknown>): SkillsSearch => ({
    q: typeof s.q === "string" && s.q.length > 0 ? s.q : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Browse skills — SkillSwap" },
      {
        name: "description",
        content:
          "A curated catalog of skills peers are teaching on SkillSwap. Sign up to message a peer and book a session.",
      },
      { property: "og:title", content: "Browse skills — SkillSwap" },
      {
        property: "og:description",
        content: "Skills shared by students on SkillSwap. No accounts required to browse.",
      },
    ],
  }),
  component: PublicSkillsPage,
});

type PublicSkill = {
  id: string;
  name: string;
  category: string | null;
  teacherCount: number;
};

const ALL = "All";

function usePublicSkills() {
  const [skills, setSkills] = useState<PublicSkill[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [skillsRes, teachingRes] = await Promise.all([
          supabase.from("skills").select("id, name, category").order("name"),
          supabase
            .from("user_teaching_skills")
            .select("skill_id")
            .limit(5000),
        ]);

        if (cancelled) return;

        const counts = new Map<string, number>();
        for (const row of (teachingRes.data ?? []) as { skill_id: string }[]) {
          counts.set(row.skill_id, (counts.get(row.skill_id) ?? 0) + 1);
        }

        const list: PublicSkill[] = ((skillsRes.data ?? []) as {
          id: string;
          name: string;
          category: string | null;
        }[]).map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          teacherCount: counts.get(s.id) ?? 0,
        }));

        setSkills(list);
      } catch {
        if (!cancelled) setSkills([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { skills, loading };
}

const CATEGORY_ACCENTS: { chip: string; ring: string; glow: string; dot: string }[] = [
  {
    chip: "bg-primary/10 text-primary",
    ring: "hover:border-primary/40",
    glow: "from-primary/25",
    dot: "bg-primary",
  },
  {
    chip: "bg-brand-cyan/10 text-brand-cyan",
    ring: "hover:border-brand-cyan/40",
    glow: "from-brand-cyan/25",
    dot: "bg-brand-cyan",
  },
  {
    chip: "bg-fuchsia-500/10 text-fuchsia-500",
    ring: "hover:border-fuchsia-500/40",
    glow: "from-fuchsia-500/25",
    dot: "bg-fuchsia-500",
  },
  {
    chip: "bg-amber-500/10 text-amber-500",
    ring: "hover:border-amber-500/40",
    glow: "from-amber-500/25",
    dot: "bg-amber-500",
  },
  {
    chip: "bg-emerald-500/10 text-emerald-500",
    ring: "hover:border-emerald-500/40",
    glow: "from-emerald-500/25",
    dot: "bg-emerald-500",
  },
];

function hashString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function accentFor(category: string | null, id: string) {
  const key = category ?? id;
  return CATEGORY_ACCENTS[hashString(key) % CATEGORY_ACCENTS.length];
}

function PublicSkillsPage() {
  const { skills, loading } = usePublicSkills();
  const { q: initialQ } = Route.useSearch();
  const [query, setQuery] = useState(initialQ ?? "");
  const [category, setCategory] = useState<string>(ALL);

  const categories = useMemo(() => {
    if (!skills) return [ALL];
    const set = new Set<string>();
    for (const s of skills) if (s.category) set.add(s.category);
    return [ALL, ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [skills]);

  const filtered = useMemo(() => {
    if (!skills) return [];
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => (category === ALL ? true : s.category === category))
      .filter((s) =>
        q.length === 0
          ? true
          : s.name.toLowerCase().includes(q) ||
            (s.category ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => b.teacherCount - a.teacherCount || a.name.localeCompare(b.name));
  }, [skills, query, category]);

  const totalSkills = skills?.length ?? 0;
  const totalTeachers = skills?.reduce((sum, s) => sum + s.teacherCount, 0) ?? 0;
  const totalCategories = Math.max(0, categories.length - 1);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicNav />

      <main>
        <PublicHero
          totalSkills={totalSkills}
          totalTeachers={totalTeachers}
          totalCategories={totalCategories}
          loading={loading}
          query={query}
          onQueryChange={setQuery}
        />

        <section className="border-t border-border/60">
          <div className="mx-auto max-w-7xl px-6 py-6 lg:py-8">
            <CategoryPills
              categories={categories}
              active={category}
              onChange={setCategory}
            />

            {loading ? (
              <SkeletonGrid />
            ) : filtered.length === 0 ? (
              <EmptyState query={query} category={category} />
            ) : (
              <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((s) => (
                  <SkillCard key={s.id} skill={s} />
                ))}
              </div>
            )}
          </div>
        </section>

        <PublicCTA />
      </main>

      <SiteFooter />
    </div>
  );
}

function PublicNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center">
          <Logo size="sm" />
        </Link>

        <nav
          aria-label="Primary"
          className="hidden items-center gap-8 text-sm font-semibold text-muted-foreground md:flex"
        >
          <Link to="/" className="transition-colors hover:text-foreground">
            Home
          </Link>
          <Link to="/skills" className="text-foreground">
            Browse skills
          </Link>
          <Link to="/credits" className="transition-colors hover:text-foreground">
            Credits
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" asChild>
            <Link to="/login" search={{ redirect: "/dashboard" }}>
              Log in
            </Link>
          </Button>
          <Button variant="hero" size="sm" asChild>
            <Link to="/signup" search={{ redirect: "/onboarding" }}>
              <MessageCircle className="h-4 w-4" />
              Sign up
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

function PublicHero({
  totalSkills,
  totalTeachers,
  totalCategories,
  loading,
  query,
  onQueryChange,
}: {
  totalSkills: number;
  totalTeachers: number;
  totalCategories: number;
  loading: boolean;
  query: string;
  onQueryChange: (next: string) => void;
}) {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(124,58,237,0.08),rgba(20,184,166,0.05)_48%,rgba(255,255,255,0)_82%)]" />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-20 -z-10 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.18),transparent_70%)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-32 -z-10 h-[24rem] w-[24rem] rounded-full bg-[radial-gradient(circle,rgba(20,184,166,0.16),transparent_70%)] blur-3xl"
      />

      <div className="mx-auto max-w-7xl px-6 pb-8 pt-8 lg:pb-10 lg:pt-10">
        <div className="grid items-center gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-cyan backdrop-blur">
              <Compass className="h-3 w-3" />
              The skill catalog
            </div>

            <h1 className="mt-4 text-3xl font-black leading-[1.05] tracking-tight sm:text-4xl lg:text-5xl">
              Every skill on SkillSwap,
              <span className="gradient-brand-text"> in one place.</span>
            </h1>

            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              Browse the catalog freely. Peers and bookings appear after you sign
              up.
            </p>

            <div className="mt-5 max-w-xl">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  placeholder="Search skills or categories…"
                  aria-label="Search skills"
                  className="h-11 rounded-full border-border bg-card/80 pl-11 pr-4 text-base shadow-sm backdrop-blur"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            <StatTile
              value={loading ? "—" : totalSkills.toLocaleString()}
              label={totalSkills === 1 ? "skill" : "skills"}
            />
            <StatTile
              value={loading ? "—" : totalCategories.toLocaleString()}
              label={totalCategories === 1 ? "category" : "categories"}
            />
            <StatTile
              value={loading ? "—" : totalTeachers.toLocaleString()}
              label={totalTeachers === 1 ? "peer teaching" : "peers teaching"}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card/60 px-3 py-4 backdrop-blur sm:px-5">
      <div className="text-2xl font-black tracking-tight gradient-brand-text sm:text-3xl">
        {value}
      </div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function CategoryPills({
  categories,
  active,
  onChange,
}: {
  categories: string[];
  active: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {categories.map((c) => {
        const isActive = c === active;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={
              isActive
                ? "rounded-full border border-transparent bg-foreground px-4 py-1.5 text-sm font-semibold text-background shadow-sm"
                : "rounded-full border border-border bg-card/60 px-4 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            }
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function SkillCard({ skill }: { skill: PublicSkill }) {
  const accent = accentFor(skill.category, skill.id);
  const initial = skill.name.trim().charAt(0).toUpperCase();
  const teaching = skill.teacherCount;

  return (
    <Link
      to="/signup"
      search={{ redirect: "/onboarding" }}
      className={`group relative overflow-hidden rounded-2xl border border-border bg-card/80 p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card ${accent.ring}`}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-gradient-to-br ${accent.glow} to-transparent opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100`}
      />

      <div className="relative flex items-start justify-between gap-3">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-black tracking-tight ${accent.chip}`}
        >
          {initial}
        </div>
        {skill.category && (
          <span className="rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {skill.category}
          </span>
        )}
      </div>

      <h3 className="relative mt-5 text-lg font-black tracking-tight">
        {skill.name}
      </h3>

      <div className="relative mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
          {teaching === 0
            ? "Be the first to teach"
            : teaching === 1
              ? "1 peer teaching"
              : `${teaching} peers teaching`}
        </span>
        <ArrowRight className="h-4 w-4 transition-all group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
    </Link>
  );
}

function SkeletonGrid() {
  return (
    <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="h-[148px] animate-pulse rounded-2xl border border-border bg-card/50"
        />
      ))}
    </div>
  );
}

function EmptyState({ query, category }: { query: string; category: string }) {
  const hasFilter = query.length > 0 || category !== ALL;
  return (
    <div className="mt-12 rounded-3xl border border-dashed border-border bg-card/40 px-8 py-14 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary/70 text-muted-foreground">
        <Search className="h-5 w-5" />
      </div>
      <h3 className="mt-5 text-xl font-black tracking-tight">
        {hasFilter ? "No skills match that filter" : "No skills listed yet"}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {hasFilter
          ? "Try a different category or clear your search."
          : "Be the first peer to list a skill — every student who joins makes this catalog richer."}
      </p>
      <div className="mt-6">
        <Button variant="hero" size="lg" asChild>
          <Link to="/signup" search={{ redirect: "/onboarding" }}>
            Teach your first skill
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function PublicCTA() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-24">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-brand-cyan backdrop-blur">
          <Sparkles className="h-3.5 w-3.5" />
          Ready to swap?
        </div>
        <h2 className="mt-6 text-3xl font-black leading-tight tracking-tight sm:text-5xl">
          Sign up to see who teaches what,
          <span className="block gradient-brand-text pb-1">and book a session.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
          Start with your student email and 10 starter credits. One flat $2 a
          month — no per-session fees.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button variant="hero" size="xl" asChild>
            <Link to="/signup" search={{ redirect: "/onboarding" }}>
              <Users className="h-4 w-4" />
              Create my account
            </Link>
          </Button>
          <Button variant="outline" size="xl" asChild>
            <Link to="/login" search={{ redirect: "/dashboard" }}>
              I already have one
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
