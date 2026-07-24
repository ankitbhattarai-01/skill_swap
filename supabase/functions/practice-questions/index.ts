// Practice problems — the "LeetCode-lite" drill generator.
//
// One action:
//   { action: "generate", skillId, level, count?, avoidPrompts? }
//        -> builds `count` multiple-choice problems for the skill at the chosen
//           difficulty and returns them IN FULL (prompt, options, correctIndex,
//           explanation). The client grades locally and shows an instant verdict.
//
// WHY THE ANSWER KEY SHIPS TO THE CLIENT (unlike verify-skill): Practice is
// zero-stakes. It earns no badge and unlocks nothing — the only thing it moves
// is a personal "solved" counter that is advisory, not a reward. Returning the
// full problem lets the client grade the moment a choice is made, LeetCode-style,
// with no second round-trip and no per-problem server latency. Nothing is
// persisted here; there is no questions table and no attempt to protect.
//
// WHY THE LEVEL COMES FROM THE REQUEST (unlike verify-skill): the user freely
// picks Easy/Medium/Hard for practice, so `level` is read from the body and
// validated against the enum. The skill NAME is still looked up from the DB from
// the id, never trusted from the body, so a client can't inject arbitrary
// generation topics.
//
// RESILIENCE (same ladder as verify-skill): the model is over-asked for a few
// extra problems and only the clean ones are kept; a responseSchema pins the
// JSON shape with a bare-payload retry for models that 400 on it; each key tries
// SIX models (flash + flash-lite families, each with its own free-tier quota
// bucket); and the whole thing runs inside one bounded time budget with
// rate-limit-aware backoff between passes.
//
// Supabase secrets — SIX dedicated Practice keys are tried in order. Practice
// deliberately does NOT fall back to the verify keys: verification has to stay
// available on demand, and a busy Practice session must never burn the quota a
// user needs to earn their skill tick. ANY failure from one key (rate limit,
// quota, bad key, model error) falls through to the next. Set as many as you
// have; missing ones are skipped:
//   GEMINI_PRACTICE_API_KEY        (main)
//   GEMINI_PRACTICE_API_KEY_2 … _6 (fallbacks)
// All from https://aistudio.google.com/apikey — for real redundancy, put them in
// DIFFERENT Google projects so they don't share the same quota bucket.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import { corsJson, corsPreflight } from "../_shared/cors.ts";

// How many problems one "generate" call returns. Kept small so the first batch
// paints fast; the client prefetches the next batch before this one runs out.
const DEFAULT_COUNT = 5;
const MIN_COUNT = 3;
const MAX_COUNT = 8;

// Over-ask so the strict validation below has slack — a couple of malformed or
// duplicate problems no longer sink the batch. Scaled to the requested count.
function generateCountFor(count: number) {
  return Math.min(count + 4, MAX_COUNT + 4);
}

// One Gemini call may not hang the whole request.
const MODEL_CALL_TIMEOUT_MS = 20_000;

// Everything generation may spend in one request — all passes, all waits. The
// user is watching a spinner; past this we give up with the friendly error.
const GENERATION_BUDGET_MS = 40_000;

// Between failed passes, when Gemini didn't suggest its own retryDelay.
const PASS_RETRY_WAIT_MS = 8_000;
const MAX_PASSES = 3;

// Quality-first ladder. The flash-lite rungs matter beyond quality fallback: on
// the free tier EVERY model id has its own RPM/RPD bucket, so the lites stay
// serviceable after the flashes are rate-limited. Floating aliases first (they
// follow Google's newest snapshot), pinned ids behind them for keys that can't
// see an alias yet.
const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

// Pins the JSON shape at the decoder, which kills most "N usable problems"
// failures before they happen. Models that reject it get one bare retry.
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

type Level = "basic" | "intermediate" | "advanced";

const GenerateSchema = z.object({
  action: z.literal("generate"),
  skillId: z.string().uuid(),
  level: z.enum(["basic", "intermediate", "advanced"]),
  count: z.number().int().min(MIN_COUNT).max(MAX_COUNT).optional(),
  // Prompts the client has already seen this session — the model is told to
  // avoid repeating them. Capped so a long session can't bloat the request.
  avoidPrompts: z.array(z.string()).max(40).optional(),
});

const RequestSchema = z.discriminatedUnion("action", [GenerateSchema]);

type GeneratedProblem = {
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

// LeetCode-style label the prompt uses so the difficulty framing reads naturally.
const LEVEL_LABEL: Record<Level, string> = {
  basic: "Easy",
  intermediate: "Medium",
  advanced: "Hard",
};

function readSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

// The Gemini key ladder: the six dedicated Practice keys, in order. It stops
// there on purpose — the verify keys are NOT reused here, so Practice traffic
// can never eat into the quota that skill verification depends on. Missing keys
// are skipped and duplicates dropped, so a repeated key never wastes a retry.
function readPracticeKeys(): string[] {
  const names = [
    "GEMINI_PRACTICE_API_KEY",
    "GEMINI_PRACTICE_API_KEY_2",
    "GEMINI_PRACTICE_API_KEY_3",
    "GEMINI_PRACTICE_API_KEY_4",
    "GEMINI_PRACTICE_API_KEY_5",
    "GEMINI_PRACTICE_API_KEY_6",
  ];
  const keys: string[] = [];
  for (const name of names) {
    const value = readSecret(name);
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

function buildPrompt(
  skillName: string,
  level: Level,
  generateCount: number,
  keepCount: number,
  avoidPrompts: string[],
) {
  const avoidBlock =
    avoidPrompts.length > 0
      ? `\n\nThe learner has already seen these questions this session — do NOT repeat them or ask the same idea reworded:\n${avoidPrompts
          .slice(0, 40)
          .map((p) => `- ${p}`)
          .join("\n")}`
      : "";

  return `You are writing practice problems for someone drilling "${skillName}" on a peer skill-exchange platform. This is a ${LEVEL_LABEL[level]}-difficulty practice set — like a LeetCode-style problem, but for this skill.

Target learner: ${LEVEL_BRIEF[level]}

Write exactly ${generateCount} multiple-choice practice problems about "${skillName}" at the ${level} level. Only the best ${keepCount} will be used, so every problem must stand on its own.

Rules:
- Exactly 4 options per problem. Exactly one is correct.
- The three wrong options must be genuinely plausible to someone who half-knows the topic. No filler, no joke answers, no "none of the above".
- All 4 options must be clearly different from each other — never two options that mean the same thing.
- Do not make the correct answer consistently the longest or most detailed option.
- Each problem must stand alone. Never refer to "the previous problem" or to code that was not included in the problem text.
- Ask about the skill itself, not about this platform, and never about the learner's opinions or personal experience.
- Vary what you test across the ${generateCount} problems; do not ask the same idea twice in different words.
- Keep each problem under 240 characters. Include short code inline with backticks if the skill needs it.
- Keep each explanation under 20 words — a crisp reason the correct answer is right, so the learner actually learns from it.${avoidBlock}

Return ONLY a JSON array, no markdown fence, no commentary:
[{"prompt":"...","options":["a","b","c","d"],"correctIndex":0,"explanation":"one short sentence on why that answer is right"}]`;
}

// Gemini returns JSON as text and sometimes wraps it in a markdown fence despite
// being told not to. Strip the fence before parsing.
function parseJsonArray(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

// Rejects anything malformed rather than repairing it. The model is over-asked
// precisely so dropping a few bad problems still leaves `keepCount` good ones.
function validateProblems(parsed: unknown, keepCount: number): GeneratedProblem[] {
  if (!Array.isArray(parsed)) throw new Error("model did not return an array");
  const seen = new Set<string>();
  const problems: GeneratedProblem[] = [];

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
    // Duplicate options make the problem unanswerable — two identical choices
    // where only one is keyed correct.
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    problems.push({ prompt, options, correctIndex, explanation });
    if (problems.length === keepCount) break;
  }

  if (problems.length < keepCount) {
    throw new Error(`model produced ${problems.length}/${keepCount} usable problems`);
  }
  return problems;
}

// Fisher-Yates over an arbitrary array.
function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Shuffles a problem's four options and re-points its correctIndex, so the
// correct answer isn't always in the same slot.
function shuffleOptions(problem: GeneratedProblem): GeneratedProblem {
  const indices = shuffle(problem.options.map((_, i) => i));
  return {
    ...problem,
    options: indices.map((i) => problem.options[i]),
    correctIndex: indices.indexOf(problem.correctIndex),
  };
}

// Gemini's 429 body carries a RetryInfo detail like "retryDelay":"22s" — the
// authoritative wait, when present, for the pass-level backoff.
function parseRetryDelayMs(errorText: string): number | null {
  const match = errorText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

type ModelTry =
  | { ok: true; problems: GeneratedProblem[] }
  | { ok: false; status: number | null; error: string; retryDelayMs: number | null };

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  keepCount: number,
  lean: boolean,
): Promise<ModelTry> {
  // The 2.5-family models "think" before answering by default, which adds
  // several silent seconds before the first token of JSON. Practice problems
  // don't need chain-of-thought — turning it off is the biggest latency win.
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
            // A little more variety than the verify quiz — a fresh practice set
            // each time matters more than perfectly tight difficulty here.
            temperature: 0.85,
            responseMimeType: "application/json",
            // Up to 12 over-generated problems (4 options + explanation each) is
            // a lot of JSON; too small a cap truncates the array and every rung
            // fails to parse. Matches the headroom verify-skill uses.
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
    const problems = validateProblems(parseJsonArray(text), keepCount).map(shuffleOptions);
    return { ok: true, problems };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 200, error: `${model}: ${reason}`, retryDelayMs: null };
  }
}

type PassResult =
  | { ok: true; problems: GeneratedProblem[]; model: string }
  | { ok: false; lastError: string; retryDelayMs: number | null };

// One full sweep of every key x every model. A rung that fails for ANY reason
// falls through to the next — a 400 gets one bare-payload retry first, since
// that means the model disliked the request shape, not that it is rate-limited.
async function runLadderPass(
  apiKeys: string[],
  prompt: string,
  keepCount: number,
  deadline: number,
): Promise<PassResult> {
  let lastError = "";
  let retryDelayMs: number | null = null;

  for (let i = 0; i < apiKeys.length; i++) {
    for (const model of GEMINI_MODELS) {
      if (deadline - Date.now() < 3000) {
        return { ok: false, lastError: lastError || "generation budget exhausted", retryDelayMs };
      }

      let outcome = await callGemini(apiKeys[i], model, prompt, keepCount, false);
      if (!outcome.ok && outcome.status === 400) {
        outcome = await callGemini(apiKeys[i], model, prompt, keepCount, true);
      }
      if (outcome.ok) return { ok: true, problems: outcome.problems, model };

      lastError = `key ${i + 1}/${apiKeys.length}: ${outcome.error}`;
      console.warn(`[practice-questions] ${lastError}`);
      if (outcome.retryDelayMs !== null) {
        retryDelayMs = retryDelayMs === null
          ? outcome.retryDelayMs
          : Math.min(retryDelayMs, outcome.retryDelayMs);
      }
    }
  }

  return { ok: false, lastError: lastError || "no API key produced a usable set", retryDelayMs };
}

// The bounded generation ladder: fresh generation with rate-limit-aware retry
// passes, all inside one time budget. Throws only when every pass came up empty.
async function generateProblems(
  apiKeys: string[],
  skillName: string,
  level: Level,
  count: number,
  avoidPrompts: string[],
): Promise<{ problems: GeneratedProblem[]; model: string }> {
  const deadline = Date.now() + GENERATION_BUDGET_MS;
  const generateCount = generateCountFor(count);
  const prompt = buildPrompt(skillName, level, generateCount, count, avoidPrompts);
  let lastError = "";

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await runLadderPass(apiKeys, prompt, count, deadline);
    if (result.ok) return { problems: result.problems, model: result.model };
    lastError = result.lastError;
    console.warn(`[practice-questions] generation pass ${pass}/${MAX_PASSES} failed: ${lastError}`);

    const wait = Math.min(
      Math.max(result.retryDelayMs ?? PASS_RETRY_WAIT_MS, 2000),
      15_000,
      deadline - Date.now() - 5000,
    );
    if (pass === MAX_PASSES || wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  throw new Error(lastError || "no API key produced a usable set");
}

type Handled = { status: number; body: Record<string, unknown> };

async function handleGenerate(
  admin: SupabaseClient,
  skillId: string,
  level: Level,
  count: number,
  avoidPrompts: string[],
  apiKeys: string[],
): Promise<Handled> {
  // Skill NAME comes from the DB from its id — never trusted from the body — so
  // a client can't inject an arbitrary generation topic.
  const { data: skill } = await admin
    .from("skills")
    .select("id, name, is_active")
    .eq("id", skillId)
    .maybeSingle();

  if (!skill || skill.is_active === false) {
    return { status: 404, body: { error: "That skill isn't available to practice." } };
  }

  if (apiKeys.length === 0) {
    return { status: 503, body: { error: "Practice isn't configured yet." } };
  }

  const { problems, model } = await generateProblems(
    apiKeys,
    skill.name,
    level,
    count,
    avoidPrompts,
  );

  return {
    status: 200,
    body: {
      skillId: skill.id,
      skillName: skill.name,
      level,
      model,
      problems: problems.map((p, position) => ({
        position,
        prompt: p.prompt,
        options: p.options,
        correctIndex: p.correctIndex,
        explanation: p.explanation,
      })),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight(req);
  if (req.method !== "POST") return corsJson(req, 405, { error: "Method not allowed" });

  const supabaseUrl = readSecret("SUPABASE_URL");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  const apiKeys = readPracticeKeys();
  if (!supabaseUrl || !serviceKey) {
    return corsJson(req, 500, { error: "Server is not configured." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return corsJson(req, 401, { error: "Sign in to practice." });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(authHeader.slice(7));
  const userId = userData?.user?.id;
  if (userError || !userId) {
    return corsJson(req, 401, { error: "Sign in to practice." });
  }

  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await req.json());
  } catch {
    return corsJson(req, 400, { error: "Invalid request." });
  }

  try {
    const result = await handleGenerate(
      admin,
      body.skillId,
      body.level,
      body.count ?? DEFAULT_COUNT,
      body.avoidPrompts ?? [],
      apiKeys,
    );
    return corsJson(req, result.status, result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[practice-questions] generate failed: ${message}`);
    // Only ever a friendly sentence to the client — the real reason went to the
    // function logs above and stays there.
    return corsJson(req, 502, {
      error: "Couldn't build practice problems right now. Please try again in a moment.",
    });
  }
});
