import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type PageLoadingVariant =
  | "hero-stats"
  | "list"
  | "list-wide"
  | "messages"
  | "profile"
  | "detail"
  | "video"
  | "dashboard"
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
    return (
      <div className="min-h-screen flex flex-col">
        <main className="flex-1 mx-auto w-full max-w-7xl px-3 sm:px-5 pb-4 animate-in fade-in duration-150">
          <div className="glass rounded-3xl overflow-hidden flex h-[calc(100dvh-7rem)]">
            <aside className="w-full md:w-[360px] md:shrink-0 md:border-r border-white/10 p-5 space-y-4">
              <Skeleton className="h-8 w-36 rounded-xl" />
              <Skeleton className="h-11 rounded-2xl" />
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/5 rounded-full" />
                    <Skeleton className="h-3 w-4/5 rounded-full" />
                  </div>
                </div>
              ))}
            </aside>
            <section className="hidden flex-1 flex-col md:flex p-6">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-44 rounded-full" />
                  <Skeleton className="h-3 w-28 rounded-full" />
                </div>
              </div>
              <div className="flex-1 space-y-4 py-6">
                <Skeleton className="ml-auto h-12 w-2/5 rounded-2xl" />
                <Skeleton className="h-12 w-1/2 rounded-2xl" />
                <Skeleton className="ml-auto h-16 w-3/5 rounded-2xl" />
                <Skeleton className="h-14 w-2/5 rounded-2xl" />
              </div>
              <Skeleton className="h-12 rounded-2xl" />
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
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4 animate-in fade-in duration-150">
          <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
            <div className="h-1 w-full bg-white/[0.06]" />
            <div className="p-5 md:p-6">
              <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
                <Skeleton className="mx-auto h-24 w-24 rounded-3xl md:mx-0" />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-4 w-40 rounded-full" />
                    <Skeleton className="h-9 w-20 rounded-xl" />
                  </div>
                  <Skeleton className="h-10 w-full rounded-xl" />
                  <Skeleton className="h-20 w-full rounded-xl" />
                </div>
              </div>
            </div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72 rounded-3xl" />
            <Skeleton className="h-72 rounded-3xl" />
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
        <main className={`mx-auto w-full ${maxW} flex-1 px-4 py-5 sm:px-6 space-y-4 animate-in fade-in duration-150`}>
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

  if (variant === "dashboard") {
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

  // hero-stats (default) — matches history, tracks, credits, etc.
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
              <Skeleton className="h-10 w-40 rounded-xl self-start md:self-auto" />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          </div>
        </section>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-20 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
      </main>
    </div>
  );
}
