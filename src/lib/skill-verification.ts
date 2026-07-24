import { supabase } from "@/integrations/supabase/client";

// Client half of the skill-verification quiz. Deliberately thin: it never holds
// an answer key and never grades or times anything itself. Every decision that
// matters — which level to test at, the deadline, whether you passed, when you
// may retry — is made in the verify-skill Edge Function.
//
// `start` returns all ten questions (prompt + options, no key) with one shared
// deadline; `submit` sends back the chosen answers and the server grades them.

export const QUESTION_COUNT = 10;
export const PASS_CORRECT = 7;

export type VerificationLevel = "basic" | "intermediate" | "advanced";

export type QuizQuestion = {
  position: number;
  prompt: string;
  options: string[];
};

export type QuizStart = {
  attemptId: string;
  skillName: string;
  level: VerificationLevel;
  passCorrect: number;
  total: number;
  // One absolute deadline for the whole quiz. The client counts down to it and
  // auto-submits when it passes.
  deadlineAt: string;
  questions: QuizQuestion[];
};

// One chosen option per question. answerIndex is null for a question the user
// left blank; the server grades that as wrong.
export type QuizAnswer = { position: number; answerIndex: number | null };

export type QuizResult = {
  passed: boolean;
  score: number;
  total: number;
  passCorrect: number;
  level: VerificationLevel;
  retryAt: string | null;
  results: {
    position: number;
    prompt: string;
    options: string[];
    correctIndex: number;
    // null when the question was left unanswered, which reads differently from
    // having picked the wrong one.
    yourIndex: number | null;
    correct: boolean;
    explanation: string;
  }[];
};

export type SkillVerification = {
  skill_id: string;
  level: VerificationLevel;
  score: number;
  total: number;
  verified_at: string;
};

// Carries the server's retry timestamp through to the UI so the dialog can say
// "try again in 6 hours" instead of a bare failure.
export class VerificationError extends Error {
  retryAt: string | null;
  constructor(message: string, retryAt: string | null = null) {
    super(message);
    this.name = "VerificationError";
    this.retryAt = retryAt;
  }
}

async function callVerifySkill<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("verify-skill", { body });

  if (error) {
    // FunctionsHttpError hides the JSON body on `error.message` ("non-2xx
    // status code"), so read the real message off the response — that is where
    // the cooldown deadline and the specific reason live.
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === "function") {
      try {
        const payload = await response.json();
        if (payload?.error) {
          throw new VerificationError(String(payload.error), payload.retryAt ?? null);
        }
      } catch (parseError) {
        if (parseError instanceof VerificationError) throw parseError;
      }
    }
    // Never surface the SDK's own wording ("Edge Function returned a non-2xx
    // status code" and friends) — if the server didn't hand us a human sentence,
    // fall back to a generic one.
    throw new VerificationError("Something went wrong. Please try again.");
  }

  if (data && typeof data === "object" && "error" in data) {
    const payload = data as { error: string; retryAt?: string | null };
    throw new VerificationError(payload.error, payload.retryAt ?? null);
  }
  return data as T;
}

export function startSkillQuiz(skillId: string) {
  return callVerifySkill<QuizStart>({ action: "start", skillId });
}

// Sends every answer at once. Questions the user left blank can simply be
// omitted; the server treats a missing position as unanswered.
export function finishSkillQuiz(attemptId: string, answers: QuizAnswer[]) {
  return callVerifySkill<QuizResult>({ action: "submit", attemptId, answers });
}

// Every badge a user holds, keyed by skill id for direct lookup while
// rendering skill rows.
export async function loadSkillVerifications(userId: string) {
  const { data, error } = await supabase
    .from("skill_verifications")
    .select("skill_id, level, score, total, verified_at")
    .eq("user_id", userId);

  // The badge is decoration on top of the skills list. If the table is missing
  // (migration not applied yet) the profile must still render — just without
  // ticks.
  if (error) return new Map<string, SkillVerification>();
  return new Map((data ?? []).map((row) => [row.skill_id, row as SkillVerification] as const));
}

// A badge is worthless if only its owner can see it, so listings need to know
// which (teacher, skill) pairs are verified. One query per page of cards keyed
// by user id — the skill_verifications RLS policy is world-readable, so this
// works for any signed-in viewer, not just the owner.
export function verifiedPairKey(userId: string, skillId: string) {
  return `${userId}:${skillId}`;
}

export async function loadVerifiedPairs(userIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) return new Set();

  const { data, error } = await supabase
    .from("skill_verifications")
    .select("user_id, skill_id")
    .in("user_id", ids);

  // Same reasoning as loadSkillVerifications: ticks are decoration, so a
  // missing table or a failed request must not take the listing down with it.
  if (error) return new Set();
  return new Set((data ?? []).map((row) => verifiedPairKey(row.user_id, row.skill_id)));
}

// When the user may next attempt each skill. Only failures create a cooldown,
// so an empty map means everything is available now.
export async function loadVerificationCooldowns(userId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("skill_verification_attempts")
    .select("skill_id, created_at")
    .eq("user_id", userId)
    .eq("status", "failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const cooldowns = new Map<string, string>();
  if (error) return cooldowns;
  for (const row of data ?? []) {
    // Ordered newest-first, so the first entry per skill is the binding one.
    if (cooldowns.has(row.skill_id)) continue;
    const retryAt = new Date(new Date(row.created_at).getTime() + 24 * 60 * 60 * 1000);
    if (retryAt.getTime() > Date.now()) cooldowns.set(row.skill_id, retryAt.toISOString());
  }
  return cooldowns;
}

export function formatRetryWait(retryAt: string): string {
  const ms = new Date(retryAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "shortly";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
