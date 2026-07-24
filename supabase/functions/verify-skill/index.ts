// Skill verification quiz — earns the "verified" tick on a teaching skill.
//
// The quiz is 10 multiple-choice questions shown on screen at once, with a
// SINGLE countdown for the whole set. Two actions on one endpoint:
//
//   { action: "start",  skillId }
//        -> opens an attempt, builds 10 questions at the user's DECLARED level,
//           and returns them (prompt + options, NO answer key) with one shared
//           deadline for the whole quiz.
//   { action: "submit", attemptId, answers }
//        -> grades the submitted answers against the stored key and, at
//           PASS_CORRECT+/10, writes public.skill_verifications.
//
// WHY THE ANSWER KEY NEVER LEAVES THE SERVER: the correct index lives in
// public.skill_verification_questions, a table with RLS on and no policy for
// `authenticated`. The client physically cannot read it; grading happens here
// against the stored key, never against anything the client sends back. The
// client submits only option indices.
//
// WHY THE CLOCK IS SERVER-SIDE: the whole-quiz deadline is computed here from
// the attempt's created_at and checked here at submit. The client's countdown
// only shows what the server already decided; pausing the tab or editing the
// countdown in devtools changes what is displayed, not what is graded.
//
// The declared level is read from user_teaching_skills, never from the request
// body, so a user cannot ask for an easy 'basic' quiz and be badged 'advanced'.
//
// GUITAR is special: at the basic level it uses a FIXED question bank (see
// guitar-questions.ts) instead of the AI, so the live demo is instant and its
// answers are known ahead of time. Every other skill is AI-generated.
//
// HOW GENERATION SURVIVES FLAKY MODELS AND RATE LIMITS (in order):
//   1. The model is asked for GENERATE_COUNT (14) questions but only the first
//      QUESTION_COUNT (10) clean ones are kept, so a couple of malformed or
//      duplicate questions no longer sink the whole batch.
//   2. A responseSchema pins the JSON shape; a model that rejects the schema
//      or thinkingConfig with a 400 is retried once with a bare payload.
//   3. Each key tries SIX models — flash + flash-lite families — and every
//      model has its own free-tier quota bucket, so one exhausted model does
//      not take the key down.
//   4. If a full pass over every key x model fails, a previous attempt's full
//      question set for the same skill+level is reshuffled and served, so a
//      skill that has generated successfully once can never hard-fail again.
//   5. Only for a skill with no history does it wait out the rate-limit window
//      (Gemini's own suggested retryDelay when present) and run more passes,
//      all inside one bounded request.
//
// Optional Supabase secrets (only needed for AI-generated skills) — up to five
// Gemini keys are tried in order, and ANY failure from one (rate limit, quota,
// bad key, model error) falls through to the next. Set as many as you have; the
// missing ones are skipped:
//   GEMINI_VERIFY_API_KEY        (main)
//   GEMINI_VERIFY_API_KEY_2 … _5 (fallbacks)
// All from https://aistudio.google.com/apikey — for real redundancy, put them
// in DIFFERENT Google projects so they don't share the same quota bucket.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import { corsJson, corsPreflight } from "../_shared/cors.ts";
import { GUITAR_BASIC_QUESTIONS } from "./guitar-questions.ts";

const QUESTION_COUNT = 10;
const PASS_CORRECT = 7; // 70%
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Over-ask so the strict validation below has slack. Broad everyday skills
// (cooking, photography, …) often come back with one or two questions whose
// options collide once lowercased; asking for 14 and keeping the first 10
// clean ones absorbs that instead of failing the sitting.
const GENERATE_COUNT = 14;

// One clock for the whole quiz. The user sees all ten questions and answers at
// their own pace within this window; when it runs out the client auto-submits
// whatever is selected.
const TOTAL_QUIZ_MS = 5 * 60 * 1000;

// Absorbs the round-trip the client can't control — the submission leaving the
// browser and reaching this function — so a user who submits right at the
// buzzer isn't judged late for it.
const NETWORK_GRACE_MS = 5 * 1000;

// An 'in_progress' attempt older than this is abandoned — the user closed the
// tab mid-quiz. It stops blocking new attempts and can no longer be submitted.
const ATTEMPT_TTL_MS = 45 * 60 * 1000;

// Recorded instead of a real option index when a question was left unanswered.
// Grades as wrong, but stays distinguishable from a wrong pick in the audit
// trail.
const TIMED_OUT = -1;

// One Gemini call may not hang the whole sitting.
const MODEL_CALL_TIMEOUT_MS = 20_000;

// Everything generation may spend in one request — all passes, all waits. The
// user is watching a spinner; past this we give up with the friendly error.
const GENERATION_BUDGET_MS = 45_000;

// Between failed passes, when Gemini didn't suggest its own retryDelay.
const PASS_RETRY_WAIT_MS = 8_000;
const MAX_PASSES = 3;

// Quality-first ladder. The flash-lite rungs matter beyond quality fallback:
// on the free tier EVERY model id has its own RPM/RPD bucket, so the lites
// stay serviceable after the flashes are rate-limited. Floating aliases first
// (they follow Google's newest snapshot), pinned ids behind them for keys that
// can't see an alias yet.
const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

// Pins the JSON shape at the decoder, which kills most "9 usable questions"
// failures before they happen. Models that reject it get one bare retry — see
// tryModel.
const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      prompt: { type: "STRING" },
      options: { type: "ARRAY", items: { type: "STRING" } },
      correctIndex: { type: "INTEGER" },
      explanation: { type: "STRING" },
    },
    required: ["prompt", "options", "correctIndex", "explanation"],
    propertyOrdering: ["prompt", "options", "correctIndex", "explanation"],
  },
};

const StartSchema = z.object({
  action: z.literal("start"),
  skillId: z.string().uuid(),
});

const SubmitSchema = z.object({
  action: z.literal("submit"),
  attemptId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        position: z.number().int().min(0).max(QUESTION_COUNT - 1),
        // null means "left unanswered". Grades as wrong; it is not a way to
        // skip a question without penalty.
        answerIndex: z.number().int().min(0).max(3).nullable(),
      }),
    )
    .max(QUESTION_COUNT),
});

const RequestSchema = z.discriminatedUnion("action", [StartSchema, SubmitSchema]);

type Level = "basic" | "intermediate" | "advanced";

type GeneratedQuestion = {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
};

const LEVEL_BRIEF: Record<Level, string> = {
  basic:
    "Someone who has just learned the fundamentals. Test core vocabulary, everyday syntax or " +
    "concepts, and what the most common tools/terms are for. Avoid edge cases and trivia.",
  intermediate:
    "Someone who uses this skill regularly for real work. Test practical decisions, common " +
    "pitfalls, why one approach is preferred over another, and reading/debugging realistic cases.",
  advanced:
    "Someone who could mentor others. Test trade-offs, performance and correctness subtleties, " +
    "failure modes under pressure, and judgement calls where several answers look plausible.",
};

function readSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

// The Gemini key ladder: the main key first, then up to five fallbacks. Missing
// ones are skipped and duplicates are dropped, so setting the same key twice by
// accident doesn't waste a retry on it.
function readVerifyKeys(): string[] {
  const names = [
    "GEMINI_VERIFY_API_KEY",
    "GEMINI_VERIFY_API_KEY_2",
    "GEMINI_VERIFY_API_KEY_3",
    "GEMINI_VERIFY_API_KEY_4",
    "GEMINI_VERIFY_API_KEY_5",
  ];
  const keys: string[] = [];
  for (const name of names) {
    const value = readSecret(name);
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

// The one skill that skips the AI and uses the fixed bank, so the judge demo is
// instant and predictable. Basic level only — intermediate/advanced guitar
// still gets fresh AI questions.
function isFixedGuitar(skillName: string, level: Level) {
  return level === "basic" && skillName.trim().toLowerCase() === "guitar";
}

function buildPrompt(skillName: string, level: Level) {
  return `You are writing a competency quiz that decides whether someone is qualified to TEACH "${skillName}" on a peer skill-exchange platform.

Target candidate: ${LEVEL_BRIEF[level]}

Write exactly ${GENERATE_COUNT} multiple-choice questions about "${skillName}" at the ${level} level. Only the best ${QUESTION_COUNT} will be used, so every question must stand on its own.

Rules:
- Exactly 4 options per question. Exactly one is correct.
- The three wrong options must be genuinely plausible to someone who half-knows the topic. No filler, no joke answers, no "none of the above".
- All 4 options must be clearly different from each other — never two options that are the same words or mean the same thing.
- Do not make the correct answer consistently the longest or most detailed option.
- Each question must stand alone. Never refer to "the previous question" or to code that was not included in the question text.
- Ask about the skill itself, not about this platform, and never about the candidate's opinions or personal experience.
- Vary what you test across the ${GENERATE_COUNT} questions; do not ask the same idea twice in different words.
- Keep each question under 220 characters. Include short code inline with backticks if the skill needs it.
- Keep each explanation under 15 words.

Return ONLY a JSON array, no markdown fence, no commentary:
[{"prompt":"...","options":["a","b","c","d"],"correctIndex":0,"explanation":"one short sentence on why that answer is right"}]`;
}

// Gemini returns JSON as text and sometimes wraps it in a markdown fence
// despite being told not to. Strip the fence before parsing.
function parseJsonArray(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

// Rejects anything malformed rather than repairing it — a quiz that grants a
// public trust badge must not be graded against a question we had to guess at.
// The model was asked for GENERATE_COUNT questions precisely so that dropping
// a few bad ones still leaves QUESTION_COUNT good ones; only when even the
// over-asked batch can't fill the quiz does the whole generation fail.
function validateQuestions(parsed: unknown): GeneratedQuestion[] {
  if (!Array.isArray(parsed)) throw new Error("model did not return an array");
  const seen = new Set<string>();
  const questions: GeneratedQuestion[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
    const explanation = typeof row.explanation === "string" ? row.explanation.trim() : "";
    const rawOptions = Array.isArray(row.options) ? row.options : [];
    const options = rawOptions
      .filter((o): o is string => typeof o === "string")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    // Tolerate a correctIndex that arrives as "2" — same information, no guess.
    const rawIndex = row.correctIndex;
    const correctIndex = typeof rawIndex === "number"
      ? rawIndex
      : typeof rawIndex === "string" && /^\d+$/.test(rawIndex.trim())
      ? Number(rawIndex.trim())
      : -1;

    if (!prompt || options.length !== 4) continue;
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) continue;
    // Duplicate options make the question unanswerable — two identical choices
    // where only one is keyed correct.
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    questions.push({ prompt, options, correctIndex, explanation });
    if (questions.length === QUESTION_COUNT) break;
  }

  if (questions.length < QUESTION_COUNT) {
    throw new Error(
      `model produced ${questions.length}/${QUESTION_COUNT} usable questions`,
    );
  }
  return questions;
}

// Fisher-Yates over an arbitrary array. Used to shuffle the order of the fixed
// guitar questions between sittings.
function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Shuffles a question's four options and re-points its correctIndex, so the
// correct answer isn't always in the same slot.
function shuffleOptions(question: GeneratedQuestion): GeneratedQuestion {
  const indices = shuffle(question.options.map((_, i) => i));
  return {
    ...question,
    options: indices.map((i) => question.options[i]),
    correctIndex: indices.indexOf(question.correctIndex),
  };
}

// The fixed guitar bank, with both the question order and each question's
// options shuffled. The questions and answers themselves never change.
function buildGuitarQuestions(): GeneratedQuestion[] {
  return shuffle(GUITAR_BASIC_QUESTIONS).map((q) =>
    shuffleOptions({
      prompt: q.prompt,
      options: [...q.options],
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    }),
  );
}

// Gemini's 429 body carries a RetryInfo detail like "retryDelay":"22s" —
// the authoritative wait, when present, for the pass-level backoff.
function parseRetryDelayMs(errorText: string): number | null {
  const match = errorText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

type ModelTry =
  | { ok: true; questions: GeneratedQuestion[] }
  | { ok: false; status: number | null; error: string; retryDelayMs: number | null };

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  lean: boolean,
): Promise<ModelTry> {
  // The 2.5-family models "think" before answering by default, which adds
  // several silent seconds before the first token of JSON. A quiz doesn't
  // need chain-of-thought — turning it off is the single biggest latency win.
  // 2.0-family models don't support the field and would reject the request.
  // `lean` strips both the thinking flag and the response schema, for models
  // that 400 on either.
  const supportsThinking = !lean && !model.startsWith("gemini-2.0");

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            // Some variety between sittings so a retry isn't the same quiz, but
            // low enough that the questions stay factually tight.
            temperature: 0.7,
            responseMimeType: "application/json",
            // Fourteen questions with four options and an explanation each is
            // a lot of JSON — 4096 truncated the array and every rung failed
            // to parse. Give it real room.
            maxOutputTokens: 12288,
            ...(lean ? {} : { responseSchema: RESPONSE_SCHEMA }),
            ...(supportsThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      },
    );
  } catch (error) {
    // Network failure or the 20s timeout. Neither says anything about the next
    // rung, so just report and move on.
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, error: `${model}: ${reason}`, retryDelayMs: null };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: `${model}: ${response.status} ${text.slice(0, 300)}`,
      retryDelayMs: response.status === 429 ? parseRetryDelayMs(text) : null,
    };
  }

  const payload = await response.json().catch(() => null);
  // Join every non-thought text part rather than trusting parts[0] — long JSON
  // can arrive split, and a stray thought part must not shadow the answer.
  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
      .filter((p: { text?: unknown; thought?: unknown }) => typeof p?.text === "string" && !p.thought)
      .map((p: { text: string }) => p.text)
      .join("")
    : "";
  if (!text.trim()) {
    const why = payload?.candidates?.[0]?.finishReason ??
      payload?.promptFeedback?.blockReason ?? "no candidates";
    return { ok: false, status: 200, error: `${model}: empty response (${why})`, retryDelayMs: null };
  }

  try {
    const questions = validateQuestions(parseJsonArray(text)).map(shuffleOptions);
    return { ok: true, questions };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 200, error: `${model}: ${reason}`, retryDelayMs: null };
  }
}

type PassResult =
  | { ok: true; questions: GeneratedQuestion[]; model: string }
  | { ok: false; lastError: string; retryDelayMs: number | null };

// One full sweep of every key x every model. A rung that fails for ANY reason
// falls through to the next — a 400 gets one bare-payload retry first, since
// that means the model disliked the request shape (thinkingConfig or the
// responseSchema), not that anything is rate-limited.
async function runLadderPass(
  apiKeys: string[],
  skillName: string,
  level: Level,
  deadline: number,
): Promise<PassResult> {
  const prompt = buildPrompt(skillName, level);
  let lastError = "";
  let retryDelayMs: number | null = null;

  for (let i = 0; i < apiKeys.length; i++) {
    for (const model of GEMINI_MODELS) {
      if (deadline - Date.now() < 3000) {
        return { ok: false, lastError: lastError || "generation budget exhausted", retryDelayMs };
      }

      let outcome = await callGemini(apiKeys[i], model, prompt, false);
      if (!outcome.ok && outcome.status === 400) {
        outcome = await callGemini(apiKeys[i], model, prompt, true);
      }
      if (outcome.ok) return { ok: true, questions: outcome.questions, model };

      lastError = `key ${i + 1}/${apiKeys.length}: ${outcome.error}`;
      console.warn(`[verify-skill] ${lastError}`);
      if (outcome.retryDelayMs !== null) {
        retryDelayMs = retryDelayMs === null
          ? outcome.retryDelayMs
          : Math.min(retryDelayMs, outcome.retryDelayMs);
      }
    }
  }

  return { ok: false, lastError: lastError || "no API key produced a usable quiz", retryDelayMs };
}

// Last-resort bank: the most recent fully-stored question set for this skill
// at this level, from any past sitting. Prefers another user's paper — someone
// who just failed saw the answer key on the review screen, and should not be
// handed the same questions back if any alternative exists. Order and options
// are reshuffled either way, and the 24h cooldown still applies to them.
async function questionsFromPastAttempt(
  admin: SupabaseClient,
  skillId: string,
  level: Level,
  userId: string,
): Promise<GeneratedQuestion[] | null> {
  const { data: attempts } = await admin
    .from("skill_verification_attempts")
    .select("id, user_id")
    .eq("skill_id", skillId)
    .eq("level", level)
    .order("created_at", { ascending: false })
    .limit(12);
  if (!attempts || attempts.length === 0) return null;

  const ordered = [
    ...attempts.filter((a) => a.user_id !== userId),
    ...attempts.filter((a) => a.user_id === userId),
  ];

  for (const candidate of ordered) {
    const { data: rows } = await admin
      .from("skill_verification_questions")
      .select("prompt, options, correct_index, explanation")
      .eq("attempt_id", candidate.id)
      .order("position");
    if (!rows || rows.length !== QUESTION_COUNT) continue;

    const questions: GeneratedQuestion[] = [];
    for (const row of rows) {
      const options = Array.isArray(row.options)
        ? (row.options as unknown[]).filter((o): o is string => typeof o === "string")
        : [];
      if (options.length !== 4 || typeof row.correct_index !== "number") break;
      questions.push({
        prompt: row.prompt,
        options,
        correctIndex: row.correct_index,
        explanation: row.explanation ?? "",
      });
    }
    if (questions.length !== QUESTION_COUNT) continue;

    return shuffle(questions).map(shuffleOptions);
  }
  return null;
}

// The full resilience ladder described in the header: fresh generation, then
// the reuse bank, then rate-limit-aware retry passes, all inside one bounded
// budget. Throws only when every layer came up empty.
async function generateQuestions(
  admin: SupabaseClient,
  apiKeys: string[],
  skillId: string,
  skillName: string,
  level: Level,
  userId: string,
): Promise<{ questions: GeneratedQuestion[]; model: string }> {
  const deadline = Date.now() + GENERATION_BUDGET_MS;
  let lastError = "";

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await runLadderPass(apiKeys, skillName, level, deadline);
    if (result.ok) return { questions: result.questions, model: result.model };
    lastError = result.lastError;
    console.warn(`[verify-skill] generation pass ${pass}/${MAX_PASSES} failed: ${lastError}`);

    if (pass === 1) {
      const reused = await questionsFromPastAttempt(admin, skillId, level, userId);
      if (reused) {
        console.warn(`[verify-skill] serving reshuffled questions from a previous attempt`);
        return { questions: reused, model: "reused:previous-attempt" };
      }
    }

    // Wait out the rate-limit window before the next pass — Gemini's own
    // suggested delay when it gave one, a default breather otherwise, and
    // never past the budget.
    const wait = Math.min(
      Math.max(result.retryDelayMs ?? PASS_RETRY_WAIT_MS, 2000),
      15_000,
      deadline - Date.now() - 5000,
    );
    if (pass === MAX_PASSES || wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  throw new Error(lastError || "no API key produced a usable quiz");
}

type Handled = { status: number; body: Record<string, unknown> };

async function handleStart(
  admin: SupabaseClient,
  userId: string,
  skillId: string,
  apiKeys: string[],
): Promise<Handled> {
  // Level comes from the DB, never the request — see the header note.
  const { data: teaching } = await admin
    .from("user_teaching_skills")
    .select("level, skills:skill_id(id, name)")
    .eq("user_id", userId)
    .eq("skill_id", skillId)
    .maybeSingle();

  const skill = teaching?.skills as { id: string; name: string } | null | undefined;
  if (!teaching || !skill) {
    return { status: 400, body: { error: "Add this skill to the ones you teach first." } };
  }
  const level = (["basic", "intermediate", "advanced"].includes(teaching.level)
    ? teaching.level
    : "basic") as Level;

  const { data: existing } = await admin
    .from("skill_verifications")
    .select("id")
    .eq("user_id", userId)
    .eq("skill_id", skillId)
    .maybeSingle();
  if (existing) {
    return { status: 409, body: { error: "You're already verified for this skill." } };
  }

  const cooldownSince = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const { data: recentFailure } = await admin
    .from("skill_verification_attempts")
    .select("created_at")
    .eq("user_id", userId)
    .eq("skill_id", skillId)
    .eq("status", "failed")
    .gte("created_at", cooldownSince)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentFailure) {
    const retryAt = new Date(new Date(recentFailure.created_at).getTime() + COOLDOWN_MS);
    return {
      status: 429,
      body: {
        error: "You can retry this quiz once the cooldown ends.",
        retryAt: retryAt.toISOString(),
      },
    };
  }

  // Retire any abandoned sitting before starting a new one, so a user can't
  // hold several live attempts for the same skill at once.
  await admin
    .from("skill_verification_attempts")
    .update({ status: "expired", score: 0, completed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("skill_id", skillId)
    .eq("status", "in_progress");

  let questions: GeneratedQuestion[];
  let model: string;
  if (isFixedGuitar(skill.name, level)) {
    questions = buildGuitarQuestions();
    model = "fixed:guitar-basic";
  } else {
    // Every skill other than basic guitar needs the AI, so at least one key is
    // required here rather than being demanded up front for everyone.
    if (apiKeys.length === 0) {
      return { status: 503, body: { error: "Skill verification is not configured yet." } };
    }
    const generated = await generateQuestions(admin, apiKeys, skillId, skill.name, level, userId);
    questions = generated.questions;
    model = generated.model;
  }

  const { data: attempt, error: attemptError } = await admin
    .from("skill_verification_attempts")
    .insert({
      user_id: userId,
      skill_id: skillId,
      level,
      total: QUESTION_COUNT,
      model,
    })
    .select("id, created_at")
    .single();
  if (attemptError || !attempt) {
    throw new Error(attemptError?.message ?? "could not open an attempt");
  }

  const { error: questionsError } = await admin.from("skill_verification_questions").insert(
    questions.map((q, position) => ({
      attempt_id: attempt.id,
      position,
      prompt: q.prompt,
      options: q.options,
      correct_index: q.correctIndex,
      explanation: q.explanation,
    })),
  );
  if (questionsError) {
    // Without questions the attempt can never be graded — retire it rather than
    // leaving a live attempt that blocks the next try.
    await admin
      .from("skill_verification_attempts")
      .update({ status: "expired", score: 0, completed_at: new Date().toISOString() })
      .eq("id", attempt.id);
    throw new Error(questionsError.message);
  }

  const deadlineAt = new Date(new Date(attempt.created_at).getTime() + TOTAL_QUIZ_MS).toISOString();

  // Questions go out WITHOUT correct_index or explanation — only the prompt and
  // options. The key stays in the questions table until the attempt is graded.
  return {
    status: 200,
    body: {
      attemptId: attempt.id,
      skillName: skill.name,
      level,
      passCorrect: PASS_CORRECT,
      total: QUESTION_COUNT,
      deadlineAt,
      questions: questions.map((q, position) => ({
        position,
        prompt: q.prompt,
        options: q.options,
      })),
    },
  };
}

async function handleSubmit(
  admin: SupabaseClient,
  userId: string,
  attemptId: string,
  answers: { position: number; answerIndex: number | null }[],
): Promise<Handled> {
  const { data: attempt } = await admin
    .from("skill_verification_attempts")
    .select("id, user_id, skill_id, level, status, total, created_at")
    .eq("id", attemptId)
    .maybeSingle();

  // Same response for "not yours" and "doesn't exist" — no probing other
  // people's attempt ids.
  if (!attempt || attempt.user_id !== userId) {
    return { status: 404, body: { error: "That quiz attempt could not be found." } };
  }
  if (attempt.status !== "in_progress") {
    return { status: 409, body: { error: "This quiz has already been submitted." } };
  }
  if (Date.now() - new Date(attempt.created_at).getTime() > ATTEMPT_TTL_MS) {
    await admin
      .from("skill_verification_attempts")
      .update({ status: "expired", score: 0, completed_at: new Date().toISOString() })
      .eq("id", attempt.id);
    return { status: 410, body: { error: "This quiz timed out. Start a new one." } };
  }

  const { data: questions } = await admin
    .from("skill_verification_questions")
    .select("id, position, correct_index, explanation, prompt, options")
    .eq("attempt_id", attempt.id)
    .order("position");
  if (!questions || questions.length !== attempt.total) {
    return { status: 500, body: { error: "This quiz is incomplete. Start a new one." } };
  }

  // Last-writer-wins map keyed by position; a duplicate position in the payload
  // just keeps the later one. Anything the client didn't send counts as
  // unanswered.
  const submitted = new Map<number, number | null>();
  for (const answer of answers) submitted.set(answer.position, answer.answerIndex);

  const results = questions.map((q) => {
    const raw = submitted.has(q.position) ? submitted.get(q.position) ?? null : null;
    const chosen = raw === null ? TIMED_OUT : raw;
    return {
      position: q.position,
      prompt: q.prompt,
      options: (q.options ?? []) as string[],
      correctIndex: q.correct_index,
      // -1 travels to the client as null: "you didn't answer this one", which
      // the review screen renders differently from a wrong pick.
      yourIndex: chosen === TIMED_OUT ? null : chosen,
      correct: chosen === q.correct_index,
      explanation: q.explanation ?? "",
      chosen,
    };
  });

  // Record what was chosen for the audit trail before grading is returned.
  await Promise.all(
    results.map((r) =>
      admin
        .from("skill_verification_questions")
        .update({ chosen_index: r.chosen })
        .eq("attempt_id", attempt.id)
        .eq("position", r.position),
    ),
  );

  const score = results.filter((r) => r.correct).length;
  const passed = score >= PASS_CORRECT;
  const completedAt = new Date().toISOString();

  await admin
    .from("skill_verification_attempts")
    .update({ status: passed ? "passed" : "failed", score, completed_at: completedAt })
    .eq("id", attempt.id);

  if (passed) {
    // onConflict keeps a re-pass idempotent rather than erroring on the
    // (user, skill) unique constraint.
    await admin.from("skill_verifications").upsert(
      {
        user_id: userId,
        skill_id: attempt.skill_id,
        level: attempt.level,
        score,
        total: attempt.total,
        attempt_id: attempt.id,
        verified_at: completedAt,
      },
      { onConflict: "user_id,skill_id" },
    );
  }

  return {
    status: 200,
    body: {
      passed,
      score,
      total: attempt.total,
      passCorrect: PASS_CORRECT,
      level: attempt.level,
      retryAt: passed ? null : new Date(Date.now() + COOLDOWN_MS).toISOString(),
      // The answer key is released only now, with the attempt closed. Strip the
      // internal `chosen` field the client doesn't need.
      results: results.map(({ chosen: _chosen, ...row }) => row),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight(req);
  if (req.method !== "POST") return corsJson(req, 405, { error: "Method not allowed" });

  const supabaseUrl = readSecret("SUPABASE_URL");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  // Optional now: basic guitar uses the fixed bank and needs no key. handleStart
  // demands one only when it actually has to generate, and rotates through all
  // that are set.
  const apiKeys = readVerifyKeys();
  if (!supabaseUrl || !serviceKey) {
    return corsJson(req, 500, { error: "Server is not configured." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return corsJson(req, 401, { error: "Sign in to verify a skill." });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authHeader.slice(7));
  const userId = userData?.user?.id;
  if (userError || !userId) {
    return corsJson(req, 401, { error: "Sign in to verify a skill." });
  }

  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await req.json());
  } catch {
    return corsJson(req, 400, { error: "Invalid request." });
  }

  try {
    let result: Handled;
    switch (body.action) {
      case "start":
        result = await handleStart(admin, userId, body.skillId, apiKeys);
        break;
      case "submit":
        result = await handleSubmit(admin, userId, body.attemptId, body.answers);
        break;
    }
    return corsJson(req, result.status, result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verify-skill] ${body.action} failed: ${message}`);
    // Only ever a friendly sentence to the client — the real reason went to the
    // function logs above and stays there.
    return corsJson(req, 502, {
      error:
        body.action === "start"
          ? "Could not build your quiz right now. Please try again in a moment."
          : "Lost the connection to your quiz. Please start again.",
    });
  }
});
