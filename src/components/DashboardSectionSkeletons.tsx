import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

// These mirror the dashboard's real sections (NextMoveCard, AiInsightCard,
// PeopleSection) so nothing shifts when the live cards swap in. They live
// outside the dashboard route chunk because the router-level pending fallback
// (see router.tsx) renders the same skeletons while that chunk is still
// loading — importing them from the route file would drag the whole dashboard
// into the entry bundle.

export function NextMoveSkeleton() {
  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur p-6 md:p-7 shadow-sm">
      <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-brand-purple font-semibold">
        <Sparkles className="h-3.5 w-3.5" /> Top matches for you
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-border/40 bg-card/60 p-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-8 flex-1 rounded-full" />
                <Skeleton className="h-8 flex-1 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Mirrors AiInsightCard's header row + 2x2 tile grid rather than the single
// squat bar it used to show, so the card doesn't triple in height the moment
// the tiles land.
export function SuggestionsSkeleton() {
  return (
    <section className="rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5">
          <Skeleton className="h-5 w-5 rounded-md" />
          <Skeleton className="h-3 w-24 rounded-full" />
        </div>
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 md:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-border/40 bg-background/40 p-3 md:p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2 pt-1.5">
                <Skeleton className="h-3 w-full rounded-full" />
                <Skeleton className="h-3 w-3/5 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Mirrors PeopleSection wrapping two TeacherScrollCards.
export function PeopleSectionSkeleton() {
  return (
    <section className="rounded-3xl border border-border/40 bg-card/60 backdrop-blur p-5 md:p-6">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="h-5 w-48 rounded-md" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 md:gap-4">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-border/40 bg-background/40 p-3 md:p-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3 rounded-md" />
                  <Skeleton className="h-3 w-1/2 rounded-full" />
                  <Skeleton className="h-3 w-2/5 rounded-full" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-9 flex-1 rounded-full" />
                <Skeleton className="h-9 flex-1 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
