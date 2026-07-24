import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  NextMoveSkeleton,
  PeopleSectionSkeleton,
  SuggestionsSkeleton,
} from "@/components/DashboardSectionSkeletons";

export type PageLoadingVariant =
  | "hero-stats"
  | "credits"
  | "list"
  | "list-wide"
  | "messages"
  | "profile"
  | "detail"
  | "video"
  | "dashboard"
  | "admin"
  | "simple";

export function PageLoading({ variant = "hero-stats" }: { variant?: PageLoadingVariant }) {
  if (variant === "simple") {
    return (
      <div className="min-h-screen flex items-center justify-center animate-in fade-in duration-150">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (variant === "messages") {
    // Mirrors the real messages route shell so there is no shift on load:
    // same outer height calc, max-w-6xl wrapper, glass card, and inbox
    // structure (header → tabs → search → filter chips → contact list).
    // Right pane mirrors the "Select a conversation" empty state.
    return (
      <div className="flex h-[calc(100dvh_-_118px_-_6rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] min-h-[32rem] flex-col overflow-hidden md:h-[calc(100dvh_-_6rem)] md:min-h-[36rem]">
        <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 animate-in fade-in duration-150">
          <div className="glass flex min-h-0 flex-1 overflow-hidden rounded-3xl md:rounded-3xl">
            <aside className="flex w-full flex-col bg-muted/30 dark:bg-background/40 md:w-[360px] md:shrink-0 md:border-r border-border/60">
              <div className="border-b border-border/60 px-5 pt-5 pb-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-2xl" />
                  <div className="min-w-0 space-y-1.5 pt-0.5">
                    <Skeleton className="h-6 w-32 rounded-md" />
                    <Skeleton className="h-3 w-44 rounded-full" />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 px-4 pt-3 pb-2">
                <Skeleton className="h-10 rounded-xl" />
                <Skeleton className="h-10 rounded-xl" />
              </div>
              <div className="px-4 pb-3">
                <Skeleton className="h-10 w-full rounded-full" />
              </div>
              <div className="flex gap-1.5 px-4 pb-3">
                <Skeleton className="h-7 w-12 rounded-full" />
                <Skeleton className="h-7 w-16 rounded-full" />
                <Skeleton className="h-7 w-16 rounded-full" />
              </div>
              <div className="flex-1 overflow-hidden px-2 py-1">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div
                    key={index}
                    className="my-1 flex w-full items-center gap-3 rounded-2xl px-3 py-2.5"
                  >
                    <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-3/5 rounded-full" />
                      <Skeleton className="h-3 w-4/5 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            </aside>
            <section className="hidden flex-1 flex-col items-center justify-center p-10 md:flex">
              <Skeleton className="mb-5 h-20 w-20 rounded-3xl" />
              <Skeleton className="h-8 w-64 rounded-md" />
              <Skeleton className="mt-3 h-3 w-80 rounded-full" />
              <Skeleton className="mt-2 h-3 w-64 rounded-full" />
              <Skeleton className="mt-5 h-7 w-60 rounded-full" />
            </section>
          </div>
        </main>
      </div>
    );
  }

  if (variant === "video") {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-7xl flex-col px-4 py-[18px] sm:px-[18px] md:py-6 animate-in fade-in duration-150">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-24 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-48 rounded-full" />
                <Skeleton className="h-3 w-32 rounded-full" />
              </div>
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-9 w-28 rounded-xl" />
              <Skeleton className="h-9 w-9 rounded-xl" />
            </div>
          </div>
          <Skeleton className="flex-1 rounded-3xl" />
        </main>
      </div>
    );
  }

  if (variant === "profile") {
    // Mirrors the real profile route shell so nothing shifts on load:
    // hero card (title + Save row, then avatar → name/bio form → verify
    // panel), the teaching/learning grid, the availability card, and the
    // password/delete footer row.
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4 animate-in fade-in duration-150">
          <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
            <div className="p-5 md:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Skeleton className="h-8 w-40 rounded-xl md:h-9 md:w-48" />
                <div className="flex items-center gap-3">
                  <Skeleton className="hidden h-3 w-32 rounded-full sm:block" />
                  <Skeleton className="h-9 w-20 rounded-xl" />
                </div>
              </div>
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-5">
                <Skeleton className="mx-auto h-20 w-20 shrink-0 rounded-2xl md:mx-0" />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-16 rounded-full" />
                    <Skeleton className="h-10 w-full rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-10 rounded-full" />
                    <Skeleton className="h-20 w-full rounded-xl" />
                  </div>
                </div>
                <Skeleton className="h-40 w-full shrink-0 rounded-2xl md:w-64" />
              </div>
            </div>
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-72 rounded-3xl" />
            <Skeleton className="h-72 rounded-3xl" />
          </div>
          <Skeleton className="h-64 rounded-3xl" />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <Skeleton className="h-8 w-36 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-full" />
          </div>
        </main>
      </div>
    );
  }

  if (variant === "detail") {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6 animate-in fade-in duration-150">
          <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
            <div className="p-6 md:p-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 flex-1 space-y-3">
                  <Skeleton className="h-7 w-2/3 rounded-xl" />
                  <Skeleton className="h-4 w-1/2 rounded-full" />
                  <div className="flex gap-2 pt-1">
                    <Skeleton className="h-6 w-20 rounded-full" />
                    <Skeleton className="h-6 w-24 rounded-full" />
                  </div>
                </div>
                <Skeleton className="h-10 w-32 rounded-xl" />
              </div>
            </div>
          </section>
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <Skeleton className="h-96 rounded-3xl" />
            <div className="space-y-4">
              <Skeleton className="h-32 rounded-3xl" />
              <Skeleton className="h-40 rounded-3xl" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (variant === "list" || variant === "list-wide") {
    const maxW = variant === "list-wide" ? "max-w-7xl" : "max-w-6xl";
    return (
      <div className="min-h-screen flex flex-col">
        <main
          className={`mx-auto w-full ${maxW} flex-1 px-4 py-5 sm:px-6 space-y-4 animate-in fade-in duration-150`}
        >
          <section className="glass rounded-2xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <Skeleton className="h-11 w-11 rounded-xl" />
                <div className="space-y-2 pt-1">
                  <Skeleton className="h-6 w-40 rounded-md" />
                  <Skeleton className="h-3 w-56 rounded-full" />
                </div>
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-9 w-28 rounded-xl" />
                <Skeleton className="h-9 w-24 rounded-xl" />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[180px_180px]">
              <Skeleton className="h-10 rounded-xl" />
              <Skeleton className="h-10 rounded-xl" />
            </div>
          </section>
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-2xl" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  if (variant === "admin") {
    // Mirrors the admin overview: hero bar, 4-up stat grid, two chart cards.
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-150">
          <Skeleton className="h-28 rounded-3xl" />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-28 rounded-3xl" />
            <Skeleton className="h-28 rounded-3xl" />
            <Skeleton className="h-28 rounded-3xl" />
            <Skeleton className="h-28 rounded-3xl" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-80 rounded-3xl" />
            <Skeleton className="h-80 rounded-3xl" />
          </div>
        </main>
      </div>
    );
  }

  if (variant === "dashboard") {
    // Mirrors the dashboard route shell section for section (same wrapper,
    // hero padding, card order) — this exact component is also what the
    // dashboard's own loading gate renders, so the router pending phase and
    // the in-route loading phase are pixel-identical.
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 md:py-8 space-y-5 md:space-y-6 animate-in fade-in duration-150">
          <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
            <div className="flex flex-col gap-6 p-6 md:p-10 md:flex-row md:items-center md:gap-8">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-32 rounded-full" />
                <Skeleton className="mt-1 h-9 w-44 rounded-xl md:h-12 md:w-56" />
                <Skeleton className="mt-3 h-6 w-full max-w-xl rounded-full md:h-7" />
                <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
                  <Skeleton className="mx-auto h-10 w-[88%] rounded-lg sm:mx-0 sm:h-12 sm:w-44 sm:rounded-xl" />
                  <Skeleton className="mx-auto h-10 w-[88%] rounded-lg sm:mx-0 sm:h-12 sm:w-40 sm:rounded-xl" />
                </div>
                {/* h-5, not h-4: the real row is text-sm, whose 20px line box
                    is what sets this strip's height. */}
                <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <Skeleton className="h-5 w-24 rounded-full lg:hidden" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              </div>
              {/* Matches CreditsCard: hidden below lg, w-56 there. */}
              <Skeleton className="hidden h-[152px] w-56 shrink-0 rounded-2xl lg:block" />
            </div>
          </section>
          <NextMoveSkeleton />
          <SuggestionsSkeleton />
          <PeopleSectionSkeleton />
        </main>
      </div>
    );
  }

  if (variant === "credits") {
    // Mirrors the real credits route shell: hero (icon + title/subtitle +
    // "Earn more" button) over a 3-up stat grid, then the bordered
    // "Transaction History" card with its own header row and entries.
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6 animate-in fade-in duration-150">
          <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
            <div className="p-6 md:p-8 space-y-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div className="flex items-start gap-4">
                  <Skeleton className="h-12 w-12 shrink-0 rounded-2xl" />
                  <div className="space-y-3">
                    <Skeleton className="h-9 w-56 rounded-xl md:h-10 md:w-64" />
                    <Skeleton className="h-4 w-72 rounded-full" />
                  </div>
                </div>
                <Skeleton className="h-10 w-32 rounded-full self-start md:self-auto" />
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
              </div>
            </div>
          </section>
          <section className="glass rounded-3xl border border-white/10 p-6 md:p-7">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <Skeleton className="h-5 w-40 rounded-md" />
              </div>
              <Skeleton className="h-4 w-14 rounded-full" />
            </div>
            <div className="mt-5 space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-[68px] rounded-2xl" />
              ))}
            </div>
          </section>
        </main>
      </div>
    );
  }

  // hero-stats (default) — mirrors the sessions list exactly so nothing shifts
  // when the real page swaps in: same hero padding (title + one summary line +
  // CTA), same h-9 filter chips, same card height and radius.
  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6 animate-in fade-in duration-150">
        <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="flex flex-col gap-5 px-6 py-10 md:flex-row md:items-center md:justify-between md:px-8 md:py-14">
            <div>
              <Skeleton className="h-9 w-56 rounded-xl md:h-10 md:w-64" />
              <Skeleton className="mt-3 h-5 w-72 rounded-full sm:w-80" />
            </div>
            <Skeleton className="h-10 w-56 rounded-full self-start md:self-auto" />
          </div>
        </section>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-20 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            // Cards stack their action row below the details until lg, where it
            // moves to the right — hence the two heights.
            <Skeleton key={index} className="h-[168px] rounded-3xl lg:h-[112px]" />
          ))}
        </div>
      </main>
    </div>
  );
}
