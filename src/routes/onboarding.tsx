import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Logo } from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatLearningMode, type LearningMode } from "@/lib/match";
import { AvailabilityEditor } from "@/components/AvailabilityEditor";
import { hasAuthRedirectParams } from "@/lib/auth-redirect";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Onboarding | SkillSwap" }] }),
  component: OnboardingPage,
});

type SkillLevel = "basic" | "intermediate" | "advanced";
type Skill = { id: string; name: string; category: string | null };
type LevelEntry = {
  skill: Skill;
  level: SkillLevel;
  focus: string;
  mode: LearningMode;
};

const SKILL_CATEGORIES = [
  "Programming",
  "Frontend",
  "Backend",
  "Database",
  "AI",
  "Data",
  "Game Development",
  "Video Games",
  "Mobile Apps",
  "Cybersecurity",
  "Cloud",
  "DevOps",
  "Design",
  "UI/UX",
  "Creative",
  "Video Editing",
  "Photography",
  "Music",
  "Writing",
  "Marketing",
  "Business",
  "Finance",
  "Language",
  "Math",
  "Science",
  "Soft Skills",
  "Career",
  "Fitness",
  "Cooking",
  "Other",
];

const LEARNING_METHODS: LearningMode[] = [
  "teaching",
  "mentorship",
  "collaboration",
  "project_based",
];

const LEVEL_COLORS: Record<SkillLevel, string> = {
  basic: "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20",
  intermediate: "bg-brand-blue/15 text-brand-blue border-brand-blue/25",
  advanced: "bg-brand-purple/15 text-brand-purple border-brand-purple/25",
};

const SKILL_METHOD_STORE_PREFIX = "skillswap-skill-methods";
const SKILL_FOCUS_STORE_PREFIX = "skillswap-skill-focus";

function persistSkillMethod(
  userId: string,
  kind: "teaching" | "learning",
  id: string,
  mode: LearningMode,
) {
  try {
    const key = `${SKILL_METHOD_STORE_PREFIX}-${userId}`;
    const raw = localStorage.getItem(key);
    const parsed = raw
      ? (JSON.parse(raw) as {
          teaching?: Record<string, LearningMode>;
          learning?: Record<string, LearningMode>;
        })
      : { teaching: {}, learning: {} };
    parsed[kind] = { ...(parsed[kind] ?? {}), [id]: mode };
    localStorage.setItem(key, JSON.stringify(parsed));
  } catch {
    // Local persistence is best-effort.
  }
}

function persistSkillFocus(
  userId: string,
  kind: "teaching" | "learning",
  id: string,
  focus: string,
) {
  try {
    const key = `${SKILL_FOCUS_STORE_PREFIX}-${userId}`;
    const raw = localStorage.getItem(key);
    const parsed = raw
      ? (JSON.parse(raw) as {
          teaching?: Record<string, string>;
          learning?: Record<string, string>;
        })
      : { teaching: {}, learning: {} };
    const trimmed = focus.trim();
    const next = { ...(parsed[kind] ?? {}) };
    if (trimmed) next[id] = trimmed;
    else delete next[id];
    parsed[kind] = next;
    localStorage.setItem(key, JSON.stringify(parsed));
  } catch {
    // Local persistence is best-effort.
  }
}

function OnboardingPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [fullName, setFullName] = useState("");
  const [bio, setBio] = useState("");
  const [teaching, setTeaching] = useState<LevelEntry[]>([]);
  const [learning, setLearning] = useState<LevelEntry[]>([]);
  const [mode, setMode] = useState<LearningMode>("collaboration");
  const [saving, setSaving] = useState(false);
  const [teachInput, setTeachInput] = useState("");
  const [learnInput, setLearnInput] = useState("");
  const [teachFocus, setTeachFocus] = useState("");
  const [learnFocus, setLearnFocus] = useState("");
  const [teachLevel, setTeachLevel] = useState<SkillLevel | "">("");
  const [learnLevel, setLearnLevel] = useState<SkillLevel | "">("");
  const [teachCategory, setTeachCategory] = useState("");
  const [learnCategory, setLearnCategory] = useState("");
  const [teachMode, setTeachMode] = useState<LearningMode | "">("");
  const [learnMode, setLearnMode] = useState<LearningMode | "">("");
  const [hydrated, setHydrated] = useState(false);
  const [emailRedirectPending, setEmailRedirectPending] = useState(() => hasAuthRedirectParams());

  useEffect(() => {
    if (!authLoading) setEmailRedirectPending(false);
  }, [authLoading]);

  useEffect(() => {
    if (!authLoading && !user && !emailRedirectPending) {
      navigate({ to: "/login", search: { redirect: "/onboarding" } });
    }
  }, [user?.id, authLoading, emailRedirectPending, navigate]);

  useEffect(() => {
    if (authLoading || hydrated) return;
    (async () => {
      const { data } = await supabase.from("skills").select("id, name, category").order("name");
      if (data) setAllSkills(data);
      if (user) {
        const [{ data: p }, { data: teachingData }, { data: learningData }] = await Promise.all([
          supabase
            .from("profiles")
            .select("full_name, bio, learning_mode, onboarded")
            .eq("id", user.id)
            .maybeSingle(),
          supabase
            .from("user_teaching_skills")
            .select("level, skills:skill_id(id, name, category)")
            .eq("user_id", user.id),
          supabase
            .from("user_learning_skills")
            .select("current_level, skills:skill_id(id, name, category)")
            .eq("user_id", user.id),
        ]);

        if (p?.onboarded) {
          navigate({ to: "/dashboard" });
          return;
        }

        const savedTeaching: LevelEntry[] = (
          (teachingData ?? []) as unknown as {
            level: SkillLevel;
            skills: Skill | null;
          }[]
        )
          .filter((row) => row.skills)
          .map((row) => ({
            skill: row.skills as Skill,
            level: row.level,
            focus: "",
            mode: "teaching" as LearningMode,
          }));

        const savedLearning: LevelEntry[] = (
          (learningData ?? []) as unknown as {
            current_level: SkillLevel;
            skills: Skill | null;
          }[]
        )
          .filter((row) => row.skills)
          .map((row) => ({
            skill: row.skills as Skill,
            level: row.current_level,
            focus: "",
            mode: "mentorship" as LearningMode,
          }));

        if ((savedTeaching.length > 0 || savedLearning.length > 0) && p?.full_name) {
          // complete_onboarding() re-checks both preconditions server-side
          // so a tampered client can't shortcut the flag.
          const { error: onboardedFlipError } = await supabase.rpc("complete_onboarding");
          if (onboardedFlipError) {
            console.error("[onboarding] failed to flip onboarded flag", onboardedFlipError);
            // Fall through to the normal onboarding form so the user can re-save
            // explicitly instead of being trapped in a dashboard ↔ onboarding loop.
          } else {
            navigate({ to: "/dashboard" });
            return;
          }
        }

        if (p) {
          setFullName(p.full_name ?? "");
          setBio(p.bio ?? "");
          setMode(p.learning_mode ?? "collaboration");
        }

        setTeaching(savedTeaching);
        setLearning(savedLearning);
      }
      setHydrated(true);
    })();
  }, [user?.id, authLoading, navigate, hydrated]);

  const findOrCreateSkill = async (name: string, category: string): Promise<Skill | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = allSkills.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    const { data, error } = await supabase
      .from("skills")
      .insert({ name: trimmed, category })
      .select("id, name, category")
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Could not add skill");
      return null;
    }
    setAllSkills((prev) => [...prev, data]);
    return data;
  };

  const addTeach = async () => {
    const skill = await findOrCreateSkill(teachInput, teachCategory || "Other");
    if (!skill) return;
    if (teaching.find((t) => t.skill.id === skill.id)) return;
    setTeaching([
      ...teaching,
      {
        skill,
        level: (teachLevel || "intermediate") as SkillLevel,
        focus: teachFocus.trim(),
        mode: (teachMode || "teaching") as LearningMode,
      },
    ]);
    setTeachInput("");
    setTeachFocus("");
    setTeachLevel("");
    setTeachCategory("");
    setTeachMode("");
  };

  const addLearn = async () => {
    const skill = await findOrCreateSkill(learnInput, learnCategory || "Other");
    if (!skill) return;
    if (learning.find((t) => t.skill.id === skill.id)) return;
    setLearning([
      ...learning,
      {
        skill,
        level: (learnLevel || "basic") as SkillLevel,
        focus: learnFocus.trim(),
        mode: (learnMode || "mentorship") as LearningMode,
      },
    ]);
    setLearnInput("");
    setLearnFocus("");
    setLearnLevel("");
    setLearnCategory("");
    setLearnMode("");
  };

  const finish = async () => {
    if (!user) return;
    setSaving(true);
    const { error: pErr } = await supabase
      .from("profiles")
      .update({
        full_name: fullName,
        bio,
        learning_mode: mode,
      })
      .eq("id", user.id);

    if (pErr) {
      toast.error(pErr.message);
      setSaving(false);
      return;
    }

    if (teaching.length) {
      let methodSavedInDatabase = true;
      let teachingError: { message: string } | null = null;
      const withMethod = await supabase
        .from("user_teaching_skills")
        .upsert(
          teaching.map((t) => ({
            user_id: user.id,
            skill_id: t.skill.id,
            level: t.level,
            teaching_mode: t.mode,
          })),
          { onConflict: "user_id,skill_id" },
        )
        .select("id, skill_id");
      if (withMethod.error?.message.includes("teaching_mode")) {
        methodSavedInDatabase = false;
        const fallback = await supabase
          .from("user_teaching_skills")
          .upsert(
            teaching.map((t) => ({
              user_id: user.id,
              skill_id: t.skill.id,
              level: t.level,
            })),
            { onConflict: "user_id,skill_id" },
          )
          .select("id, skill_id");
        teachingError = fallback.error;
        for (const row of fallback.data ?? []) {
          const entry = teaching.find((t) => t.skill.id === row.skill_id);
          if (entry) {
            persistSkillMethod(user.id, "teaching", row.id, entry.mode);
            persistSkillFocus(user.id, "teaching", row.id, entry.focus);
          }
        }
      } else {
        teachingError = withMethod.error;
        for (const row of withMethod.data ?? []) {
          const entry = teaching.find((t) => t.skill.id === row.skill_id);
          if (entry) {
            persistSkillFocus(user.id, "teaching", row.id, entry.focus);
            if (!methodSavedInDatabase) {
              persistSkillMethod(user.id, "teaching", row.id, entry.mode);
            }
          }
        }
      }
      if (teachingError) {
        toast.error(teachingError.message);
        setSaving(false);
        return;
      }
    }
    if (learning.length) {
      let methodSavedInDatabase = true;
      let learningError: { message: string } | null = null;
      const withMethod = await supabase
        .from("user_learning_skills")
        .upsert(
          learning.map((t) => ({
            user_id: user.id,
            skill_id: t.skill.id,
            current_level: t.level,
            learning_mode: t.mode,
          })),
          { onConflict: "user_id,skill_id" },
        )
        .select("id, skill_id");
      if (withMethod.error?.message.includes("learning_mode")) {
        methodSavedInDatabase = false;
        const fallback = await supabase
          .from("user_learning_skills")
          .upsert(
            learning.map((t) => ({
              user_id: user.id,
              skill_id: t.skill.id,
              current_level: t.level,
            })),
            { onConflict: "user_id,skill_id" },
          )
          .select("id, skill_id");
        learningError = fallback.error;
        for (const row of fallback.data ?? []) {
          const entry = learning.find((t) => t.skill.id === row.skill_id);
          if (entry) {
            persistSkillMethod(user.id, "learning", row.id, entry.mode);
            persistSkillFocus(user.id, "learning", row.id, entry.focus);
          }
        }
      } else {
        learningError = withMethod.error;
        for (const row of withMethod.data ?? []) {
          const entry = learning.find((t) => t.skill.id === row.skill_id);
          if (entry) {
            persistSkillFocus(user.id, "learning", row.id, entry.focus);
            if (!methodSavedInDatabase) {
              persistSkillMethod(user.id, "learning", row.id, entry.mode);
            }
          }
        }
      }
      if (learningError) {
        toast.error(learningError.message);
        setSaving(false);
        return;
      }
    }

    // complete_onboarding() flips the flag only if full_name + at least
    // one teaching/learning skill exist server-side. The column itself is
    // no longer writable from the authenticated role.
    const { error: onboardError } = await supabase.rpc("complete_onboarding");
    if (onboardError) {
      toast.error(onboardError.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    toast.success("Welcome to SkillSwap 🎉");
    navigate({ to: "/dashboard" });
  };

  const steps = ["About you", "Skills", "Mode", "Availability"];
  const isWideStep = step === 1 || step === 3;

  const isVerifyingEmail = emailRedirectPending && !user;
  const isLoadingProfile = !!user && !hydrated;
  if (authLoading || isVerifyingEmail || isLoadingProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
        <div className="absolute inset-0 gradient-hero opacity-60 pointer-events-none" />
        <div className="relative w-full max-w-md">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <div className="glass-strong rounded-3xl p-8 shadow-card text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            <h1 className="mt-4 text-2xl font-bold">
              {isVerifyingEmail ? "Verifying email" : "Just a moment"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {isVerifyingEmail
                ? "Please wait while we finish signing you in."
                : "Loading your profile…"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 relative overflow-hidden">
      <div className="absolute inset-0 gradient-hero opacity-60 pointer-events-none" />
      <div className={isWideStep ? "relative w-full max-w-7xl" : "relative w-full max-w-2xl"}>
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <div className={isWideStep ? "space-y-4" : "glass-strong rounded-3xl p-8 shadow-card"}>
          <div className={isWideStep ? "glass-strong rounded-3xl p-5 shadow-card" : ""}>
            <div className="flex items-center gap-2 mb-6">
              {steps.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-all ${
                    i <= step ? "gradient-brand" : "bg-foreground/10"
                  }`}
                />
              ))}
            </div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Step {step + 1} of {steps.length}
            </div>
            <h2 className="text-2xl font-bold mt-1">{steps[step]}</h2>
          </div>

          <div className={isWideStep ? "" : "mt-6"}>
            {step === 0 && (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="name" className="text-xs font-medium text-muted-foreground">
                    Full name
                  </Label>
                  <Input
                    id="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Your name"
                    className="glass mt-1 h-10 border-white/10"
                  />
                </div>
                <div>
                  <Label htmlFor="bio" className="text-xs font-medium text-muted-foreground">
                    Short bio
                  </Label>
                  <Textarea
                    id="bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="What do you study? What are you passionate about?"
                    className="glass mt-1 min-h-20 resize-none border-white/10"
                  />
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="glass rounded-3xl border border-white/10 p-5 md:p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-brand-cyan" aria-hidden />
                      <h3 className="text-sm font-semibold tracking-wide">Skills I teach</h3>
                    </div>
                    {teaching.length > 0 && (
                      <span className="text-xs text-muted-foreground">{teaching.length}</span>
                    )}
                  </div>
                  <SkillPicker
                    kind="teaching"
                    placeholder="Add a skill you teach…"
                    focusPlaceholder="Focus, e.g. Python loops"
                    modePlaceholder="Method: Teaching"
                    levelPlaceholder="Level: Intermediate"
                    input={teachInput}
                    setInput={setTeachInput}
                    focus={teachFocus}
                    setFocus={setTeachFocus}
                    level={teachLevel}
                    setLevel={setTeachLevel}
                    category={teachCategory}
                    setCategory={setTeachCategory}
                    modeValue={teachMode}
                    setModeValue={setTeachMode}
                    onAdd={addTeach}
                    entries={teaching}
                    setEntries={setTeaching}
                    allSkills={allSkills}
                  />
                </section>

                <section className="glass rounded-3xl border border-white/10 p-5 md:p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-brand-purple" aria-hidden />
                      <h3 className="text-sm font-semibold tracking-wide">
                        Skills I want to learn
                      </h3>
                    </div>
                    {learning.length > 0 && (
                      <span className="text-xs text-muted-foreground">{learning.length}</span>
                    )}
                  </div>
                  <SkillPicker
                    kind="learning"
                    placeholder="Add a skill you want to learn…"
                    focusPlaceholder="Focus, e.g. mobile layouts"
                    modePlaceholder="Method: Mentorship"
                    levelPlaceholder="Level: Basic"
                    input={learnInput}
                    setInput={setLearnInput}
                    focus={learnFocus}
                    setFocus={setLearnFocus}
                    level={learnLevel}
                    setLevel={setLearnLevel}
                    category={learnCategory}
                    setCategory={setLearnCategory}
                    modeValue={learnMode}
                    setModeValue={setLearnMode}
                    onAdd={addLearn}
                    entries={learning}
                    setEntries={setLearning}
                    allSkills={allSkills}
                  />
                </section>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <Label className="text-xs font-medium text-muted-foreground">
                  Preferred learning mode
                </Label>
                <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                  <SelectTrigger className="glass h-10 border-white/10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="teaching">Teaching</SelectItem>
                    <SelectItem value="collaboration">Collaboration</SelectItem>
                    <SelectItem value="mentorship">Mentorship</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  This helps us suggest the right matches for you.
                </p>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <p className="text-sm text-muted-foreground">
                  Let us know when you&apos;re free. The system uses this to suggest session times
                  that work for both you and the other party. You can skip this and set it up later
                  in your profile.
                </p>
                <AvailabilityEditor defaultMode="teach" />
              </div>
            )}
          </div>

          <div
            className={
              isWideStep
                ? "glass-strong flex items-center justify-between rounded-3xl p-4 shadow-card"
                : "mt-8 flex items-center justify-between"
            }
          >
            <Button
              variant="ghost"
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
            >
              Back
            </Button>
            {step < steps.length - 1 ? (
              <Button
                variant="hero"
                disabled={step === 0 && !fullName.trim()}
                onClick={async () => {
                  // Auto-add a typed-but-not-added skill so users don't silently lose input
                  if (step === 1 && teachInput.trim()) await addTeach();
                  if (step === 1 && learnInput.trim()) await addLearn();
                  setStep(step + 1);
                }}
              >
                Continue
              </Button>
            ) : (
              <Button variant="hero" onClick={finish} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Finish setup
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillPicker({
  kind,
  placeholder,
  focusPlaceholder,
  modePlaceholder,
  levelPlaceholder,
  input,
  setInput,
  focus,
  setFocus,
  level,
  setLevel,
  category,
  setCategory,
  modeValue,
  setModeValue,
  onAdd,
  entries,
  setEntries,
  allSkills,
}: {
  kind: "teaching" | "learning";
  placeholder: string;
  focusPlaceholder: string;
  modePlaceholder: string;
  levelPlaceholder: string;
  input: string;
  setInput: (v: string) => void;
  focus: string;
  setFocus: (v: string) => void;
  level: SkillLevel | "";
  setLevel: (v: SkillLevel | "") => void;
  category: string;
  setCategory: (v: string) => void;
  modeValue: LearningMode | "";
  setModeValue: (v: LearningMode | "") => void;
  onAdd: () => void;
  entries: LevelEntry[];
  setEntries: (e: LevelEntry[]) => void;
  allSkills: Skill[];
}) {
  const emptyText =
    kind === "teaching"
      ? "No skills yet. Add one you can teach."
      : "No skills yet. Add one you want help with.";
  const suggestions = allSkills
    .filter((s) => input && s.name.toLowerCase().includes(input.toLowerCase()))
    .filter((s) => !entries.find((e) => e.skill.id === s.id))
    .slice(0, 5);

  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {entries.map((e, i) => (
            <li
              key={e.skill.id}
              className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 transition-colors hover:bg-white/[0.07]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {e.skill.name}
                  </span>
                  <Select
                    value={e.level}
                    onValueChange={(v) => {
                      const next = [...entries];
                      next[i] = { ...e, level: v as SkillLevel };
                      setEntries(next);
                    }}
                  >
                    <SelectTrigger
                      className={cn(
                        "h-6 w-auto gap-1 rounded-full border-0 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60",
                        LEVEL_COLORS[e.level],
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic</SelectItem>
                      <SelectItem value="intermediate">Intermediate</SelectItem>
                      <SelectItem value="advanced">Advanced</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={e.mode}
                    onValueChange={(v) => {
                      const next = [...entries];
                      next[i] = { ...e, mode: v as LearningMode };
                      setEntries(next);
                    }}
                  >
                    <SelectTrigger className="h-6 w-auto gap-1 rounded-full border-0 bg-secondary/60 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {LEARNING_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {formatLearningMode(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {(e.focus || e.skill.category) && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {e.focus ? e.focus : e.skill.category}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-full text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                title="Remove skill"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-white/[0.06] pt-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onAdd())}
            placeholder={placeholder}
            className="glass h-10 border-white/10"
          />
          <Button
            variant={input.trim() ? "hero" : "outline"}
            onClick={onAdd}
            type="button"
            disabled={!input.trim()}
            className="h-10 px-4"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>

        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setInput(s.name)}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
            More options
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onAdd())}
              placeholder={focusPlaceholder}
              className="glass h-10 border-white/10"
            />
            <Select value={level} onValueChange={(v) => setLevel(v as SkillLevel)}>
              <SelectTrigger className="glass h-10 border-white/10">
                <SelectValue placeholder={levelPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="intermediate">Intermediate</SelectItem>
                <SelectItem value="advanced">Advanced</SelectItem>
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="glass h-10 border-white/10">
                <SelectValue placeholder="Category: Other" />
              </SelectTrigger>
              <SelectContent className="max-h-56 overflow-y-auto">
                {SKILL_CATEGORIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={modeValue} onValueChange={(v) => setModeValue(v as LearningMode)}>
              <SelectTrigger className="glass h-10 border-white/10">
                <SelectValue placeholder={modePlaceholder} />
              </SelectTrigger>
              <SelectContent className="max-h-56 overflow-y-auto">
                {LEARNING_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {formatLearningMode(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </details>
      </div>
    </div>
  );
}
