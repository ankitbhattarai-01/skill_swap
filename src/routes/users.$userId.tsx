import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReportDialog } from "@/components/ReportDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { useAuth } from "@/lib/auth-context";
import { isUuid } from "@/lib/uuid";
import { getOrCreateSession, requestSessionsForSlots, type SessionDuration } from "@/lib/sessions";
import { getOrCreateConversation } from "@/lib/conversations";
import { playRequestSentChime } from "@/lib/sounds";
import { warmBookingDialogs } from "@/lib/warm-dialog-chunks";
import { supabase } from "@/integrations/supabase/client";
import { loadSkillVerifications, type SkillVerification } from "@/lib/skill-verification";
import {
  ArrowLeft,
  ArrowLeftRight,
  BookOpen,
  CalendarPlus,
  GraduationCap,
  Loader2,
  MessageCircle,
  Star,
  Sparkles,
  MessageSquareQuote,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { VerifiedTick } from "@/components/VerifiedTick";

// Lazy: the dialog pulls in react-day-picker via the Calendar UI. Keeping it
// out of the route chunk strips ~40-60kb from first paint - it isn't open on
// initial render. It handles both single and multi-session requests.
const SessionRequestDialog = lazy(() =>
  import("@/components/SessionRequestDialog").then((m) => ({ default: m.SessionRequestDialog })),
);
const SwapProposalDialog = lazy(() =>
  import("@/components/SwapProposalDialog").then((m) => ({ default: m.SwapProposalDialog })),
);
import type { MultiSessionParams } from "@/components/SessionRequestDialog";

export const Route = createFileRoute("/users/$userId")({
  head: () => ({ meta: [{ title: "Profile - SkillSwap" }] }),
  component: PublicUserPage,
});

type Profile = {
  id: string;
  full_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

type TeachingSkill = {
  id: string;
  level: string;
  credits_per_hour: number;
  skills: { id: string; name: string; category: string | null } | null;
};

type LearningSkill = {
  id: string;
  current_level: string;
  skills: { id: string; name: string; category: string | null } | null;
};

type Review = {
  id: string;
  rating: number;
  comment: string | null;
  reviewerName: string;
  reviewerId: string;
};

function PublicUserPage() {
  const { userId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  // This page exists to be booked from - warm the request/swap dialogs as soon
  // as it settles so the first click opens instantly.
  useEffect(() => {
    warmBookingDialogs();
  }, []);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [teaching, setTeaching] = useState<TeachingSkill[]>([]);
  // The skill the request dialog is currently targeting. Carries the rate so
  // the dialog can price either a single session or a multi-session request.
  const [requestSkill, setRequestSkill] = useState<{
    id: string;
    name: string;
    creditsPerHour: number;
  } | null>(null);
  const [learning, setLearning] = useState<LearningSkill[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [verifications, setVerifications] = useState<Map<string, SkillVerification>>(new Map());
  const [loading, setLoading] = useState(true);
  const [openingChat, setOpeningChat] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [myCredits, setMyCredits] = useState<number | null>(null);

  useEffect(() => {
    // Guard against `/users/<garbage>` URLs reaching PostgREST. Without
    // this every non-UUID param produces "invalid input syntax for type
    // uuid", which the catch below renders as a noisy "Could not load
    // profile" toast. Bounce to dashboard with a friendlier message and
    // skip the round-trip entirely.
    if (!isUuid(userId)) {
      toast.error("That user link looks malformed.");
      navigate({ to: "/dashboard" });
      return;
    }
    let alive = true;
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      try {
        const [
          { data: profileData },
          { data: teachingData },
          { data: learningData },
          { data: reviewData },
          skillVerifications,
        ] = await Promise.all([
          supabase
            .from("profiles")
            .select("id, full_name, bio, avatar_url")
            .eq("id", userId)
            .abortSignal(controller.signal)
            .maybeSingle(),
          supabase
            .from("user_teaching_skills")
            .select("id, level, credits_per_hour, skills:skill_id(id, name, category)")
            .eq("user_id", userId)
            .abortSignal(controller.signal),
          supabase
            .from("user_learning_skills")
            .select("id, current_level, skills:skill_id(id, name, category)")
            .eq("user_id", userId)
            .abortSignal(controller.signal),
          supabase
            .from("reviews")
            .select("id, rating, comment, reviewer_id")
            .eq("reviewee_id", userId)
            .order("created_at", { ascending: false })
            .limit(6)
            .abortSignal(controller.signal),
          loadSkillVerifications(userId),
        ]);
        if (!alive) return;

        const rawReviews = (reviewData ?? []) as {
          id: string;
          rating: number;
          comment: string | null;
          reviewer_id: string;
        }[];
        const reviewerIds = Array.from(new Set(rawReviews.map((review) => review.reviewer_id)));
        const nameMap = new Map<string, string>();
        if (reviewerIds.length) {
          const { data: people } = await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", reviewerIds)
            .abortSignal(controller.signal);
          for (const person of people ?? []) {
            nameMap.set(person.id, person.full_name ?? "Student");
          }
        }

        setProfile(profileData ? ({ ...profileData, avatar_url: null } as Profile) : null);
        setTeaching((teachingData ?? []) as unknown as TeachingSkill[]);
        setVerifications(skillVerifications);
        setLearning((learningData ?? []) as unknown as LearningSkill[]);
        setReviews(
          rawReviews.map((review) => ({
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            reviewerName: nameMap.get(review.reviewer_id) ?? "Student",
            reviewerId: review.reviewer_id,
          })),
        );
        setLoading(false);

        if (!profileData?.avatar_url) return;
        const signedAvatarUrl = await signSingleAvatarUrl(profileData.avatar_url);
        if (alive && signedAvatarUrl) {
          setProfile((current) =>
            current ? { ...current, avatar_url: signedAvatarUrl } : current,
          );
        }
      } catch (error) {
        if (!alive) return;
        if (error instanceof Error && error.name === "AbortError") return;
        toast.error(error instanceof Error ? error.message : "Could not load profile");
        setProfile(null);
        setTeaching([]);
        setLearning([]);
        setReviews([]);
        setVerifications(new Map());
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
    // navigate is stable from TanStack Router; userId is the real input.
  }, [userId, navigate]);

  useEffect(() => {
    if (!user) {
      setMyCredits(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const { data } = await supabase.rpc("my_credit_balance").abortSignal(controller.signal);
      if (alive) setMyCredits(typeof data === "number" ? data : null);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
    // user?.id only - auth events rotate the user object reference even when
    // the underlying user hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (loading) {
    return <PageLoading variant="profile" />;
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-6xl px-4 py-[18px] sm:px-[18px] md:py-6">
          <div className="glass rounded-3xl p-10 text-center">
            <h1 className="text-2xl font-bold">Profile not found</h1>
            <Button variant="hero" className="mt-6" asChild>
              <Link to="/explore" preload="intent">
                Explore Skills
              </Link>
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const averageRating = reviews.length
    ? reviews.reduce((total, review) => total + review.rating, 0) / reviews.length
    : null;

  const openChat = async () => {
    if (!user) {
      navigate({ to: "/login", search: { redirect: `/users/${userId}` } });
      return;
    }

    // Chat is decoupled from sessions: open (or lazily create) the
    // conversation with this user. No session request is created - that
    // stays an explicit action via the "Request session" button.
    setOpeningChat(true);
    const { error } = await getOrCreateConversation(userId);
    setOpeningChat(false);

    if (error) return toast.error(error.message);
    navigate({ to: "/messages", search: { u: userId } });
  };

  const primaryTeachingSkill = teaching.find((skill) => skill.skills?.id) ?? null;

  // Every skill this teacher can actually teach, flattened for the "Which
  // skill?" chooser that precedes booking when they offer more than one.
  const teachingOptions = teaching
    .filter((skill) => skill.skills?.id)
    .map((skill) => ({
      id: skill.skills!.id,
      name: skill.skills!.name,
      creditsPerHour: skill.credits_per_hour,
    }));

  // Opens booking for a teaching skill. The hero "Request session" button calls
  // this with no skill: when the teacher offers several we first pop a small
  // "Which skill?" chooser so the request isn't silently pinned to their
  // first-listed skill; with a single skill we go straight to booking. Each
  // skill card passes its own skill and skips the chooser.
  const openRequest = (skill?: TeachingSkill) => {
    if (!user) {
      navigate({ to: "/login", search: { redirect: `/users/${userId}` } });
      return;
    }
    if (!skill && teachingOptions.length > 1) {
      setSkillPickerOpen(true);
      return;
    }
    const target = skill ?? primaryTeachingSkill;
    if (!target?.skills?.id) {
      toast.error("This student has not listed a teaching skill yet.");
      return;
    }
    setRequestSkill({
      id: target.skills.id,
      name: target.skills.name,
      creditsPerHour: target.credits_per_hour,
    });
    setRequestOpen(true);
  };

  // Chosen from the "Which skill?" step → close it and open booking for that one.
  const bookSkill = (option: (typeof teachingOptions)[number]) => {
    setSkillPickerOpen(false);
    setRequestSkill(option);
    setRequestOpen(true);
  };

  const confirmRequest = async (duration: SessionDuration, scheduledAt: string): Promise<void> => {
    if (!user || !requestSkill) return;
    setRequesting(true);
    try {
      const { sessionId, error } = await getOrCreateSession({
        learnerId: user.id,
        teacherId: userId,
        initiatorId: user.id,
        skillId: requestSkill.id,
        creditsPerHour: requestSkill.creditsPerHour,
        durationMinutes: duration,
        scheduledAt,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (sessionId) {
        playRequestSentChime();
        toast.success("Session requested. You can message after it is accepted.");
        setRequestOpen(false);
      }
    } finally {
      setRequesting(false);
    }
  };

  // Multi-session path: book one ordinary pending session per chosen slot. Each
  // shows up for the teacher to accept individually, exactly like a single
  // request - credits are only escrowed as each session is accepted.
  const requestMultiple = async (params: MultiSessionParams): Promise<void> => {
    if (!user || !requestSkill) return;
    setRequesting(true);
    try {
      const { created, error } = await requestSessionsForSlots({
        learnerId: user.id,
        teacherId: userId,
        skillId: requestSkill.id,
        creditsPerHour: requestSkill.creditsPerHour,
        durationMinutes: params.durationMinutes,
        startTimes: params.startTimes,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (created > 0) {
        playRequestSentChime();
        toast.success(
          `Requested ${created} ${created === 1 ? "session" : "sessions"}. ${profile?.full_name ?? "The teacher"} accepts each one.`,
        );
        setRequestOpen(false);
      }
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 md:py-8 space-y-4 md:space-y-6">
        {/* Hero - calm glass shell with a single soft brand wash */}
        <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          {/* Dark-only wash - see .hero-wash in styles.css */}
          <div className="hero-wash" />
          <div className="relative p-5 md:p-8">
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="-ml-2 mb-3 md:mb-5 text-muted-foreground hover:text-foreground"
            >
              <Link to="/explore" preload="intent">
                <ArrowLeft className="h-4 w-4" />
                Back to Explore
              </Link>
            </Button>
            <div className="flex flex-col gap-4 md:gap-6 md:flex-row md:items-start md:justify-between">
              <div className="flex flex-row items-center gap-4 sm:gap-5 sm:items-center min-w-0">
                <UserAvatar
                  name={profile.full_name}
                  url={profile.avatar_url}
                  className="h-16 w-16 sm:h-24 sm:w-24 rounded-2xl ring-1 ring-black/5 dark:ring-white/10 shrink-0"
                  fallbackClassName="text-2xl sm:text-3xl rounded-3xl"
                />
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold leading-tight">
                    {profile.full_name ?? "Student"}
                  </h1>
                  {profile.bio && (
                    <p className="mt-1.5 sm:mt-2 max-w-2xl text-sm sm:text-base text-muted-foreground">
                      {profile.bio}
                    </p>
                  )}
                  <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-2 sm:gap-3 text-xs text-muted-foreground">
                    {averageRating !== null ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2.5 py-1 text-amber-400">
                        <Star className="h-3.5 w-3.5 fill-amber-400" />
                        <span className="font-semibold">{averageRating.toFixed(1)}</span>
                        <span className="text-muted-foreground">
                          · {reviews.length} {reviews.length === 1 ? "review" : "reviews"}
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                        <Sparkles className="h-3 w-3" />
                        New on SkillSwap
                      </span>
                    )}
                    {teaching.length > 0 && (
                      <span>
                        <span className="font-semibold text-foreground">{teaching.length}</span>{" "}
                        {teaching.length === 1 ? "skill" : "skills"} taught
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {user?.id !== userId && (
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row md:flex-col lg:flex-row md:items-center">
                  {primaryTeachingSkill && (
                    <Button
                      variant="hero"
                      size="lg"
                      onClick={() => openRequest()}
                      disabled={requesting}
                    >
                      {requesting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CalendarPlus className="h-4 w-4" />
                      )}
                      Request session
                    </Button>
                  )}
                  <Button variant="outline" size="lg" onClick={openChat} disabled={openingChat}>
                    {openingChat ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MessageCircle className="h-4 w-4" />
                    )}
                    Message
                  </Button>
                  {teaching.length > 0 && (
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => {
                        if (!user) {
                          navigate({ to: "/login", search: { redirect: `/users/${userId}` } });
                          return;
                        }
                        setSwapOpen(true);
                      }}
                    >
                      <ArrowLeftRight className="h-4 w-4" />
                      Propose swap
                    </Button>
                  )}
                  <ReportDialog reportedUserId={userId} label="Report" />
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <SkillSection
            title="Teaches"
            icon={<BookOpen className="h-4 w-4 text-brand-cyan" />}
            tone="cyan"
            count={teaching.length}
          >
            {teaching.length === 0 && <EmptyState text="No teaching skills listed." />}
            {teaching.map((skill) => (
              <div
                key={skill.id}
                className="group rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-brand-cyan/30 hover:bg-white/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-semibold leading-tight">
                      <span className="truncate">{skill.skills?.name ?? "Skill"}</span>
                      {skill.skills?.id && verifications.has(skill.skills.id) && <VerifiedTick />}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground capitalize">
                      {skill.level}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-foreground/80">
                    {skill.credits_per_hour}{" "}
                    <span className="font-normal text-muted-foreground">cr / hr</span>
                  </span>
                </div>
                {user && user.id !== userId && skill.skills?.id && (
                  <div className="mt-3 border-t border-white/5 pt-3">
                    <button
                      type="button"
                      onClick={() => openRequest(skill)}
                      className="group/track inline-flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-foreground/70 transition-colors hover:border-brand-cyan/40 hover:bg-brand-cyan/[0.06] hover:text-brand-cyan"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarPlus className="h-3.5 w-3.5" />
                        Request a session
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover/track:translate-x-0.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </SkillSection>
          <SkillSection
            title="Learning"
            icon={<GraduationCap className="h-4 w-4 text-brand-purple" />}
            tone="purple"
            count={learning.length}
          >
            {learning.length === 0 && <EmptyState text="No learning skills listed." />}
            {learning.map((skill) => (
              <div
                key={skill.id}
                className="rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-brand-purple/30 hover:bg-white/10"
              >
                <div className="font-semibold leading-tight">{skill.skills?.name ?? "Skill"}</div>
                <div className="mt-1 text-xs text-muted-foreground capitalize">
                  {skill.current_level}
                </div>
              </div>
            ))}
          </SkillSection>
        </div>

        <section className="glass rounded-3xl border border-white/10 p-5 md:p-7">
          <div className="mb-4 md:mb-5 flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400/15">
              <MessageSquareQuote className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold leading-tight">Reviews</h2>
              <p className="text-xs text-muted-foreground">
                {reviews.length === 0
                  ? "Be the first to leave feedback after a session."
                  : `${reviews.length} ${reviews.length === 1 ? "review" : "reviews"} from past sessions`}
              </p>
            </div>
          </div>
          {reviews.length === 0 ? (
            <EmptyState text="No reviews yet." />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {reviews.map((review) => (
                <div
                  key={review.id}
                  className="group rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-amber-400/30 hover:bg-white/10"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium truncate">{review.reviewerName}</div>
                    <div className="flex shrink-0 text-amber-400">
                      {Array.from({ length: 5 }).map((_, index) => (
                        <Star
                          key={index}
                          className={`h-3.5 w-3.5 ${index < review.rating ? "fill-amber-400" : "opacity-25"}`}
                        />
                      ))}
                    </div>
                  </div>
                  {review.comment && (
                    <p className="mt-2 text-sm text-muted-foreground line-clamp-4">
                      {review.comment}
                    </p>
                  )}
                  {user && user.id !== review.reviewerId && (
                    <div className="mt-3 flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                      <ReportDialog reviewId={review.id} label="Report" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      {/* Which skill? - a light first step when a teacher offers several, so
          the hero "Request session" button doesn't guess for the learner. */}
      <Dialog open={skillPickerOpen} onOpenChange={setSkillPickerOpen}>
        {/* Same header shape as SessionRequestDialog - this is the step right
            before it, so the two must read as one flow. */}
        <DialogContent className="max-w-[380px] gap-3.5 p-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
                <GraduationCap className="h-4 w-4 text-brand-purple" />
              </div>
              <DialogTitle className="text-base leading-tight">Which skill?</DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-snug">
              {profile.full_name ?? "This student"} teaches a few things. Pick the one you'd like a
              session for.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {teachingOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => bookSkill(option)}
                className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-muted px-4 py-3 text-left transition-colors hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{option.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.creditsPerHour} cr / hr
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand-purple" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {requestOpen && requestSkill && (
        <Suspense fallback={null}>
          <SessionRequestDialog
            open={requestOpen}
            onOpenChange={setRequestOpen}
            title="Request a session"
            skillName={requestSkill.name}
            creditsPerHour={requestSkill.creditsPerHour}
            availableCredits={myCredits}
            busy={requesting}
            learnerId={user?.id}
            teacherId={userId}
            onConfirm={confirmRequest}
            allowMultiSession
            teacherName={profile?.full_name ?? "Teacher"}
            onConfirmMulti={requestMultiple}
          />
        </Suspense>
      )}
      {swapOpen && (
        <Suspense fallback={null}>
          <SwapProposalDialog
            open={swapOpen}
            onOpenChange={setSwapOpen}
            otherUserId={userId}
            otherName={profile?.full_name ?? undefined}
          />
        </Suspense>
      )}
    </div>
  );
}

function SkillSection({
  title,
  icon,
  tone,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  tone: "cyan" | "purple";
  count?: number;
  children: ReactNode;
}) {
  const tonedBg = tone === "cyan" ? "bg-brand-cyan/15" : "bg-brand-purple/15";
  return (
    <section className="glass rounded-3xl border border-white/10 p-5 md:p-7">
      <div className="mb-4 md:mb-5 flex items-center gap-3">
        <div className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${tonedBg}`}>
          {icon}
        </div>
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
          {typeof count === "number" && count > 0 && (
            <span className="text-xs text-muted-foreground">{count}</span>
          )}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
