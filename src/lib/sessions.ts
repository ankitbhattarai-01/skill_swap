import { supabase } from "@/integrations/supabase/client";
import { invalidatePageCaches } from "@/lib/page-caches";

const OPEN_SESSION_STATUSES = ["pending", "accepted", "active"] as const;
const CHAT_SESSION_STATUSES = ["accepted", "active"] as const;

export const SESSION_DURATIONS = [30, 60, 90] as const;
export type SessionDuration = (typeof SESSION_DURATIONS)[number];

export function computeSessionCredits(creditsPerHour: number, durationMinutes: SessionDuration) {
  return Math.max(1, Math.ceil((creditsPerHour * durationMinutes) / 60));
}

export const JOIN_WINDOW_BEFORE_MS = 2 * 60 * 1000;
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

export function buildSessionIcsFile({
  sessionId,
  skillName,
  scheduledAt,
  durationMinutes,
  meetLink,
  organizerName,
  attendeeName,
}: {
  sessionId: string;
  skillName: string;
  scheduledAt: string;
  durationMinutes: number;
  meetLink: string | null;
  organizerName: string;
  attendeeName: string;
}) {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
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

async function findOpenSession(learnerId: string, teacherId: string, skillId: string) {
  return supabase
    .from("sessions")
    .select("id")
    .eq("learner_id", learnerId)
    .eq("teacher_id", teacherId)
    .eq("skill_id", skillId)
    .in("status", [...OPEN_SESSION_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
    const { data: raced } = await findOpenSession(learnerId, teacherId, skillId);
    if (raced?.id) return { sessionId: raced.id, error: null, created: false };
  }

  // A new pending session changes what dashboard and explore should render
  // (open-session badges, request buttons), so drop their cached snapshots.
  if (data?.id) invalidatePageCaches(initiatorId);

  return { sessionId: data?.id ?? null, error, created: Boolean(data?.id) };
}
