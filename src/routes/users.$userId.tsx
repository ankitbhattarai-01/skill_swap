import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { ReportDialog } from "@/components/ReportDialog";
import { TrackProposalDialog } from "@/components/TrackProposalDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { useAuth } from "@/lib/auth-context";
import { findAcceptedSession } from "@/lib/sessions";
import { supabase } from "@/integrations/supabase/client";
import {
  ArrowLeft,
  BookOpen,
  GraduationCap,
  Loader2,
  MessageCircle,
  Star,
  Sparkles,
  MessageSquareQuote,
  GitBranch,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [teaching, setTeaching] = useState<TeachingSkill[]>([]);
  const [trackDialog, setTrackDialog] = useState<{ skillId: string; skillName: string } | null>(
    null,
  );
  const [learning, setLearning] = useState<LearningSkill[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingChat, setOpeningChat] = useState(false);

  useEffect(() => {
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
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [userId]);

  if (loading) {
    return <PageLoading variant="profile" />;
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6">
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

    const firstSkill = teaching.find((skill) => skill.skills?.id);
    if (!firstSkill?.skills?.id) {
      toast.error("This student has not listed a teaching skill yet.");
      return;
    }

    setOpeningChat(true);
    const { data, error } = await findAcceptedSession(user.id, userId, firstSkill.skills.id);
    setOpeningChat(false);

    if (error) return toast.error(error.message);
    if (!data?.id) {
      toast.error("You can message after your session request is accepted.");
      return;
    }
    navigate({ to: "/messages", search: { s: data.id } });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 md:py-8 space-y-6">
        {/* Hero — gradient glass shell matching Explore */}
        <section className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none" />
          <div className="relative p-6 md:p-8">
            <Button variant="ghost" size="sm" asChild className="-ml-2 mb-5 text-muted-foreground hover:text-foreground">
              <Link to="/explore" preload="intent">
                <ArrowLeft className="h-4 w-4" />
                Back to Explore
              </Link>
            </Button>
            <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center min-w-0">
                <UserAvatar
                  name={profile.full_name}
                  url={profile.avatar_url}
                  className="h-24 w-24 rounded-3xl ring-4 ring-white/10 shadow-glow"
                  fallbackClassName="text-3xl rounded-3xl"
                />
                <div className="min-w-0 flex-1">
                  <h1 className="text-3xl md:text-4xl font-bold leading-tight">
                    {profile.full_name ?? "Student"}
                  </h1>
                  {profile.bio && (
                    <p className="mt-2 max-w-2xl text-muted-foreground">{profile.bio}</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
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
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row md:flex-col lg:flex-row md:items-end">
                  <Button variant="hero" size="lg" onClick={openChat} disabled={openingChat}>
                    {openingChat ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MessageCircle className="h-4 w-4" />
                    )}
                    Message
                  </Button>
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
                    <div className="font-semibold leading-tight">
                      {skill.skills?.name ?? "Skill"}
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
                      onClick={() =>
                        setTrackDialog({
                          skillId: skill.skills!.id,
                          skillName: skill.skills!.name,
                        })
                      }
                      className="group/track inline-flex w-full items-center justify-between gap-2 rounded-xl border border-brand-cyan/25 bg-brand-cyan/[0.06] px-3 py-2 text-xs font-medium text-brand-cyan transition-all hover:border-brand-cyan/50 hover:bg-brand-cyan/[0.12] hover:shadow-glow-blue"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <GitBranch className="h-3.5 w-3.5" />
                        Propose a learning track
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

        <section className="glass rounded-3xl border border-white/10 p-6 md:p-7">
          <div className="mb-5 flex items-center gap-3">
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
      {trackDialog && (
        <TrackProposalDialog
          open={trackDialog !== null}
          onOpenChange={(open) => !open && setTrackDialog(null)}
          teacherId={userId}
          teacherName={profile?.full_name ?? "Teacher"}
          skillId={trackDialog.skillId}
          skillName={trackDialog.skillName}
        />
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
    <section className="glass rounded-3xl border border-white/10 p-6 md:p-7">
      <div className="mb-5 flex items-center gap-3">
        <div
          className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${tonedBg}`}
        >
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
