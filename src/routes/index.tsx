import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { ShaderBackground } from "@/components/ShaderBackground";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowRight,
  CalendarCheck,
  ChevronRight,
  Coins,
  LockKeyhole,
  MessageCircle,
  PlayCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SkillSwap - Learn anything from someone who just did" },
      {
        name: "description",
        content:
          "Student skill-exchange platform. One flat $2/month, plus credits to trade peer-to-peer sessions. Verified students, private rooms, no per-class fees.",
      },
      {
        property: "og:title",
        content: "SkillSwap - Learn anything from someone who just did",
      },
      {
        property: "og:description",
        content:
          "Find a peer, book a session, learn face-to-face. Credits, not cash.",
      },
    ],
  }),
  component: LandingPage,
});

const steps: {
  n: string;
  title: string;
  desc: string;
  icon: LucideIcon;
  hint: string;
}[] = [
  {
    n: "01",
    title: "Request",
    desc: "Pick a skill and message a peer who already knows it.",
    icon: Search,
    hint: "Free to browse",
  },
  {
    n: "02",
    title: "Accept",
    desc: "They approve a time. A private session room opens for you both.",
    icon: CalendarCheck,
    hint: "Included in $2/mo",
  },
  {
    n: "03",
    title: "Learn",
    desc: "Meet face-to-face inside SkillSwap. Credits transfer when you finish.",
    icon: PlayCircle,
    hint: "Built-in video",
  },
];

type LandingStats = {
  peerCount: number;
  skillCount: number;
  topSkills: { id: string; name: string; teacherCount: number }[];
};

function useLandingStats() {
  const [stats, setStats] = useState<LandingStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [peersRes, teachingRes] = await Promise.all([
          supabase.from("profiles").select("*", { count: "exact", head: true }),
          supabase
            .from("user_teaching_skills")
            .select("skill_id, skills:skill_id(id, name)")
            .limit(2000),
        ]);

        if (cancelled) return;

        const peerCount = peersRes.count ?? 0;
        const teachingRows =
          (teachingRes.data as
            | { skill_id: string; skills: { id: string; name: string } | null }[]
            | null) ?? [];

        const skillMap = new Map<string, { id: string; name: string; teacherCount: number }>();
        for (const row of teachingRows) {
          if (!row.skills) continue;
          const existing = skillMap.get(row.skills.id);
          if (existing) existing.teacherCount += 1;
          else skillMap.set(row.skills.id, { ...row.skills, teacherCount: 1 });
        }

        const ranked = Array.from(skillMap.values()).sort(
          (a, b) => b.teacherCount - a.teacherCount,
        );

        setStats({
          peerCount,
          skillCount: skillMap.size,
          topSkills: ranked.slice(0, 6),
        });
      } catch {
        if (!cancelled) setStats({ peerCount: 0, skillCount: 0, topSkills: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { stats, loading };
}

const promises: {
  title: string;
  desc: string;
  icon: LucideIcon;
  spec: string;
}[] = [
  {
    title: "Verified students only",
    desc: "Signup is restricted to verified student and major-mail addresses.",
    icon: ShieldCheck,
    spec: "Domain allowlist · Email verification",
  },
  {
    title: "Private session rooms",
    desc: "Each accepted session opens its own room. It closes when you do.",
    icon: LockKeyhole,
    spec: "Per-session room · No video archive",
  },
  {
    title: "No session fees, no surprises",
    desc: "One flat $2/month subscription. Credits handle every peer session.",
    icon: Coins,
    spec: "Flat $2/month · Credits for peer sessions",
  },
];

function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const isSignedIn = Boolean(user);

  useEffect(() => {
    if (!loading && user) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [loading, user, navigate]);

  if (loading || isSignedIn) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-background"
      >
        Skip to content
      </a>
      <LandingNav />

      <LandingContent />
    </div>
  );
}

function LandingContent() {
  const { stats, loading } = useLandingStats();

  return (
    <>
      <main id="main-content">
        <Hero stats={stats} loading={loading} />
        <HowItWorks />
        <Momentum stats={stats} loading={loading} />
        <PrivacyBand />
        <FinalCTA />
      </main>

      <SiteFooter />
    </>
  );
}

function Hero({ stats, loading }: { stats: LandingStats | null; loading: boolean }) {
  return (
    <section className="relative isolate overflow-hidden">
      <ShaderBackground className="pointer-events-none absolute inset-0 -z-10 h-full w-full" />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(124,58,237,0.07),rgba(20,184,166,0.05)_48%,rgba(255,255,255,0)_82%)]" />

      <div className="mx-auto grid max-w-7xl items-center gap-x-10 gap-y-10 px-4 pb-12 pt-8 sm:gap-y-12 sm:px-6 sm:pb-14 sm:pt-10 lg:min-h-[640px] lg:grid-cols-[1.05fr_0.95fr] lg:gap-x-12 lg:pb-20 lg:pt-12 xl:gap-x-16">
        <div className="max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm sm:mb-6 sm:text-sm">
            <Sparkles className="h-3.5 w-3.5 text-brand-cyan sm:h-4 sm:w-4" />
            Student skill exchange powered by credits
          </div>

          <h1 className="text-[2.25rem] font-black leading-[1.05] tracking-normal text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
            Learn what you need.
            <span className="block gradient-brand-text">Teach what you know.</span>
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:mt-6 sm:text-lg sm:leading-8 md:text-xl">
            Skills you need, taught by peers who just nailed them.{" "}
            <span className="font-semibold text-foreground">Two dollars a month.</span>{" "}
            Credits cover every session.
          </p>

          <div className="mt-7 sm:mt-8">
            <Button variant="hero" size="xl" className="w-full sm:w-auto" asChild>
              <Link to="/signup" search={{ redirect: "/onboarding" }}>
                Start swapping
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="mt-6 grid gap-2.5 text-sm text-muted-foreground sm:mt-7 sm:max-w-md sm:grid-cols-3 sm:gap-3">
            <ProofPoint icon={Coins} label="Just $2 a month" />
            <ProofPoint icon={Sparkles} label="10 starter credits" />
            <ProofPoint icon={Video} label="Built-in video" />
          </div>
        </div>

        <HeroCard stats={stats} loading={loading} />
      </div>
    </section>
  );
}

function ProofPoint({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-brand-cyan" />
      <span>{label}</span>
    </div>
  );
}

const heroAccents = [
  { chip: "bg-primary/10 text-primary", dot: "bg-primary", glow: "from-primary/30" },
  { chip: "bg-brand-cyan/10 text-brand-cyan", dot: "bg-brand-cyan", glow: "from-brand-cyan/30" },
  { chip: "bg-fuchsia-500/10 text-fuchsia-500", dot: "bg-fuchsia-500", glow: "from-fuchsia-500/30" },
  { chip: "bg-amber-500/10 text-amber-500", dot: "bg-amber-500", glow: "from-amber-500/30" },
];

function HeroCard({
  stats,
  loading,
}: {
  stats: LandingStats | null;
  loading: boolean;
}) {
  const peerCount = stats?.peerCount ?? 0;
  const skillCount = stats?.skillCount ?? 0;
  const top = stats?.topSkills ?? [];
  const hasFeatured = top.length > 0;

  const [featuredIdx, setFeaturedIdx] = useState(0);
  useEffect(() => {
    if (top.length <= 1) return;
    const id = window.setInterval(() => {
      setFeaturedIdx((i) => (i + 1) % top.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, [top.length]);

  const safeIdx = hasFeatured ? featuredIdx % top.length : 0;
  const featured = hasFeatured ? top[safeIdx] : null;
  const accent = heroAccents[safeIdx % heroAccents.length];
  const trending = top.filter((_, i) => i !== safeIdx).slice(0, 3);

  return (
    <div className="relative mx-auto w-full max-w-md lg:max-w-none">
      <div
        aria-hidden
        className="absolute -inset-12 -z-10 rounded-[3rem] bg-[radial-gradient(55%_60%_at_50%_45%,rgba(124,58,237,0.22),transparent_70%)] blur-3xl"
      />
      <div
        aria-hidden
        className="absolute -bottom-12 -right-10 -z-10 h-44 w-44 rounded-full bg-[radial-gradient(circle,rgba(20,184,166,0.20),transparent_70%)] blur-3xl"
      />

      {trending[0] && (
        <FloatingChip
          label={trending[0].name}
          className="right-6 top-24 hidden animate-[float_6s_ease-in-out_infinite] sm:inline-flex"
        />
      )}
      {trending[1] && (
        <FloatingChip
          label={trending[1].name}
          className="right-14 top-44 hidden animate-[float_7s_ease-in-out_infinite_reverse] sm:inline-flex"
        />
      )}

      <div className="relative rounded-[2rem] border border-border bg-card/95 p-2 shadow-card backdrop-blur">
        <div className="relative overflow-hidden rounded-[1.6rem] border border-border/70 bg-background">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                "radial-gradient(currentColor 1px, transparent 1px)",
              backgroundSize: "18px 18px",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent"
          />
          <div
            aria-hidden
            className={`pointer-events-none absolute -top-24 right-0 h-48 w-48 rounded-full bg-gradient-to-br ${accent.glow} to-transparent opacity-60 blur-3xl transition-colors duration-700`}
          />

          <div className="relative flex items-center justify-between px-5 pt-5 sm:px-7 sm:pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              SkillSwap today
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Live
            </div>
          </div>

          {loading ? (
            <FeaturedSkeleton />
          ) : featured ? (
            <FeaturedSkill
              key={featured.id}
              name={featured.name}
              teacherCount={featured.teacherCount}
              accent={accent}
              total={top.length}
              activeIdx={safeIdx}
            />
          ) : (
            <FeaturedEmpty />
          )}

          <div
            aria-hidden
            className="relative mx-5 h-px bg-gradient-to-r from-border via-border to-transparent sm:mx-7"
          />

          <div className="relative grid grid-cols-2 gap-x-5 px-5 py-4 sm:gap-x-6 sm:px-7 sm:py-5">
            <Stat
              label={peerCount === 1 ? "Student" : "Students"}
              value={loading ? "—" : peerCount.toLocaleString()}
            />
            <Stat
              label={skillCount === 1 ? "Skill" : "Skills"}
              value={loading ? "—" : skillCount.toLocaleString()}
            />
          </div>

          {trending.length > 0 && (
            <div className="relative flex flex-wrap items-center gap-2 border-t border-border/70 bg-secondary/30 px-5 py-3 sm:px-7">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Also live
              </span>
              <div className="flex flex-1 flex-wrap items-center gap-1.5">
                {trending.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] font-semibold text-foreground/80"
                  >
                    <span className="h-1 w-1 rounded-full bg-brand-cyan" />
                    {s.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FloatingChip({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  if (!label) return null;
  return (
    <div
      className={`pointer-events-none absolute z-10 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-bold tracking-tight shadow-card backdrop-blur ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-brand-cyan" />
      {label}
    </div>
  );
}

function FeaturedSkill({
  name,
  teacherCount,
  accent,
  total,
  activeIdx,
}: {
  name: string;
  teacherCount: number;
  accent: (typeof heroAccents)[number];
  total: number;
  activeIdx: number;
}) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <div className="relative px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-6">
      <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
        Featured skill
      </div>

      <div
        key={name}
        className="mt-3 flex items-center gap-3 sm:gap-4 animate-[fadeUp_400ms_ease-out]"
      >
        <div
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl font-black tracking-tight sm:h-16 sm:w-16 sm:text-3xl ${accent.chip}`}
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-2xl font-black leading-tight tracking-tight sm:text-3xl">
            {name}
          </div>
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
            {teacherCount === 1
              ? "1 peer teaching now"
              : `${teacherCount} peers teaching now`}
          </div>
        </div>
      </div>

      {total > 1 && (
        <div className="mt-5 flex items-center gap-1.5">
          {Array.from({ length: Math.min(total, 6) }).map((_, i) => (
            <span
              key={i}
              className={
                i === activeIdx % Math.min(total, 6)
                  ? `h-1 w-6 rounded-full ${accent.dot} transition-all duration-300`
                  : "h-1 w-1.5 rounded-full bg-border transition-all duration-300"
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeaturedEmpty() {
  return (
    <div className="relative px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-6">
      <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
        Featured skill
      </div>
      <div className="mt-3 flex items-center gap-3 sm:gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-dashed border-border bg-secondary/50 text-2xl font-black text-muted-foreground sm:h-16 sm:w-16">
          +
        </div>
        <div className="min-w-0">
          <div className="text-lg font-black leading-tight tracking-tight sm:text-xl">
            Yours could be first.
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Sign up and list a skill — your name shows up here.
          </div>
        </div>
      </div>
    </div>
  );
}

function FeaturedSkeleton() {
  return (
    <div className="px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-6">
      <div className="h-2.5 w-24 rounded-full bg-secondary/70" />
      <div className="mt-4 flex items-center gap-3 sm:gap-4">
        <div className="h-14 w-14 animate-pulse rounded-2xl bg-secondary/70 sm:h-16 sm:w-16" />
        <div className="flex-1 space-y-2">
          <div className="h-6 w-2/3 animate-pulse rounded-md bg-secondary/70" />
          <div className="h-3 w-24 animate-pulse rounded-full bg-secondary/60" />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-black tracking-tight sm:text-2xl">{value}</div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="relative overflow-hidden border-t border-border/60">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_40%_at_50%_0%,rgba(124,58,237,0.06),transparent_70%)]" />

      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-brand-cyan backdrop-blur">
            <Sparkles className="h-3.5 w-3.5" />
            How it works
          </div>
          <h2 className="mt-5 text-3xl font-black tracking-tight sm:mt-6 sm:text-4xl md:text-5xl">
            Three steps. <span className="gradient-brand-text">That's it.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:mt-5 sm:text-lg sm:leading-8">
            One flat $2/month platform fee — after that, exchange skills with
            any peer, any time.
          </p>
        </div>

        <div className="relative mt-12 grid gap-5 sm:mt-16 md:mt-20 md:grid-cols-3 md:gap-5 lg:gap-6">
          <div
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 top-[88px] -z-10 hidden h-px md:block"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, var(--border) 8%, var(--border) 92%, transparent 100%)",
            }}
          />

          {steps.map((step, i) => (
            <StepCard key={step.n} step={step} isLast={i === steps.length - 1} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({
  step,
  isLast,
}: {
  step: (typeof steps)[number];
  isLast: boolean;
}) {
  const Icon = step.icon;
  return (
    <div className="group relative">
      {!isLast && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-3 top-[72px] z-10 hidden h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm md:flex"
        >
          <ChevronRight className="h-4 w-4" />
        </div>
      )}

      <div className="relative h-full overflow-hidden rounded-3xl border border-border bg-card/70 p-6 shadow-card backdrop-blur transition-all duration-300 group-hover:-translate-y-1 group-hover:border-primary/40 group-hover:shadow-glow sm:p-7">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-2 -top-2 select-none text-[7rem] font-black leading-none tracking-tighter gradient-brand-text opacity-10 transition-opacity duration-300 group-hover:opacity-20"
        >
          {step.n}
        </span>

        <div className="relative flex items-center justify-between">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl gradient-brand text-white shadow-glow sm:h-14 sm:w-14">
            <Icon className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
          <span className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
            STEP {step.n}
          </span>
        </div>

        <h3 className="relative mt-6 text-xl font-black tracking-tight sm:mt-7 sm:text-2xl">
          {step.title}
        </h3>
        <p className="relative mt-2 text-sm leading-6 text-muted-foreground sm:mt-3 sm:text-base sm:leading-7">
          {step.desc}
        </p>

        <div className="relative mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-semibold text-foreground/80 sm:mt-6">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-cyan" />
          {step.hint}
        </div>
      </div>
    </div>
  );
}

const skillAccents = [
  { chip: "bg-primary/10 text-primary", border: "hover:border-primary/40", dot: "bg-primary" },
  { chip: "bg-brand-cyan/10 text-brand-cyan", border: "hover:border-brand-cyan/40", dot: "bg-brand-cyan" },
  { chip: "bg-fuchsia-500/10 text-fuchsia-500", border: "hover:border-fuchsia-500/40", dot: "bg-fuchsia-500" },
];

function Momentum({
  stats,
  loading,
}: {
  stats: LandingStats | null;
  loading: boolean;
}) {
  const top = stats?.topSkills ?? [];
  const hasSkills = top.length > 0;
  const fillerSlots = Math.max(0, 3 - top.length);

  return (
    <section className="border-t border-border/60 bg-secondary/25">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand-cyan">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-cyan opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-cyan" />
              </span>
              Live on SkillSwap
            </div>
            <h2 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl md:text-4xl">
              {hasSkills
                ? "What peers are teaching right now"
                : "Be the first to teach"}
            </h2>
          </div>
          <Button variant="outline" size="sm" className="self-start sm:self-auto" asChild>
            <Link to="/skills">See all skills</Link>
          </Button>
        </div>

        {loading ? (
          <div className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-[96px] rounded-2xl border border-border bg-card/60"
              />
            ))}
          </div>
        ) : hasSkills ? (
          <div className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 lg:grid-cols-3">
            {top.map((item, i) => {
              const accent = skillAccents[i % skillAccents.length];
              const initial = item.name.trim().charAt(0).toUpperCase();
              return (
                <Link
                  key={item.id}
                  to="/skills"
                  search={{ q: item.name }}
                  className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card ${accent.border}`}
                >
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-black tracking-tight ${accent.chip}`}
                  >
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-black tracking-tight">
                      {item.name}
                    </div>
                    <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
                      {item.teacherCount === 1
                        ? "1 peer teaching"
                        : `${item.teacherCount} peers teaching`}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground" />
                </Link>
              );
            })}

            {Array.from({ length: fillerSlots }).map((_, i) => (
              <Link
                key={`filler-${i}`}
                to="/signup"
                search={{ redirect: "/onboarding" }}
                className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-dashed border-border/70 bg-transparent p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card/40"
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary/70 text-xl font-black text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  +
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-black tracking-tight text-foreground/80 group-hover:text-foreground">
                    Teach yours
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Earn credits by sharing what you know
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="mt-8 rounded-3xl border border-dashed border-border bg-card/40 px-6 py-10 text-center sm:mt-10 sm:px-8 sm:py-12">
            <p className="text-base text-muted-foreground">
              No skills listed yet. Sign up and add the first one — every peer
              who joins makes the platform more useful.
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
        )}
      </div>
    </section>
  );
}

function PrivacyBand() {
  return (
    <section className="relative isolate overflow-hidden border-y border-border/40 bg-background text-foreground">
      <ShaderBackground
        variant="calm"
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04] dark:opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(currentColor 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:py-24">
        <div className="grid gap-10 sm:gap-14 lg:grid-cols-[1.1fr_0.95fr] lg:gap-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <div className="inline-flex items-center gap-2 rounded-full border border-foreground/15 bg-foreground/[0.04] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-brand-cyan backdrop-blur">
              <LockKeyhole className="h-3.5 w-3.5" />
              Private by default
            </div>

            <h2 className="mt-6 text-[2rem] font-black leading-[1.04] tracking-tight sm:mt-7 sm:text-[2.75rem] sm:leading-[1.02] lg:text-[3.6rem]">
              Your learning.
              <span className="block">Your room.</span>
              <span className="block gradient-brand-text pb-1">Your data.</span>
            </h2>

            <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground sm:mt-6 sm:text-lg sm:leading-8">
              Three promises we don't bend on.
            </p>

            <div className="mt-8 hidden flex-col gap-3 lg:flex">
              <div className="flex items-center gap-3 text-xs text-foreground/40">
                <span className="h-px w-10 bg-foreground/25" />
                <span className="font-mono uppercase tracking-[0.22em]">
                  Three commitments
                </span>
              </div>
              <div className="ml-[3.25rem] flex flex-col gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground/55">
                <div className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-brand-cyan" />
                  Verified identity
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-brand-cyan" />
                  Encrypted rooms
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-brand-cyan" />
                  Transparent pricing
                </div>
              </div>
            </div>
          </div>

          <ol className="relative space-y-4">
            {promises.map((p, i) => {
              const Icon = p.icon;
              return (
                <li key={p.title} className="group relative">
                  <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-card/80 via-card/40 to-transparent p-5 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-cyan/30 sm:p-6">
                    <div
                      aria-hidden
                      className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-[radial-gradient(circle,rgba(52,211,153,0.14),transparent_70%)] opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                    />

                    <Icon
                      aria-hidden
                      strokeWidth={1}
                      className="pointer-events-none absolute -right-2 -top-2 h-24 w-24 text-foreground/[0.05] transition-all duration-500 group-hover:scale-105 group-hover:text-brand-cyan/[0.08] sm:h-28 sm:w-28"
                    />

                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-brand-cyan/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    />

                    <div className="relative flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand-cyan/20 bg-brand-cyan/[0.08] text-brand-cyan shadow-[inset_0_0_10px_rgba(52,211,153,0.12)]">
                        <Icon className="h-[15px] w-[15px]" />
                      </div>
                      <span className="font-mono text-[10px] font-bold tracking-[0.22em] text-foreground/40">
                        {String(i + 1).padStart(2, "0")} / 03
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-foreground/10" />
                      <span className="inline-flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-brand-cyan/70">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-cyan opacity-50" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-cyan" />
                        </span>
                        Enforced
                      </span>
                    </div>

                    <h3 className="relative mt-4 text-xl font-black tracking-tight sm:text-2xl">
                      {p.title}
                    </h3>

                    <p className="relative mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                      {p.desc}
                    </p>

                    <div className="relative mt-4 inline-flex items-center gap-2 rounded-full border border-brand-cyan/15 bg-brand-cyan/[0.06] px-2.5 py-1 font-mono text-[10px] tracking-wide text-brand-cyan/90">
                      <span aria-hidden className="text-brand-cyan">
                        ✓
                      </span>
                      {p.spec}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 sm:py-24 lg:py-28">
        <h2 className="text-3xl font-black leading-[1.1] tracking-tight sm:text-5xl md:text-6xl">
          Your next skill is one
          <span className="block gradient-brand-text pb-2">message away.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:mt-5 sm:text-lg">
          Start with your student email. Get 10 starter credits.
        </p>
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:mt-10 sm:flex-row sm:items-center">
          <Button variant="hero" size="xl" className="w-full sm:w-auto" asChild>
            <Link to="/signup" search={{ redirect: "/onboarding" }}>
              Start swapping
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="xl" className="w-full sm:w-auto" asChild>
            <Link to="/skills">Browse skills first</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-4 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center">
          <Logo size="sm" />
        </Link>

        <nav
          aria-label="Primary"
          className="hidden items-center gap-8 text-sm font-semibold text-muted-foreground md:flex"
        >
          <a href="#how" className="transition-colors hover:text-foreground">
            How it works
          </a>
          <Link to="/skills" className="transition-colors hover:text-foreground">
            Explore
          </Link>
          <Link to="/credits" className="transition-colors hover:text-foreground">
            Credits
          </Link>
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" className="px-2 sm:px-3" asChild>
            <Link to="/login" search={{ redirect: "/dashboard" }}>
              Log in
            </Link>
          </Button>
          <Button variant="hero" size="sm" asChild>
            <Link to="/signup" search={{ redirect: "/onboarding" }}>
              <MessageCircle className="h-4 w-4 hidden sm:inline-block" />
              Sign up
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
