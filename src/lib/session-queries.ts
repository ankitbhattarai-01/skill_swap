// Shared helpers for the sessions table read paths.
//
// Three routes (dashboard, history, sessions/$sessionId) all need to:
//   1. SELECT a row shape that varies slightly per page,
//   2. Tolerate older deployments where `initiator_id` or `duration_minutes`
//      columns aren't in the schema cache yet,
//   3. Normalize the resulting row so consumers can rely on those two fields.
//
// Keeping four hand-maintained SELECT constants and two helpers in lockstep
// across three files is a maintenance hazard — drift here means one route
// silently returns a different row shape than the others. This module is the
// single source of truth.
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

export type SessionStatus = Enums<"session_status">;

export type RawSessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  initiator_id: string | null;
  skill_id: string;
  status: SessionStatus;
  credits: number;
  duration_minutes: number;
  scheduled_at: string | null;
  meet_link: string | null;
  created_at: string;
  updated_at?: string;
  skills: { id: string; name: string; category?: string | null } | null;
};

export type SessionQueryError = {
  message?: string;
  code?: string;
  details?: string | null;
};

export function isSessionSchemaMismatch(error: SessionQueryError | null | undefined) {
  const raw = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();
  return (
    (error?.code === "PGRST204" || error?.code === "42703" || raw.includes("schema cache")) &&
    (raw.includes("initiator_id") || raw.includes("duration_minutes"))
  );
}

// Fill the two columns that may be absent on older schemas so downstream code
// can read them unconditionally.
export function normalizeSessionRow<T extends Partial<RawSessionRow>>(
  row: T,
): T & { initiator_id: string | null; duration_minutes: number } {
  return {
    ...row,
    initiator_id: row.initiator_id ?? row.learner_id ?? null,
    duration_minutes: row.duration_minutes ?? 60,
  } as T & { initiator_id: string | null; duration_minutes: number };
}

export type SessionSelectOptions = {
  // History needs updated_at for last-activity sorting; the other two don't.
  includeUpdatedAt?: boolean;
  // The session detail page needs skills.category for the badge; the other
  // two don't request it.
  includeSkillCategory?: boolean;
};

// Returns the fallback ladder of SELECT lists, newest-schema first. Each
// successive list drops a column that some older deployments may not have.
export function buildSessionSelects(opts: SessionSelectOptions = {}): string[] {
  const skillsCols = opts.includeSkillCategory ? "id, name, category" : "id, name";
  const tail = `${opts.includeUpdatedAt ? ", updated_at" : ""}, skills:skill_id(${skillsCols})`;
  const base =
    "id, learner_id, teacher_id, skill_id, status, credits, scheduled_at, meet_link, created_at";
  return [
    // Current schema: both initiator_id and duration_minutes present.
    `id, learner_id, teacher_id, initiator_id, skill_id, status, credits, duration_minutes, scheduled_at, meet_link, created_at${tail}`,
    // No initiator_id, has duration_minutes.
    `id, learner_id, teacher_id, skill_id, status, credits, duration_minutes, scheduled_at, meet_link, created_at${tail}`,
    // Has initiator_id, no duration_minutes.
    `id, learner_id, teacher_id, initiator_id, skill_id, status, credits, scheduled_at, meet_link, created_at${tail}`,
    // Legacy: neither column.
    `${base}${tail}`,
  ];
}

// Try each SELECT in order until one succeeds. Re-throws any non-schema error
// immediately so we don't mask real failures behind the fallback ladder.
async function runWithSelectFallback<T>(
  selects: string[],
  run: (select: string) => Promise<{ data: T; error: SessionQueryError | null }>,
): Promise<T> {
  let lastError: SessionQueryError | null = null;
  for (const select of selects) {
    const { data, error } = await run(select);
    if (!error) return data;
    lastError = error;
    if (!isSessionSchemaMismatch(error)) throw error;
  }
  throw lastError ?? new Error("Could not run sessions query");
}

// Multi-row read filtered by participant + status set.
export async function queryUserSessions(opts: {
  userId: string;
  statuses: SessionStatus[];
  limit?: number;
  selectOptions?: SessionSelectOptions;
}): Promise<RawSessionRow[]> {
  const selects = buildSessionSelects(opts.selectOptions);
  const data = await runWithSelectFallback<unknown[] | null>(selects, async (select) => {
    let query = supabase
      .from("sessions")
      .select(select)
      .or(`learner_id.eq.${opts.userId},teacher_id.eq.${opts.userId}`)
      .in("status", opts.statuses)
      .order("created_at", { ascending: false });
    if (opts.limit) query = query.limit(opts.limit);
    const { data, error } = await query;
    return { data: data as unknown[] | null, error: error as SessionQueryError | null };
  });
  return (data ?? []).map(
    (row) => normalizeSessionRow(row as Partial<RawSessionRow>) as RawSessionRow,
  );
}

// Single-row read by id. Returns null if not found.
export async function querySessionById(opts: {
  sessionId: string;
  selectOptions?: SessionSelectOptions;
  signal?: AbortSignal;
}): Promise<RawSessionRow | null> {
  const selects = buildSessionSelects(opts.selectOptions);
  const data = await runWithSelectFallback<unknown | null>(selects, async (select) => {
    let query = supabase.from("sessions").select(select).eq("id", opts.sessionId);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query.maybeSingle();
    return { data: data as unknown, error: error as SessionQueryError | null };
  });
  return data ? (normalizeSessionRow(data as Partial<RawSessionRow>) as RawSessionRow) : null;
}
