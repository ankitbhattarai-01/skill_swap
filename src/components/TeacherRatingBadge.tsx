import { Star } from "lucide-react";
import type { TeacherRating } from "@/lib/ratings";

export function TeacherRatingBadge({ rating }: { rating: TeacherRating | undefined }) {
  if (!rating) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Star className="h-3 w-3" />
        New
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
      <span className="font-medium text-foreground">{rating.average.toFixed(1)}</span>
      <span>({rating.count})</span>
    </span>
  );
}
