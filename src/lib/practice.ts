import { supabase } from "@/integrations/supabase/client";

// Client half of the Practice ("LeetCode-lite") feature. It asks the
// practice-questions Edge Function for a batch of multiple-choice problems,
// grades them locally for instant feedback, and reports each answer to the
// record_practice_answer RPC so the "solved" counters persist.
//
// Unlike skill verification, Practice is zero-stakes: the answer key ships with
// each problem on purpose, so the verdict is instant with no second round-trip.

export type PracticeLevel = "basic" | "intermediate" | "advanced";

export const PRACTICE_LEVELS: PracticeLevel[] = ["basic", "intermediate", "advanced"];

// The three difficulties wear LeetCode labels in the UI while the DB stores the
// existing skill_level enum values.
export const DIFFICULTY_LABEL: Record<PracticeLevel, string> = {
  basic: "Easy",
  intermediate: "Medium",
  advanced: "Hard",
};

// Tailwind color classes per difficulty, reusing the app's brand tokens — green
// for Easy, amber for Medium, red for Hard, LeetCode-style.
export const DIFFICULTY_TONE: Record<PracticeLevel, { text: string; chip: string; dot: string }> = {
  basic: {
    text: "text-brand-cyan",
    chip: "border-brand-cyan/40 bg-brand-cyan/10 text-brand-cyan",
    dot: "bg-brand-cyan",
  },
  intermediate: {
    text: "text-brand-yellow",
    chip: "border-brand-yellow/40 bg-brand-yellow/10 text-brand-yellow",
    dot: "bg-brand-yellow",
  },
  advanced: {
    text: "text-destructive",
    chip: "border-destructive/40 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
};

export type PracticeProblem = {
  position: number;
  prompt: string;
  options: string[];
  // Practice ships the key so the client can grade instantly — see the header.
  correctIndex: number;
  explanation: string;
};

export type PracticeSet = {
  skillId: string;
  skillName: string;
  level: PracticeLevel;
  model: string;
  problems: PracticeProblem[];
};

// One counter row: how many problems the user has solved/attempted for a given
// (skill, difficulty).
export type PracticeProgress = {
  skillId: string;
  level: PracticeLevel;
  solved: number;
  attempted: number;
};

export type PracticeSkill = { id: string; name: string; category: string | null };

// Carries a friendly message through to the UI, mirroring VerificationError.
export class PracticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeError";
  }
}

async function callPractice<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("practice-questions", { body });

  if (error) {
    // FunctionsHttpError hides the JSON body on error.message ("non-2xx status
    // code"), so read the real message off the response.
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === "function") {
      try {
        const payload = await response.json();
        if (payload?.error) throw new PracticeError(String(payload.error));
      } catch (parseError) {
        if (parseError instanceof PracticeError) throw parseError;
      }
    }
    throw new PracticeError("Something went wrong. Please try again.");
  }

  if (data && typeof data === "object" && "error" in data) {
    throw new PracticeError(String((data as { error: string }).error));
  }
  return data as T;
}

// Ask for a fresh batch of problems. `avoidPrompts` are the prompts already seen
// this session so the model doesn't repeat them.
export function generatePracticeSet(
  skillId: string,
  level: PracticeLevel,
  count = 5,
  avoidPrompts: string[] = [],
) {
  return callPractice<PracticeSet>({
    action: "generate",
    skillId,
    level,
    count,
    // Cap what we send — the function caps again, this just keeps the request small.
    avoidPrompts: avoidPrompts.slice(-40),
  });
}

// Report one answered problem. Fail-soft on purpose: a failed write must never
// interrupt a practice run, so callers can fire-and-forget. Returns the updated
// server counters when the write succeeds, or null when it didn't.
export async function recordPracticeAnswer(
  skillId: string,
  level: PracticeLevel,
  correct: boolean,
): Promise<{ solved: number; attempted: number } | null> {
  const { data, error } = await supabase.rpc("record_practice_answer", {
    p_skill_id: skillId,
    p_level: level,
    p_correct: correct,
  });
  if (error) return null;
  // The RPC returns a single row (solved, attempted).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.solved !== "number") return null;
  return { solved: row.solved, attempted: row.attempted };
}

function progressKey(skillId: string, level: PracticeLevel) {
  return `${skillId}:${level}`;
}

// Every counter the user holds, keyed `${skillId}:${level}` for direct lookup
// while rendering the stat cards. Fail-soft: a missing table (migration not run
// yet) or a failed request must not take the page down — just show zeroes.
export async function loadPracticeProgress(): Promise<Map<string, PracticeProgress>> {
  const { data, error } = await supabase
    .from("practice_progress")
    .select("skill_id, level, solved, attempted");

  if (error) return new Map();
  return new Map(
    (data ?? []).map((row) => {
      const level = row.level as PracticeLevel;
      return [
        progressKey(row.skill_id, level),
        {
          skillId: row.skill_id,
          level,
          solved: row.solved ?? 0,
          attempted: row.attempted ?? 0,
        },
      ] as const;
    }),
  );
}

// The skills the user is currently learning — the quick-pick chips on the
// picker. Deduped and sorted by name.
export async function loadLearningSkills(userId: string): Promise<PracticeSkill[]> {
  const { data, error } = await supabase
    .from("user_learning_skills")
    .select("skills:skill_id(id, name, category)")
    .eq("user_id", userId);

  if (error) return [];
  const skills: PracticeSkill[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const skill = row.skills as PracticeSkill | null;
    if (skill && skill.id && !seen.has(skill.id)) {
      seen.add(skill.id);
      skills.push(skill);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve skill names for a set of ids — used to label the "Your progress" list,
// whose rows are keyed only by skill id. Returns a Map<id, name>.
export async function loadSkillNames(skillIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(skillIds));
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("skills").select("id, name").in("id", ids);
  if (error) return new Map();
  return new Map((data ?? []).map((row) => [row.id, row.name] as const));
}

// Catalog search for "practice any skill" — active skills whose name matches,
// capped for the dropdown.
export async function searchSkills(query: string, limit = 12): Promise<PracticeSkill[]> {
  const trimmed = query.trim();
  let request = supabase
    .from("skills")
    .select("id, name, category")
    .eq("is_active", true)
    .order("name")
    .limit(limit);
  if (trimmed.length > 0) request = request.ilike("name", `%${trimmed}%`);

  const { data, error } = await request;
  if (error) return [];
  return (data ?? []) as PracticeSkill[];
}
