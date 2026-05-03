import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ReportDialog } from "@/components/ReportDialog";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { getVideoRoomUrl } from "@/lib/jitsi";
import {
  canJoinSession,
  describeJoinWindow,
  buildSessionIcsFile,
  downloadSessionIcs,
} from "@/lib/sessions";
import { ConfirmAction } from "@/components/ConfirmAction";
import { RescheduleSection } from "@/components/RescheduleSection";
import type { Enums } from "@/integrations/supabase/types";
import { ArrowLeft, Calendar, Check, Loader2, MessageCircle, Video, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { playCancelChime } from "@/lib/sounds";
import { markSelfAction } from "@/lib/self-action";
import { useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { querySessionById, type RawSessionRow as SharedRawSessionRow } from "@/lib/session-queries";

export const Route = createFileRoute("/sessions/$sessionId")({
  head: () => ({ meta: [{ title: "Session - SkillSwap" }] }),
  component: SessionPage,
});

type SessionStatus = Enums<"session_status">;

type SessionRow = {
  id: string;
  learner_id: string;
  teacher_id: string;
  initiator_id: string | null;
  skill_id: string;
  status: SessionStatus;
  credits: number;
  duration_minutes: number;
  meet_link: string | null;
  scheduled_at: string | null;
  created_at: string;
  skills: { id: string; name: string; category: string | null } | null;
  learnerName: string;
  teacherName: string;
};

type RawSessionRow = Omit<SessionRow, "learnerName" | "teacherName"> & SharedRawSessionRow;

async function querySessionRow(sessionId: string) {
  const row = await querySessionById({
    sessionId,
    selectOptions: { includeSkillCategory: true },
  });
  return row as RawSessionRow | null;
}

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const invalidateCreditBalance = useInvalidateMyCreditBalance();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState("");

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: `/sessions/${sessionId}` } });
    }
  }, [authLoading, navigate, sessionId, user]);

  const loadSession = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const row = await querySessionRow(sessionId);

      if (!row) {
        toast.error("Session not found");
        navigate({ to: "/dashboard" });
        return;
      }

      if (row.learner_id !== user.id && row.teacher_id !== user.id) {
        toast.error("You do not have access to this session");
        navigate({ to: "/dashboard" });
        return;
      }

      const { data: people } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", [row.learner_id, row.teacher_id]);
      const names = new Map(
        (people ?? []).map((person) => [person.id, person.full_name ?? "Student"]),
      );

      // meet_link is set by accept_session() to the internal /video/<id> deep
      // link and is locked thereafter (UPDATE grant revoked). The actual Jitsi
      // URL is always derived client-side from sessionId via getVideoRoomUrl.
      const derivedLink =
        row.status === "accepted" || row.status === "active"
          ? getVideoRoomUrl({
              link: row.meet_link,
              sessionId: row.id,
              skillName: row.skills?.name,
            })
          : row.meet_link;

      setSession({
        ...row,
        meet_link: derivedLink,
        learnerName: names.get(row.learner_id) ?? "Student",
        teacherName: names.get(row.teacher_id) ?? "Student",
      });
      setLoading(false);
    } catch (error) {
      toastError(error, "Could not load session");
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, user]);

  const acceptSession = async () => {
    if (!session) return;
    setBusy("accept");
    try {
      // meet_link is derived server-side by accept_session() — the second arg
      // is accepted for backward compatibility but ignored. We pass null so
      // there's no chance of a teacher-supplied URL leaking through.
      const { error } = await supabase.rpc("accept_session", {
        p_session_id: session.id,
        p_meet_link: null,
      });
      if (error) return toast.error(error.message);
      markSelfAction(session.id, ["session_accepted"]);
      void invalidateCreditBalance();
      toast.success(`Session accepted, ${session.credits} credits held in escrow`);
      await loadSession();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not accept session");
    } finally {
      setBusy(null);
    }
  };

  const rejectSession = async () => {
    if (!session) return;
    setBusy("reject");
    const { error } = await supabase.rpc("reject_session", {
      p_session_id: session.id,
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    markSelfAction(session.id, ["session_rejected"]);
    toast.success("Session rejected");
    await loadSession();
  };

  const completeSession = async () => {
    if (!session) return;
    setBusy("complete");
    const { error } = await supabase.rpc("complete_session", { p_session_id: session.id });
    setBusy(null);
    if (error) return toast.error(error.message);
    markSelfAction(session.id, ["session_completed"]);
    void invalidateCreditBalance();
    // During pending_review this routes through the attendance rule, so the
    // outcome might be a refund (no-show) rather than a transfer. Use a
    // neutral success message and let the history page show the detail.
    toast.success(
      session.status === "pending_review"
        ? "Session settled — see history for the outcome"
        : "Session completed and credits transferred",
    );
    navigate({ to: "/history" });
  };

  const cancelSession = async () => {
    if (!session) return;
    setBusy("cancel");
    const { error } = await supabase.rpc("cancel_session", { p_session_id: session.id });
    setBusy(null);
    if (error) return toast.error(error.message);
    markSelfAction(session.id, ["session_cancelled"]);
    void invalidateCreditBalance();
    playCancelChime();
    toast(
      session.status === "accepted" || session.status === "active"
        ? "Session cancelled. Credits refunded."
        : "Request cancelled.",
    );
    await loadSession();
  };

  // "Something's wrong" during the review window. Freezes the session in
  // 'disputed' so the 24h auto-settle doesn't fire; the user should then
  // file a regular Report so admin has context.
  const disputeSession = async () => {
    if (!session) return;
    setBusy("dispute");
    const { error } = await supabase.rpc("dispute_session", { p_session_id: session.id });
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success("Session flagged for admin review. Please file a report with details.");
    await loadSession();
  };

  const saveSchedule = async () => {
    if (!session) return;
    if (!scheduleDraft) {
      toast.error("Pick a date and time first");
      return;
    }
    const scheduledAt = new Date(scheduleDraft);
    if (Number.isNaN(scheduledAt.getTime())) {
      toast.error("Invalid date and time");
      return;
    }
    // 60s buffer matches RescheduleSection — accounts for the user typing the
    // current minute exactly. The DB trigger is still authoritative.
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      toast.error("Pick a time in the future");
      return;
    }
    const iso = scheduledAt.toISOString();
    setBusy("schedule");
    const { error } = await supabase
      .from("sessions")
      .update({ scheduled_at: iso })
      .eq("id", session.id);
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success("Session scheduled");
    setScheduleDraft("");
    await loadSession();
  };

  const clearSchedule = async () => {
    if (!session) return;
    setBusy("schedule");
    const { error } = await supabase
      .from("sessions")
      .update({ scheduled_at: null })
      .eq("id", session.id);
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success("Schedule cleared");
    await loadSession();
  };

  if (authLoading || loading || !session) {
    return <PageLoading variant="detail" />;
  }

  const isTeacher = session.teacher_id === user?.id;
  const sessionInitiatorId = session.initiator_id ?? session.learner_id;
  const canRespondToPending =
    session.status === "pending" && Boolean(user?.id && user.id !== sessionInitiatorId);
  const canCancelPending =
    session.status === "pending" && Boolean(user?.id && user.id === sessionInitiatorId);
  const isAcceptedSession = session.status === "accepted" || session.status === "active";
  const isInReview = session.status === "pending_review";
  const isDisputed = session.status === "disputed";
  // Early-release flow during accepted/active: only the learner may complete
  // before the scheduled end, AND only after the session's halfway point
  // (scheduled_at + duration/2) has passed. The server
  // (private.complete_session) re-checks the same time gate AND requires
  // BOTH parties to have attended ≥ 50% of the planned duration via Jitsi —
  // those checks gate against Sybil farming where fake learners funnel
  // credits to a main account without any real teaching.
  const earlyReleaseUnlockAt =
    session.scheduled_at && session.duration_minutes
      ? Date.parse(session.scheduled_at) + (session.duration_minutes * 60_000) / 2
      : null;
  const earlyReleaseUnlocked =
    earlyReleaseUnlockAt !== null && earlyReleaseUnlockAt <= Date.now();
  const canEarlyRelease = isAcceptedSession && !isTeacher && earlyReleaseUnlocked;
  const joinAllowed = canJoinSession(session.scheduled_at, session.duration_minutes);
  const joinHint = describeJoinWindow(session.scheduled_at, session.duration_minutes);
  const handleAddToCalendar = () => {
    if (!session.scheduled_at) {
      toast.error("Pick a date and time first.");
      return;
    }
    const link = getVideoRoomUrl({
      link: session.meet_link,
      sessionId: session.id,
      skillName: session.skills?.name,
    });
    const ics = buildSessionIcsFile({
      sessionId: session.id,
      skillName: session.skills?.name ?? "Skill session",
      scheduledAt: session.scheduled_at,
      durationMinutes: session.duration_minutes,
      meetLink: link || null,
      organizerName: session.teacherName,
      attendeeName: session.learnerName,
    });
    downloadSessionIcs(`skillswap-${session.id}.ics`, ics);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6 space-y-6">
        <section className="glass rounded-3xl p-6 md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Button variant="ghost" size="sm" asChild className="-ml-2 mb-4">
                <Link to="/dashboard" preload="intent">
                  <ArrowLeft className="h-4 w-4" />
                  Dashboard
                </Link>
              </Button>
              <h1 className="text-3xl font-bold">{session.skills?.name ?? "Skill session"}</h1>
              <p className="mt-1 text-muted-foreground">
                {session.learnerName} learns from {session.teacherName}
              </p>
            </div>
            <Badge variant="outline" className="capitalize bg-white/5 border-white/10">
              {session.status}
            </Badge>
          </div>
        </section>

        <div className="grid lg:grid-cols-3 gap-4">
          <section className="lg:col-span-2 glass rounded-3xl p-6 space-y-5">
            <div className="grid sm:grid-cols-2 gap-3">
              <InfoBlock label="Learner" value={session.learnerName} />
              <InfoBlock label="Teacher" value={session.teacherName} />
              <InfoBlock label="Skill" value={session.skills?.name ?? "Skill"} />
              <InfoBlock label="Duration" value={`${session.duration_minutes} min`} />
              <InfoBlock label="Credits" value={`${session.credits} credits`} />
            </div>

            <div className="rounded-2xl border border-white/10 p-4">
              <div className="text-sm font-medium">Schedule</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {session.scheduled_at
                  ? new Date(session.scheduled_at).toLocaleString(undefined, {
                      dateStyle: "full",
                      timeStyle: "short",
                    })
                  : isTeacher
                    ? "Pick a date and time to let the learner know when to join."
                    : "The teacher hasn't scheduled this session yet."}
              </p>
              {/* Direct schedule edit only on pending sessions — once accepted,
                  changes must go through the two-sided propose_reschedule flow. */}
              {isTeacher && session.status === "pending" && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="datetime-local"
                    value={scheduleDraft}
                    onChange={(event) => setScheduleDraft(event.target.value)}
                    className="glass h-10 border-white/10"
                  />
                  <Button
                    variant="outline"
                    onClick={saveSchedule}
                    disabled={busy === "schedule" || !scheduleDraft}
                  >
                    {busy === "schedule" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {session.scheduled_at ? "Update" : "Save"}
                  </Button>
                  {session.scheduled_at && (
                    <Button variant="ghost" onClick={clearSchedule} disabled={busy === "schedule"}>
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {isAcceptedSession && user?.id && (
                <div className="mt-3">
                  <RescheduleSection
                    sessionId={session.id}
                    currentUserId={user.id}
                    onScheduleChanged={() => void loadSession()}
                  />
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 p-4">
              <div className="text-sm font-medium">Jitsi Video Room</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {session.meet_link
                  ? "Your secure video room is ready."
                  : session.status === "pending"
                    ? "Waiting for the teacher to accept before creating the video room."
                    : "The video room will be created automatically when available."}
              </p>
              {isAcceptedSession &&
                (getVideoRoomUrl({
                  link: session.meet_link,
                  sessionId: session.id,
                  skillName: session.skills?.name,
                }) ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {joinAllowed ? (
                      <Button variant="hero" asChild>
                        <Link
                          to="/video/$sessionId"
                          preload="intent"
                          params={{ sessionId: session.id }}
                        >
                          <Video className="h-4 w-4" />
                          Join Session
                        </Link>
                      </Button>
                    ) : (
                      <Button variant="hero" disabled title={joinHint ?? "Not in session window"}>
                        <Video className="h-4 w-4" />
                        {joinHint ?? "Join Session"}
                      </Button>
                    )}
                    {session.scheduled_at && (
                      <Button variant="outline" onClick={handleAddToCalendar}>
                        <Calendar className="h-4 w-4" />
                        Add to Calendar
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="hero"
                    className="mt-4"
                    onClick={() =>
                      toast.error("Video room is unavailable. Try opening the session again.")
                    }
                  >
                    <Video className="h-4 w-4" />
                    Join Session
                  </Button>
                ))}
            </div>
          </section>

          <aside className="glass rounded-3xl p-6 space-y-3">
            <h2 className="font-semibold">Actions</h2>
            {canRespondToPending && (
              <>
                <Button
                  variant="hero"
                  className="w-full"
                  onClick={acceptSession}
                  disabled={busy === "accept"}
                >
                  {busy === "accept" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  Accept
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={rejectSession}
                  disabled={Boolean(busy)}
                >
                  <X className="h-4 w-4" />
                  Reject
                </Button>
              </>
            )}
            {canCancelPending && (
              <ConfirmAction
                title="Cancel this pending session?"
                description="The other person will no longer see this pending session. You can create a new one anytime."
                confirmLabel="Cancel"
                cancelLabel="Keep it"
                destructive
                onConfirm={cancelSession}
              >
                <Button variant="outline" className="w-full" disabled={busy === "cancel"}>
                  {busy === "cancel" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  Cancel Request
                </Button>
              </ConfirmAction>
            )}
            {(isAcceptedSession || isInReview || isDisputed) && (
              <Button variant="outline" className="w-full" asChild>
                <Link to="/messages" search={{ s: session.id }}>
                  <MessageCircle className="h-4 w-4" />
                  Open Chat
                </Link>
              </Button>
            )}
            {isInReview && (
              <>
                <ConfirmAction
                  title="Confirm this session is settled?"
                  description={
                    "We'll release escrow based on who attended the call. If both showed up, the teacher receives the credits. " +
                    "If someone didn't show, you'll be refunded automatically."
                  }
                  confirmLabel="All good — settle now"
                  onConfirm={completeSession}
                >
                  <Button variant="hero" className="w-full" disabled={busy === "complete"}>
                    {busy === "complete" && <Loader2 className="h-4 w-4 animate-spin" />}
                    <Check className="h-4 w-4" />
                    All Good
                  </Button>
                </ConfirmAction>
                <ConfirmAction
                  title="Flag this session for review?"
                  description={
                    "Escrow stays frozen until a moderator reviews the case. Please also file a report so admins have context."
                  }
                  confirmLabel="Flag for review"
                  cancelLabel="Never mind"
                  destructive
                  onConfirm={disputeSession}
                >
                  <Button variant="outline" className="w-full" disabled={busy === "dispute"}>
                    {busy === "dispute" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                    Something's Wrong
                  </Button>
                </ConfirmAction>
                <p className="text-xs text-muted-foreground">
                  We&apos;ll auto-settle this session in 24h if no one acts. Outcome is based on
                  attendance.
                </p>
              </>
            )}
            {isDisputed && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                This session is frozen pending admin review. Credits stay in escrow until resolved.
              </div>
            )}
            {isAcceptedSession && !isTeacher && !earlyReleaseUnlocked && earlyReleaseUnlockAt && (
              <p className="text-xs text-muted-foreground">
                Early release becomes available at{" "}
                {new Date(earlyReleaseUnlockAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                (halfway through the planned {session.duration_minutes} min), and only if both of
                you have spent at least that much time in the video room. Otherwise credits release
                automatically after the scheduled end.
              </p>
            )}
            {canEarlyRelease && (
              <ConfirmAction
                title="Release credits to your teacher now?"
                description={`This sends ${session.credits} credits to ${session.teacherName} immediately. Both of you must have attended at least half the planned ${session.duration_minutes} minutes in the video room — otherwise the release will be blocked and credits will release automatically once the session wraps up.`}
                confirmLabel="Release now"
                onConfirm={completeSession}
              >
                <Button variant="hero" className="w-full" disabled={busy === "complete"}>
                  {busy === "complete" && <Loader2 className="h-4 w-4 animate-spin" />}
                  Release Credits Early
                </Button>
              </ConfirmAction>
            )}
            {isAcceptedSession && (
              <ConfirmAction
                title="Cancel this session?"
                description={`Cancelling will refund the ${session.credits} credits held in escrow back to the learner. You can re-request later if plans change.`}
                confirmLabel="Cancel session"
                cancelLabel="Keep it"
                destructive
                onConfirm={cancelSession}
              >
                <Button variant="outline" className="w-full" disabled={busy === "cancel"}>
                  {busy === "cancel" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  Cancel Session
                </Button>
              </ConfirmAction>
            )}
            {user?.id && (
              <ReportDialog
                reportedUserId={isTeacher ? session.learner_id : session.teacher_id}
                sessionId={session.id}
                label="Report"
              />
            )}
            <p className="text-xs text-muted-foreground">
              Chat is tied to this session. Credits transfer only when the session is completed.
            </p>
          </aside>
        </div>
      </main>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}
