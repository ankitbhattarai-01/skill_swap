import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SiteFooter } from "@/components/SiteFooter";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  Clock3,
  Coins,
  GraduationCap,
  LockKeyhole,
  MessageCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SkillSwap - Learn and teach with credits" },
      {
        name: "description",
        content:
          "SkillSwap is a student skill-exchange platform where learners trade knowledge using credits instead of money.",
      },
      { property: "og:title", content: "SkillSwap - Learn and teach with credits" },
      {
        property: "og:description",
        content:
          "Find peers, book sessions, message, and learn face-to-face using credits instead of money.",
      },
    ],
  }),
  component: LandingPage,
});

const features = [
  {
    title: "Find peer teachers",
    desc: "Browse students by skills, level, profile, and rating.",
    icon: Search,
  },
  {
    title: "Exchange with credits",
    desc: "Earn by teaching and spend credits to learn from others.",
    icon: Coins,
  },
  {
    title: "Learn face-to-face",
    desc: "Accepted sessions open in an embedded Jitsi video room.",
    icon: Video,
  },
];

const workflow = [
  { label: "Request", desc: "Choose a skill and send a session request.", icon: GraduationCap },
  { label: "Accept", desc: "Teachers approve, schedule, and open the room.", icon: ShieldCheck },
  { label: "Learn", desc: "Chat, meet, complete, and transfer credits.", icon: MessageCircle },
];

const proofPoints = [
  { label: "No credit card", icon: LockKeyhole },
  { label: "10 starter credits", icon: Coins },
  { label: "Built-in video", icon: Video },
];

const skillPills = ["Python", "Figma", "Guitar", "Public speaking", "Calculus", "Video editing"];

const studentBenefits = [
  {
    title: "For learners",
    desc: "Find classmates who can explain things in the way students actually need them.",
    icon: Search,
  },
  {
    title: "For teachers",
    desc: "Turn what you already know into credits for the next skill you want to learn.",
    icon: GraduationCap,
  },
  {
    title: "For communities",
    desc: "Keep learning activity organized with requests, sessions, chat, and credit history.",
    icon: ShieldCheck,
  },
];

const qualitySignals = [
  "Credit transfer happens after completed sessions.",
  "Accepted sessions open inside SkillSwap with Jitsi.",
  "Profiles, messages, and history stay connected to each session.",
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
      <LandingNav isSignedIn={isSignedIn} />

      <main id="main-content">
        <section className="relative overflow-hidden border-b border-border/60 bg-[linear-gradient(180deg,rgba(124,58,237,0.07),rgba(20,184,166,0.05)_48%,rgba(255,255,255,0)_82%)]">
          <div className="mx-auto grid min-h-[720px] max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
            <div className="max-w-3xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-sm font-medium text-muted-foreground shadow-sm">
                <Sparkles className="h-4 w-4 text-brand-cyan" />
                Student skill exchange powered by credits
              </div>

              <h1 className="text-4xl font-black leading-[1.04] tracking-normal text-foreground sm:text-6xl lg:text-7xl">
                Learn what you need.
                <span className="block gradient-brand-text">Teach what you know.</span>
              </h1>

              <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
                SkillSwap helps students find peers, book skill sessions, message in context, and
                grow through credits instead of money.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button variant="hero" size="xl" asChild>
                  <Link to={isSignedIn ? "/dashboard" : "/signup"}>
                    {isSignedIn ? "Go to Dashboard" : "Start swapping"}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="outline" size="xl" asChild>
                  <Link to="/explore">Explore skills</Link>
                </Button>
              </div>

              <div className="mt-7 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                {proofPoints.map((point) => (
                  <div key={point.label} className="flex items-center gap-2">
                    <point.icon className="h-4 w-4 text-brand-cyan" />
                    <span>{point.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[2rem] border border-border bg-card/90 p-3 shadow-card backdrop-blur">
              <div className="overflow-hidden rounded-[1.5rem] border border-border bg-background">
                <div className="border-b border-border/70 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Today on SkillSwap</div>
                      <div className="text-xs text-muted-foreground">Live learning workflow</div>
                    </div>
                    <div className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600">
                      10 starter credits
                    </div>
                  </div>
                </div>
                <div className="grid gap-0 sm:grid-cols-3">
                  {workflow.map((item) => (
                    <div
                      key={item.label}
                      className="border-border p-5 sm:border-r sm:last:border-r-0"
                    >
                      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <item.icon className="h-5 w-5" />
                      </div>
                      <h2 className="text-base font-bold">{item.label}</h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.desc}</p>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 border-t border-border/70 bg-secondary/35 p-5 md:grid-cols-[1fr_0.9fr]">
                  <div className="rounded-2xl border border-border bg-card p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-cyan/10 text-brand-cyan">
                        <Brain className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-bold">Smart matching</div>
                        <div className="text-sm text-muted-foreground">
                          Suggested peers by skill fit
                        </div>
                      </div>
                    </div>
                    <div className="mt-5 space-y-3">
                      <PreviewRow title="Python basics" meta="3 peer teachers available" />
                      <PreviewRow title="Figma UI design" meta="2 sessions completed this week" />
                      <PreviewRow title="Guitar practice" meta="Learn for 5 credits" />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border bg-card p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-bold">Upcoming session</div>
                        <div className="text-sm text-muted-foreground">Figma wireframes</div>
                      </div>
                      <div className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                        Accepted
                      </div>
                    </div>
                    <div className="mt-5 space-y-3 text-sm">
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Clock3 className="h-4 w-4 text-brand-cyan" />
                        Today, 4:30 PM
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Video className="h-4 w-4 text-brand-cyan" />
                        Opens inside SkillSwap
                      </div>
                    </div>
                    <Button className="mt-5 w-full" variant="hero" asChild>
                      {isSignedIn ? (
                        <Link to="/dashboard">Join learning flow</Link>
                      ) : (
                        <Link to="/signup" search={{ redirect: "/onboarding" }}>
                          Join learning flow
                        </Link>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-border/60 bg-secondary/25">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-5 sm:px-6">
            <span className="text-sm font-semibold text-muted-foreground">Popular exchanges</span>
            {skillPills.map((skill) => (
              <Link
                key={skill}
                to="/explore"
                className="rounded-full border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:border-primary/40 hover:text-primary"
              >
                {skill}
              </Link>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-black tracking-normal sm:text-4xl">
              Built for real student workflows
            </h2>
            <p className="mt-3 text-muted-foreground">
              SkillSwap keeps the operational parts simple: discovery, requests, sessions, chat,
              video, credits, and history.
            </p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {features.map((feature) => (
              <article
                key={feature.title}
                className="rounded-3xl border border-border bg-card p-6 shadow-card"
              >
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-primary">
                  <feature.icon className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-bold">{feature.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-3xl border border-border bg-card p-8 shadow-card">
              <h2 className="text-3xl font-black tracking-normal">
                Fair exchange, without payments
              </h2>
              <p className="mt-3 text-muted-foreground">
                Credits make the marketplace balanced: teaching creates value, learning spends it,
                and every completed session leaves a clear history.
              </p>
              <div className="mt-6 space-y-3">
                {qualitySignals.map((signal) => (
                  <div key={signal} className="flex gap-3 text-sm text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{signal}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {studentBenefits.map((benefit) => (
                <article
                  key={benefit.title}
                  className="rounded-3xl border border-border bg-card p-6 shadow-card"
                >
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-primary">
                    <benefit.icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-bold">{benefit.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{benefit.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6">
          <div className="overflow-hidden rounded-3xl bg-foreground px-6 py-10 text-background shadow-card sm:px-10 md:flex md:items-center md:justify-between">
            <div>
              <h2 className="text-3xl font-black tracking-normal">Ready to trade skills?</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-background/75">
                Start with your profile, add what you can teach, and find a peer who can help you
                learn next.
              </p>
            </div>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row md:mt-0">
              <Button size="lg" variant="secondary" asChild>
                <Link to={isSignedIn ? "/dashboard" : "/signup"}>
                  {isSignedIn ? "Open Dashboard" : "Create account"}
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-background/25 bg-transparent text-background hover:bg-background hover:text-foreground"
                asChild
              >
                <Link to="/explore">Explore first</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function LandingNav({ isSignedIn }: { isSignedIn: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center">
          <Logo size="sm" />
        </Link>

        <nav
          aria-label="Primary"
          className="hidden items-center gap-6 text-sm font-semibold text-muted-foreground md:flex"
        >
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <Link to="/explore" className="transition-colors hover:text-foreground">
            Explore
          </Link>
          <Link to="/credits" className="transition-colors hover:text-foreground">
            Credits
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" asChild>
            <Link to={isSignedIn ? "/dashboard" : "/login"}>
              {isSignedIn ? "Dashboard" : "Log in"}
            </Link>
          </Button>
          {!isSignedIn && (
            <Button variant="hero" size="sm" asChild>
              <Link to="/signup" search={{ redirect: "/onboarding" }}>
                Sign up
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function PreviewRow({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-secondary/70 px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-background text-primary">
        <Users className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-bold">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{meta}</div>
      </div>
    </div>
  );
}
