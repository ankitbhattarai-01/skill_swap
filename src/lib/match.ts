import type { Database } from "@/integrations/supabase/types";

export type LearningMode = Database["public"]["Enums"]["learning_mode"];

export const LEARNING_MODE_LABELS: Record<LearningMode, string> = {
  teaching: "Direct teaching",
  collaboration: "Collaboration",
  mentorship: "Mentorship",
  coaching: "Coaching",
  peer_review: "Peer review",
  project_based: "Project based",
  study_group: "Study group",
  hands_on: "Hands-on practice",
};

export function formatLearningMode(mode: LearningMode | null | undefined): string {
  return mode ? LEARNING_MODE_LABELS[mode] : "Flexible";
}

export function modeCompatibilityScore(
  myMode: LearningMode | null | undefined,
  theirMode: LearningMode | null | undefined,
): number {
  if (!myMode || !theirMode) return 1;
  if (myMode === theirMode) return 4;
  if (
    (myMode === "project_based" && theirMode === "hands_on") ||
    (myMode === "hands_on" && theirMode === "project_based") ||
    (myMode === "mentorship" && theirMode === "coaching") ||
    (myMode === "coaching" && theirMode === "mentorship") ||
    (myMode === "study_group" && theirMode === "collaboration") ||
    (myMode === "collaboration" && theirMode === "study_group")
  ) {
    return 3;
  }
  return 2;
}

export function deriveMatchLabel(
  myMode: LearningMode | null | undefined,
  theirMode: LearningMode | null | undefined,
  fallback: "Teacher Match" | "Learner Match",
): string {
  if (myMode && theirMode && myMode === theirMode) {
    return `${formatLearningMode(myMode)} Match`;
  }
  if (modeCompatibilityScore(myMode, theirMode) >= 3) {
    return `${formatLearningMode(theirMode)} Match`;
  }
  return fallback;
}

export type SkillLevel = "basic" | "intermediate" | "advanced";

const LEVEL_RANK: Record<SkillLevel, number> = {
  basic: 1,
  intermediate: 2,
  advanced: 3,
};

export type RankInputs = {
  /** Mode I prefer (learner's learning_mode for teach list, teacher's teaching_mode for seeker list). */
  myMode: LearningMode | null | undefined;
  /** Mode they prefer for the same skill. */
  theirMode: LearningMode | null | undefined;
  /** My level for the skill (learner level for teach list, teacher level for seeker list). */
  myLevel?: SkillLevel | null;
  /** Their level for the skill. */
  theirLevel?: SkillLevel | null;
  /** Star rating average (0–5). */
  rating?: number | null;
  /** Number of completed sessions for this person. */
  completedSessions?: number;
  /** Profile updated_at ISO timestamp (recency proxy). */
  profileUpdatedAt?: string | null;
  /** My credits balance — only relevant when ranking teachers. */
  myCredits?: number | null;
  /** Their per-hour credit rate — only relevant when ranking teachers. */
  theirCreditsPerHour?: number | null;
  /** True if there's a reciprocal match — they also want what I teach (or vice versa). */
  reciprocal?: boolean;
  /** Stable id pair for deterministic tie-breaking. */
  candidateId: string;
  viewerId: string;
  /** Direction: are we ranking teachers (the candidate teaches me) or seekers (the candidate learns from me). */
  direction: "teacher" | "seeker";
};

export type RankResult = {
  total: number;
  parts: Record<string, number>;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function activityScore(updatedAt?: string | null): number {
  if (!updatedAt) return 0;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days < 7) return 30;
  if (days < 30) return 20;
  if (days < 90) return 10;
  return 0;
}

function levelFitScore(input: RankInputs): number {
  if (!input.myLevel || !input.theirLevel) return 50;
  const my = LEVEL_RANK[input.myLevel];
  const their = LEVEL_RANK[input.theirLevel];
  if (input.direction === "teacher") {
    // Teacher should know AT LEAST as much as the learner.
    if (their > my) return 100; // teacher above learner — ideal
    if (their === my) return 70; // same level — okay
    return 25; // teacher below learner — usually a bad fit
  }
  // direction === "seeker": I'm teaching them. Best when I (myLevel) ≥ them (theirLevel).
  if (my > their) return 100;
  if (my === their) return 70;
  return 25;
}

export function rankCandidate(input: RankInputs): RankResult {
  const parts: Record<string, number> = {};

  parts.level = levelFitScore(input); // 0–100
  parts.mode = modeCompatibilityScore(input.myMode, input.theirMode) * 20; // 20–80
  parts.reciprocity = input.reciprocal ? 60 : 0;
  parts.reputation =
    clamp(input.rating ?? 0, 0, 5) * 8 + clamp(input.completedSessions ?? 0, 0, 20) * 1;
  parts.activity = activityScore(input.profileUpdatedAt);

  if (
    input.direction === "teacher" &&
    input.myCredits != null &&
    input.theirCreditsPerHour != null
  ) {
    if (input.theirCreditsPerHour <= input.myCredits) parts.affordability = 20;
    else if (input.theirCreditsPerHour <= input.myCredits * 1.5) parts.affordability = 10;
    else parts.affordability = 0;
  } else {
    parts.affordability = 10;
  }

  parts.newbie = (input.completedSessions ?? 0) === 0 ? 10 : 0;
  parts.tieBreak = (stableHash(input.viewerId + ":" + input.candidateId) % 1000) / 1000;

  const total = Object.values(parts).reduce((s, v) => s + v, 0);
  return { total, parts };
}
