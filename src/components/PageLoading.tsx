import { Skeleton } from "@/components/ui/skeleton";

type PageLoadingVariant = "dashboard" | "messages" | "profile" | "detail";

export function PageLoading({ variant = "dashboard" }: { variant?: PageLoadingVariant }) {
  return (
    <div className="min-h-screen flex flex-col">
      {variant === "messages" ? (
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
      ) : variant === "profile" ? (
        <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-150">
          <section className="glass rounded-3xl p-6 md:p-8 flex flex-col md:flex-row gap-6">
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="h-24 w-24 rounded-3xl" />
              <Skeleton className="h-9 w-28 rounded-xl" />
            </div>
            <div className="grid flex-1 gap-4 md:grid-cols-2">
              <Skeleton className="h-12 rounded-xl" />
              <Skeleton className="h-12 rounded-xl" />
              <Skeleton className="h-28 rounded-xl md:col-span-2" />
              <Skeleton className="h-11 w-32 rounded-xl" />
            </div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-80 rounded-3xl" />
            <Skeleton className="h-80 rounded-3xl" />
          </div>
        </main>
      ) : variant === "detail" ? (
        <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-150">
          <Skeleton className="h-44 rounded-3xl" />
          <div className="grid gap-4 md:grid-cols-3">
            <Skeleton className="h-28 rounded-3xl" />
            <Skeleton className="h-28 rounded-3xl" />
            <Skeleton className="h-28 rounded-3xl" />
          </div>
          <Skeleton className="h-80 rounded-3xl" />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-150">
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
      )}
    </div>
  );
}
