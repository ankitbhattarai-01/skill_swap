import { supabase } from "@/integrations/supabase/client";
import { invalidatePageCaches } from "@/lib/page-caches";
import type { SessionDuration } from "@/lib/sessions";
import type { SessionStatus } from "@/lib/session-queries";

// A direct skill swap is two free, linked sessions (no credits):
//   • the proposer teaches one of their skills to the recipient
//   • the recipient teaches one of their skills back to the proposer
// Both rows share a swap_id and carry is_swap = true. See migration
// 20260612200000_direct_skill_swaps.sql for the server side.

export type SwapSkillOption = { skillId: string; name: string };

// The overlap that makes a swap possible between the current user and someone
// else: skills I teach that they want, and skills they teach that I want.
export type SwapMatch = {
  otherUserId: string;
  otherName: string;
  iCanTeach: SwapSkillOption[]; // my teaching ∩ their learning
  theyCanTeach: SwapSkillOption[]; // their teaching ∩ my learning
};

type SkillRow = { skill_id: string; skills: { id: string; name: string } | null };

function toOptions(
  rows: SkillRow[],
  keepSkillIds: Set<string>,
  seen = new Set<string>(),
): SwapSkillOption[] {
  const out: SwapSkillOption[] = [];
  for (const r of rows) {
    if (!r.skills?.name || !keepSkillIds.has(r.skill_id) || seen.has(r.skill_id)) continue;
    seen.add(r.skill_id);
    out.push({ skillId: r.skill_id, name: r.skills.name });
  }
  return out;
}

// Computes the reciprocal-match overlap between the signed-in user and
// `otherUserId`. Returns null when there's no logged-in user. `iCanTeach` /
// `theyCanTeach` may be empty when no overlap exists — the caller decides how
// to message that. Pass the current user's id (callers already have it from
// auth context) to skip a redundant auth-server round-trip before the queries.
export async function fetchSwapMatch(
  otherUserId: string,
  currentUserId?: string,
): Promise<SwapMatch | null> {
  let me = currentUserId;
  if (!me) {
    const { data: auth } = await supabase.auth.getUser();
    me = auth?.user?.id;
  }
  if (!me) return null;

  const [myTeach, myLearn, theirTeach, theirLearn, otherProfile] = await Promise.all([
    supabase
      .from("user_teaching_skills")
      .select("skill_id, skills:skill_id(id, name)")
      .eq("user_id", me),
    supabase
      .from("user_learning_skills")
      .select("skill_id, skills:skill_id(id, name)")
      .eq("user_id", me),
    supabase
      .from("user_teaching_skills")
      .select("skill_id, skills:skill_id(id, name)")
      .eq("user_id", otherUserId),
    supabase
      .from("user_learning_skills")
      .select("skill_id, skills:skill_id(id, name)")
      .eq("user_id", otherUserId),
    supabase.from("profiles").select("full_name").eq("id", otherUserId).maybeSingle(),
  ]);

  const myTeachRows = (myTeach.data ?? []) as unknown as SkillRow[];
  const myLearnRows = (myLearn.data ?? []) as unknown as SkillRow[];
  const theirTeachRows = (theirTeach.data ?? []) as unknown as SkillRow[];
  const theirLearnRows = (theirLearn.data ?? []) as unknown as SkillRow[];

  const theirLearnIds = new Set(theirLearnRows.map((r) => r.skill_id));
  const myLearnIds = new Set(myLearnRows.map((r) => r.skill_id));

  return {
    otherUserId,
    otherName: otherProfile.data?.full_name ?? "Student",
    iCanTeach: toOptions(myTeachRows, theirLearnIds),
    theyCanTeach: toOptions(theirTeachRows, myLearnIds),
  };
}

export async function proposeSwap(params: {
  recipientId: string;
  mySkillId: string;
  myDuration: SessionDuration;
  myScheduledAt: string;
  theirSkillId: string;
  theirDuration: SessionDuration;
  theirScheduledAt: string;
}): Promise<{ swapId: string | null; error: Error | null }> {
  const { data, error } = await supabase.rpc("propose_swap", {
    p_recipient_id: params.recipientId,
    p_my_skill_id: params.mySkillId,
    p_my_duration: params.myDuration,
    p_my_scheduled_at: params.myScheduledAt,
    p_their_skill_id: params.theirSkillId,
    p_their_duration: params.theirDuration,
    p_their_scheduled_at: params.theirScheduledAt,
  });
  if (error) return { swapId: null, error: new Error(error.message) };
  const { data: auth } = await supabase.auth.getUser();
  invalidatePageCaches(auth?.user?.id);
  return { swapId: (data as string) ?? null, error: null };
}

export async function respondToSwap(
  swapId: string,
  accept: boolean,
): Promise<{ error: Error | null }> {
  const { error } = await supabase.rpc("respond_to_swap", {
    p_swap_id: swapId,
    p_accept: accept,
  });
  if (error) return { error: new Error(error.message) };
  const { data: auth } = await supabase.auth.getUser();
  invalidatePageCaches(auth?.user?.id);
  return { error: null };
}

export async function cancelSwap(swapId: string): Promise<{ error: Error | null }> {
  const { error } = await supabase.rpc("cancel_swap", { p_swap_id: swapId });
  if (error) return { error: new Error(error.message) };
  const { data: auth } = await supabase.auth.getUser();
  invalidatePageCaches(auth?.user?.id);
  return { error: null };
}

// One leg of a swap (a single session row), framed from the viewer's side.
export type SwapLeg = {
  sessionId: string;
  skillName: string;
  scheduledAt: string | null;
  durationMinutes: number;
  meetLink: string | null;
};

export type SwapPair = {
  swapId: string;
  status: SessionStatus;
  // "incoming" = the viewer is the recipient and can accept/decline.
  // "outgoing" = the viewer proposed it and is waiting / can cancel.
  direction: "incoming" | "outgoing";
  otherUserId: string;
  otherName: string;
  otherAvatarUrl: string | null;
  iTeach: SwapLeg; // session where the viewer is the teacher
  theyTeach: SwapLeg; // session where the other person is the teacher
};

type RawSwapRow = {
  id: string;
  teacher_id: string;
  learner_id: string;
  initiator_id: string | null;
  status: SessionStatus;
  scheduled_at: string | null;
  duration_minutes: number | null;
  meet_link: string | null;
  swap_id: string | null;
  skills: { name: string } | null;
};

// Loads the viewer's swaps grouped into pairs. Defaults to the open lifecycle
// statuses (the ones that need a UI surface); pass statuses to widen/narrow.
export async function fetchMySwaps(
  statuses: SessionStatus[] = ["pending", "accepted", "active"],
): Promise<SwapPair[]> {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  if (!me) return [];

  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, teacher_id, learner_id, initiator_id, status, scheduled_at, duration_minutes, meet_link, swap_id, skills:skill_id(name)",
    )
    .eq("is_swap", true)
    .or(`teacher_id.eq.${me},learner_id.eq.${me}`)
    .in("status", statuses)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  const rows = data as unknown as RawSwapRow[];

  // Group the two legs by swap_id.
  const groups = new Map<string, RawSwapRow[]>();
  for (const r of rows) {
    if (!r.swap_id) continue;
    const arr = groups.get(r.swap_id) ?? [];
    arr.push(r);
    groups.set(r.swap_id, arr);
  }

  // Resolve the counterpart names/avatars in one query.
  const otherIds = new Set<string>();
  for (const r of rows) {
    otherIds.add(r.teacher_id === me ? r.learner_id : r.teacher_id);
  }
  const profileById = new Map<string, { name: string; avatarUrl: string | null }>();
  if (otherIds.size) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, avatar_url")
      .in("id", Array.from(otherIds));
    for (const p of people ?? [])
      profileById.set(p.id, { name: p.full_name ?? "Student", avatarUrl: p.avatar_url });
  }

  const leg = (r: RawSwapRow): SwapLeg => ({
    sessionId: r.id,
    skillName: r.skills?.name ?? "a skill",
    scheduledAt: r.scheduled_at,
    durationMinutes: r.duration_minutes ?? 60,
    meetLink: r.meet_link,
  });

  const pairs: SwapPair[] = [];
  for (const [swapId, legs] of groups) {
    // Need both legs to render a swap meaningfully.
    if (legs.length < 2) continue;
    const mine = legs.find((l) => l.teacher_id === me);
    const theirs = legs.find((l) => l.teacher_id !== me);
    if (!mine || !theirs) continue;
    const otherUserId = theirs.teacher_id;
    const proposer = mine.initiator_id ?? theirs.initiator_id;
    pairs.push({
      swapId,
      status: mine.status,
      direction: proposer === me ? "outgoing" : "incoming",
      otherUserId,
      otherName: profileById.get(otherUserId)?.name ?? "Student",
      otherAvatarUrl: profileById.get(otherUserId)?.avatarUrl ?? null,
      iTeach: leg(mine),
      theyTeach: leg(theirs),
    });
  }

  // Pending first (they need action), then by soonest scheduled leg.
  const rank = (p: SwapPair) => (p.status === "pending" ? 0 : 1);
  pairs.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = a.theyTeach.scheduledAt ?? a.iTeach.scheduledAt ?? "";
    const bt = b.theyTeach.scheduledAt ?? b.iTeach.scheduledAt ?? "";
    return at.localeCompare(bt);
  });

  return pairs;
}
