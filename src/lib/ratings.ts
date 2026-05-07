import { supabase } from "@/integrations/supabase/client";

export type TeacherRating = { average: number; count: number };

export async function fetchTeacherRatings(userIds: string[]) {
  const map = new Map<string, TeacherRating>();
  const unique = Array.from(new Set(userIds));
  if (!unique.length) return map;

  const { data, error } = await supabase
    .from("reviews")
    .select("reviewee_id, rating")
    .in("reviewee_id", unique);

  if (error) {
    // Returning an empty map keeps the calling pages alive — ratings are
    // decorative, not load-bearing. But silencing the error entirely meant a
    // broken reviews table (RLS regression, dropped column, etc.) would be
    // invisible until someone manually compared the UI to the DB. Log so it
    // shows up in console and our error monitoring instead.
    console.error("[fetchTeacherRatings] query failed:", error);
    return map;
  }

  const totals = new Map<string, { sum: number; count: number }>();
  for (const row of data ?? []) {
    if (!row.reviewee_id) continue;
    const existing = totals.get(row.reviewee_id) ?? { sum: 0, count: 0 };
    existing.sum += row.rating;
    existing.count += 1;
    totals.set(row.reviewee_id, existing);
  }

  for (const [userId, { sum, count }] of totals) {
    map.set(userId, { average: sum / count, count });
  }
  return map;
}
