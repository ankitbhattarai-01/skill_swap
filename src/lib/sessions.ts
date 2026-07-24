import { supabase } from "@/integrations/supabase/client";
import { invalidatePageCaches } from "@/lib/page-caches";

const OPEN_SESSION_STATUSES = ["pending", "accepted", "active"] as const;
const CHAT_SESSION_STATUSES = ["accepted", "active"] as const;

export const SESSION_DURATIONS = [20, 30, 60] as const;
export type SessionDuration = (typeof SESSION_DURATIONS)[number];

export function computeSessionCredits(creditsPerHour: number, durationMinutes: SessionDuration) {
  return Math.max(1, Math.ceil((creditsPerHour * durationMinutes) / 60));
}

// Raw database errors (RLS policy violations, check constraints) leak the
// table/policy name and Postgres jargon into the UI toast. Translate the ones
// a normal learner can actually trigger into plain language. Anything we don't
// recognise falls through unchanged.
function friendlyRequestError<E extends { message?: string }>(error: E | null): E | Error | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (message.includes("Suspended users cannot create sessions")) {
    return new Error(
      "Your account is currently suspended, so you can't request new sessions. " +
        "Please contact support if you think this is a mistake.",
    );
  }
  return error;
}

// Join window must match the server-side check in
// supabase/functions/mint-jitsi-token. Previously the client gated at
// 2 minutes before scheduled_at while the edge function minted tokens
// 10 minutes before — direct API callers got an 8-minute head start
// past the UI restriction. Both sides are now 10 min before / 30 min
// after, so the Join button appearing is the source of truth.
export const JOIN_WINDOW_BEFORE_MS = 10 * 60 * 1000;
export const JOIN_WINDOW_AFTER_MS = 30 * 60 * 1000;

export function getJoinWindow(scheduledAt: string | null, durationMinutes: number) {
  if (!scheduledAt) return null;
  const start = new Date(scheduledAt).getTime();
  if (Number.isNaN(start)) return null;
  return {
    opensAt: start - JOIN_WINDOW_BEFORE_MS,
    closesAt: start + durationMinutes * 60 * 1000 + JOIN_WINDOW_AFTER_MS,
  };
}

export function canJoinSession(
  scheduledAt: string | null,
  durationMinutes: number,
  now = Date.now(),
) {
  const window = getJoinWindow(scheduledAt, durationMinutes);
  if (!window) return true;
  return now >= window.opensAt && now <= window.closesAt;
}

export function describeJoinWindow(
  scheduledAt: string | null,
  durationMinutes: number,
  now = Date.now(),
) {
  const window = getJoinWindow(scheduledAt, durationMinutes);
  if (!window || !scheduledAt) return null;
  const start = new Date(scheduledAt).getTime();
  if (now < window.opensAt) {
    const msUntilStart = start - now;
    if (msUntilStart >= 60 * 60 * 1000) {
      const hoursUntil = Math.ceil(msUntilStart / (60 * 60 * 1000));
      return `Starts in ${hoursUntil} hr`;
    }
    const minsUntilStart = Math.max(1, Math.ceil(msUntilStart / 60000));
    return `Starts in ${minsUntilStart} min`;
  }
  if (now > window.closesAt) return "Session window has closed";
  return null;
}

export type SessionCalendarDetails = {
  sessionId: string;
  skillName: string;
  scheduledAt: string;
  durationMinutes: number;
  meetLink: string | null;
  organizerName: string;
  attendeeName: string;
};

// Compact UTC stamp shared by the .ics file and the web-calendar deep links:
// YYYYMMDDTHHMMSSZ.
function formatCalendarUtc(d: Date) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}

function sessionWindow({ scheduledAt, durationMinutes }: SessionCalendarDetails) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return { start, end };
}

function sessionTitleAndDetails({
  skillName,
  meetLink,
  organizerName,
  attendeeName,
}: SessionCalendarDetails) {
  const title = `SkillSwap: ${skillName}`;
  const details = `${organizerName} teaching ${skillName} to ${attendeeName}.${meetLink ? `\nJoin: ${meetLink}` : ""}`;
  return { title, details };
}

// Opens Google Calendar with a pre-filled "new event" form in a new tab.
// https://calendar.google.com/calendar/render?action=TEMPLATE&...
export function buildGoogleCalendarUrl(details: SessionCalendarDetails) {
  const { start, end } = sessionWindow(details);
  const { title, details: description } = sessionTitleAndDetails(details);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${formatCalendarUtc(start)}/${formatCalendarUtc(end)}`,
    details: description,
  });
  if (details.meetLink) params.set("location", details.meetLink);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Opens Outlook on the web with a pre-filled "new event" form in a new tab.
export function buildOutlookCalendarUrl(details: SessionCalendarDetails) {
  const { start, end } = sessionWindow(details);
  const { title, details: description } = sessionTitleAndDetails(details);
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: description,
  });
  if (details.meetLink) params.set("location", details.meetLink);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function buildSessionIcsFile({
  sessionId,
  skillName,
  scheduledAt,
  durationMinutes,
  meetLink,
  organizerName,
  attendeeName,
}: SessionCalendarDetails) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const fmt = formatCalendarUtc;
  const escape = (text: string) => text.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SkillSwap//Session//EN",
    "BEGIN:VEVENT",
    `UID:skillswap-${sessionId}@skillswap`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${escape(`SkillSwap: ${skillName}`)}`,
    `DESCRIPTION:${escape(`${organizerName} teaching ${skillName} to ${attendeeName}.${meetLink ? `\nJoin: ${meetLink}` : ""}`)}`,
    meetLink ? `URL:${meetLink}` : null,
    meetLink ? `LOCATION:${escape(meetLink)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((line): line is string => line !== null);
  return lines.join("\r\n");
}

export function downloadSessionIcs(filename: string, content: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Mirrors the sessions_one_open_request_per_skill_time unique index
// (20260610000000): a pair+skill may hold several open sessions as long as each
// is at a distinct scheduled_at. The lookup therefore keys on the requested
// time too — a null time only matches the (single possible) unscheduled open
// session, preserving the legacy "one open unscheduled request" behavior.
async function findOpenSession(
  learnerId: string,
  teacherId: string,
  skillId: string,
  scheduledAt: string | null,
) {
  let query = supabase
    .from("sessions")
    .select("id")
    .eq("learner_id", learnerId)
    .eq("teacher_id", teacherId)
    .eq("skill_id", skillId)
    .in("status", [...OPEN_SESSION_STATUSES]);
  query =
    scheduledAt === null ? query.is("scheduled_at", null) : query.eq("scheduled_at", scheduledAt);
  return query.order("created_at", { ascending: false }).limit(1).maybeSingle();
}

export async function findAcceptedSession(learnerId: string, teacherId: string, skillId: string) {
  return supabase
    .from("sessions")
    .select("id, status")
    .eq("learner_id", learnerId)
    .eq("teacher_id", teacherId)
    .eq("skill_id", skillId)
    .in("status", [...CHAT_SESSION_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function getOrCreateSession({
  learnerId,
  teacherId,
  initiatorId,
  skillId,
  creditsPerHour,
  durationMinutes,
  scheduledAt,
}: {
  learnerId: string;
  teacherId: string;
  initiatorId: string;
  skillId: string;
  creditsPerHour: number;
  durationMinutes: SessionDuration;
  scheduledAt?: string | null;
}) {
  if (initiatorId !== learnerId && initiatorId !== teacherId) {
    return {
      sessionId: null,
      error: new Error("Session initiator must be a participant."),
      created: false,
    };
  }

  const { data: existing, error: existingError } = await findOpenSession(
    learnerId,
    teacherId,
    skillId,
    scheduledAt ?? null,
  );

  if (existingError) return { sessionId: null, error: existingError, created: false };
  if (existing?.id) return { sessionId: existing.id, error: null, created: false };

  const credits = computeSessionCredits(creditsPerHour, durationMinutes);

  // Pre-check the learner's balance only when the learner is the one creating
  // the request — they are the only caller able to read their own credits
  // (other users' credits are hidden by the column GRANT, see migration
  // 20260511050000_hide_public_credits.sql). When a teacher initiates an
  // offer, skip the pre-check; accept_session() enforces the balance at
  // settlement time and surfaces a friendly error if it fails.
  if (initiatorId === learnerId) {
    const { data: learnerBalance, error: balanceError } = await supabase.rpc("my_credit_balance");
    if (balanceError) return { sessionId: null, error: balanceError, created: false };
    const learnerCredits = learnerBalance ?? 0;
    if (learnerCredits < credits) {
      return {
        sessionId: null,
        error: new Error(
          `Learner does not have enough credits (${credits} needed, ${learnerCredits} available).`,
        ),
        created: false,
      };
    }
  }

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      learner_id: learnerId,
      teacher_id: teacherId,
      initiator_id: initiatorId,
      skill_id: skillId,
      status: "pending",
      credits,
      duration_minutes: durationMinutes,
      scheduled_at: scheduledAt ?? null,
    })
    .select("id")
    .single();

  // Concurrent click lost the race against the unique partial index — recover
  // by returning the row the winning insert created.
  if (error?.code === "23505") {
    const { data: raced } = await findOpenSession(
      learnerId,
      teacherId,
      skillId,
      scheduledAt ?? null,
    );
    if (raced?.id) return { sessionId: raced.id, error: null, created: false };
  }

  // A new pending session changes what dashboard and explore should render
  // (open-session badges, request buttons), so drop their cached snapshots.
  if (data?.id) invalidatePageCaches(initiatorId);

  return {
    sessionId: data?.id ?? null,
    error: friendlyRequestError(error),
    created: Boolean(data?.id),
  };
}

// Books several sessions at once for the same teacher + skill — one pending
// session per chosen start time. Each row goes through the normal lifecycle
// (server recomputes credits, the teacher gets a `session_requested`
// notification, and accepts/declines each one individually from the
// dashboard), so a multi-session plan is just N ordinary requests. Credits are
// only escrowed as each session is accepted, never up front.
//
// Inserted as a single statement so it's all-or-nothing: if any slot collides
// with an existing open session at that exact time, the whole batch is rejected
// and surfaced, rather than leaving a half-booked plan.
export async function requestSessionsForSlots({
  learnerId,
  teacherId,
  skillId,
  creditsPerHour,
  durationMinutes,
  startTimes,
}: {
  learnerId: string;
  teacherId: string;
  skillId: string;
  creditsPerHour: number;
  durationMinutes: SessionDuration;
  startTimes: string[];
}): Promise<{ created: number; firstSessionId: string | null; error: Error | null }> {
  if (startTimes.length === 0) {
    return { created: 0, firstSessionId: null, error: new Error("Pick at least one session time.") };
  }

  // credits is recomputed server-side by the enforce_session_credits trigger;
  // we still send a sane value to satisfy the NOT NULL / > 0 insert policy.
  const credits = computeSessionCredits(creditsPerHour, durationMinutes);
  // Tie the sessions together as one "plan" so the UI can group them (all times
  // + progress). A lone booking stays ungrouped and renders like any single
  // session.
  const batchId = startTimes.length > 1 ? crypto.randomUUID() : null;
  const rows = startTimes.map((scheduledAt) => ({
    learner_id: learnerId,
    teacher_id: teacherId,
    initiator_id: learnerId,
    skill_id: skillId,
    status: "pending" as const,
    credits,
    duration_minutes: durationMinutes,
    scheduled_at: scheduledAt,
    batch_id: batchId,
  }));

  const { data, error } = await supabase.from("sessions").insert(rows).select("id");

  if (data && data.length) invalidatePageCaches(learnerId);

  const friendly = friendlyRequestError(error);
  let normalizedError: Error | null = null;
  if (friendly instanceof Error) {
    normalizedError = friendly;
  } else if (friendly) {
    const message = (friendly as { message?: string }).message;
    normalizedError = new Error(message ?? "Could not request the sessions.");
  }
  return { created: data?.length ?? 0, firstSessionId: data?.[0]?.id ?? null, error: normalizedError };
}
