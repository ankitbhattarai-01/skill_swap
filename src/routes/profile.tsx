import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/ConfirmAction";
import { AvailabilityEditor } from "@/components/AvailabilityEditor";
import { UserAvatar } from "@/components/UserAvatar";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { notifyProfileUpdated } from "@/lib/profile-events";
import { invalidateAiSuggestionsCache } from "@/lib/ai-suggestions";
import { Camera, ChevronDown, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import { formatLearningMode, type LearningMode } from "@/lib/match";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastError } from "@/lib/errors";

export const Route = createFileRoute("/profile")({
  head: () => ({ meta: [{ title: "Profile | SkillSwap" }] }),
  component: ProfilePage,
});

type Skill = { id: string; name: string; category: string | null };
type ProfileState = {
  full_name: string;
  bio: string;
  credits: number;
  avatar_url: string | null;
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

const LEVEL_COLORS: Record<string, string> = {
  basic: "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20",
  intermediate: "bg-brand-blue/15 text-brand-blue border-brand-blue/25",
  advanced: "bg-brand-purple/15 text-brand-purple border-brand-purple/25",
};

const LEARNING_METHODS: LearningMode[] = [
  "teaching",
  "mentorship",
  "collaboration",
  "project_based",
];

const SKILL_METHOD_STORE_PREFIX = "skillswap-skill-methods";
const SKILL_FOCUS_STORE_PREFIX = "skillswap-skill-focus";

function normalizeLearningMethod(
  mode: LearningMode | null | undefined,
  fallback: LearningMode,
): LearningMode {
  return LEARNING_METHODS.includes(mode as LearningMode) ? (mode as LearningMode) : fallback;
}

function getStoredSkillMethods(userId: string) {
  try {
    const raw = localStorage.getItem(`${SKILL_METHOD_STORE_PREFIX}-${userId}`);
    if (!raw) return { teaching: {}, learning: {} };
    const parsed = JSON.parse(raw) as {
      teaching?: Record<string, LearningMode>;
      learning?: Record<string, LearningMode>;
    };
    return {
      teaching: parsed.teaching ?? {},
      learning: parsed.learning ?? {},
    };
  } catch {
    return { teaching: {}, learning: {} };
  }
}

function setStoredSkillMethod(
  userId: string,
  kind: "teaching" | "learning",
  id: string,
  mode: LearningMode,
) {
  try {
    const current = getStoredSkillMethods(userId);
    current[kind][id] = mode;
    localStorage.setItem(`${SKILL_METHOD_STORE_PREFIX}-${userId}`, JSON.stringify(current));
  } catch {
    // Local persistence is a fallback for projects that have not applied the DB migration yet.
  }
}

function getStoredSkillFocuses(userId: string) {
  try {
    const raw = localStorage.getItem(`${SKILL_FOCUS_STORE_PREFIX}-${userId}`);
    if (!raw) return { teaching: {}, learning: {} };
    const parsed = JSON.parse(raw) as {
      teaching?: Record<string, string>;
      learning?: Record<string, string>;
    };
    return {
      teaching: parsed.teaching ?? {},
      learning: parsed.learning ?? {},
    };
  } catch {
    return { teaching: {}, learning: {} };
  }
}

function setStoredSkillFocus(
  userId: string,
  kind: "teaching" | "learning",
  id: string,
  focus: string,
) {
  try {
    const current = getStoredSkillFocuses(userId);
    const trimmed = focus.trim();
    if (trimmed) {
      current[kind][id] = trimmed;
    } else {
      delete current[kind][id];
    }
    localStorage.setItem(`${SKILL_FOCUS_STORE_PREFIX}-${userId}`, JSON.stringify(current));
  } catch {
    // Specific focus is currently client-side profile detail.
  }
}

type TeachingSkillRow = {
  id: string;
  level: string;
  teaching_mode?: LearningMode | null;
  skills: Skill | null;
};

type LearningSkillRow = {
  id: string;
  current_level: string;
  learning_mode?: LearningMode | null;
  skills: Skill | null;
};

async function loadTeachingSkills(userId: string) {
  const withMethod = await supabase
    .from("user_teaching_skills")
    .select("id, level, teaching_mode, skills:skill_id(id, name, category)")
    .eq("user_id", userId);

  if (!withMethod.error) return (withMethod.data ?? []) as unknown as TeachingSkillRow[];

  const fallback = await supabase
    .from("user_teaching_skills")
    .select("id, level, skills:skill_id(id, name, category)")
    .eq("user_id", userId);

  return (fallback.data ?? []) as unknown as TeachingSkillRow[];
}

async function loadLearningSkills(userId: string) {
  const withMethod = await supabase
    .from("user_learning_skills")
    .select("id, current_level, learning_mode, skills:skill_id(id, name, category)")
    .eq("user_id", userId);

  if (!withMethod.error) return (withMethod.data ?? []) as unknown as LearningSkillRow[];

  const fallback = await supabase
    .from("user_learning_skills")
    .select("id, current_level, skills:skill_id(id, name, category)")
    .eq("user_id", userId);

  return (fallback.data ?? []) as unknown as LearningSkillRow[];
}

// The name + bio inputs live in their own memoized component with local
// state. Without this, every keystroke in the parent triggered a re-render
// of the whole profile tree (skills lists, AvailabilityEditor's 7×2 selects,
// etc.) and felt visibly laggy. The parent reaches in via ref at Save time.
export type NameBioFormHandle = {
  getValues: () => { full_name: string; bio: string };
  isDirty: () => boolean;
  reset: (next: { full_name: string; bio: string }) => void;
};

type NameBioFormProps = {
  initialFullName: string;
  initialBio: string;
  onDirtyChange: (dirty: boolean) => void;
};

const NameBioForm = memo(
  forwardRef<NameBioFormHandle, NameBioFormProps>(function NameBioForm(
    { initialFullName, initialBio, onDirtyChange },
    ref,
  ) {
    const [fullName, setFullName] = useState(initialFullName);
    const [bio, setBio] = useState(initialBio);

    // When the initial values change (e.g. after a successful save), accept
    // them as the new baseline.
    useEffect(() => {
      setFullName(initialFullName);
      setBio(initialBio);
    }, [initialFullName, initialBio]);

    // Compute and report dirty status when values change.
    useEffect(() => {
      const dirty = fullName !== initialFullName || bio !== initialBio;
      onDirtyChange(dirty);
    }, [fullName, bio, initialFullName, initialBio, onDirtyChange]);

    useImperativeHandle(
      ref,
      () => ({
        getValues: () => ({ full_name: fullName, bio }),
        isDirty: () => fullName !== initialFullName || bio !== initialBio,
        reset: (next) => {
          setFullName(next.full_name);
          setBio(next.bio);
        },
      }),
      [fullName, bio, initialFullName, initialBio],
    );

    return (
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
            Bio
          </Label>
          <Textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="A short line about you"
            className="glass mt-1 min-h-20 resize-none border-white/10"
          />
        </div>
      </div>
    );
  }),
);

const ChangePasswordDialog = memo(function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setNewPassword("");
      setConfirmNewPassword("");
    }
  };

  const submit = async () => {
    if (newPassword.length < 8) {
      toast.error("Your password needs to be a bit longer. Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      toast.error("Those two passwords don't match. Please retype them.");
      return;
    }
    setChangingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setChangingPassword(false);
      return toastError(error);
    }
    // Revoke every OTHER active session for this account so a previously
    // signed-in device (lost phone, shared computer) can't keep using the
    // old refresh token after the password rotation.
    await supabase.auth.signOut({ scope: "others" }).catch(() => {});
    setChangingPassword(false);
    handleOpenChange(false);
    toast.success("Password updated. Other devices have been signed out.");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="glass-strong border-white/10 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Choose a new password for your account (at least 8 characters).
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="glass mt-1.5 h-10 border-white/10"
            />
          </div>
          <div>
            <Label htmlFor="confirm-new-password">Confirm new password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              className="glass mt-1.5 h-10 border-white/10"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={changingPassword}
            >
              Cancel
            </Button>
            <Button type="submit" variant="hero" size="sm" disabled={changingPassword}>
              {changingPassword && <Loader2 className="h-3 w-3 animate-spin" />}
              Update password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
});

function ProfilePage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  // Only users with an email/password identity can change a password. OAuth-
  // only accounts (Google, GitHub) have no password on file — they recover
  // access via the OAuth provider, not via this dialog.
  const hasPasswordAuth = (user?.identities ?? []).some((i) => i.provider === "email");
  const [openSessionCount, setOpenSessionCount] = useState(0);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const nameBioRef = useRef<NameBioFormHandle>(null);
  const [nameBioDirty, setNameBioDirty] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [teaching, setTeaching] = useState<
    { id: string; skill: Skill; focus: string; level: string; teaching_mode: LearningMode }[]
  >([]);
  const [learning, setLearning] = useState<
    {
      id: string;
      skill: Skill;
      focus: string;
      current_level: string;
      learning_mode: LearningMode;
    }[]
  >([]);
  const [teachInput, setTeachInput] = useState("");
  const [teachFocusInput, setTeachFocusInput] = useState("");
  const [learnInput, setLearnInput] = useState("");
  const [learnFocusInput, setLearnFocusInput] = useState("");
  const [teachCategory, setTeachCategory] = useState("");
  const [learnCategory, setLearnCategory] = useState("");
  const [teachMode, setTeachMode] = useState<LearningMode | "">("");
  const [learnMode, setLearnMode] = useState<LearningMode | "">("");
  const [teachLevel, setTeachLevel] = useState<"basic" | "intermediate" | "advanced" | "">("");
  const [learnLevel, setLearnLevel] = useState<"basic" | "intermediate" | "advanced" | "">("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/profile" } });
    }
  }, [authLoading, user, navigate]);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const controller = new AbortController();

    (async () => {
      try {
        const [{ data: p }, { data: creditBalance }, { data: skills }, t, l, openSessions] =
          await Promise.all([
            supabase
              .from("profiles")
              .select("full_name, bio, avatar_url")
              .eq("id", userId)
              .abortSignal(controller.signal)
              .maybeSingle(),
            supabase.rpc("my_credit_balance").abortSignal(controller.signal),
            supabase
              .from("skills")
              .select("id, name, category")
              .order("name")
              .abortSignal(controller.signal),
            loadTeachingSkills(userId),
            loadLearningSkills(userId),
            supabase
              .from("sessions")
              .select("id", { count: "exact", head: true })
              .or(`teacher_id.eq.${userId},learner_id.eq.${userId}`)
              .in("status", ["pending", "accepted", "active"])
              .abortSignal(controller.signal),
          ]);
        if (!alive || controller.signal.aborted) return;

        const loadedProfile = {
          full_name: p?.full_name ?? "",
          bio: p?.bio ?? "",
          credits: creditBalance ?? 10,
          avatar_url: null,
        };
        setProfile(loadedProfile);
        setAllSkills(skills ?? []);
        setOpenSessionCount(openSessions.count ?? 0);
        const storedMethods = getStoredSkillMethods(userId);
        const storedFocuses = getStoredSkillFocuses(userId);
        setTeaching(
          t
            .map((x) => ({
              id: x.id,
              skill: x.skills as Skill,
              focus: storedFocuses.teaching[x.id] ?? "",
              level: x.level,
              teaching_mode: normalizeLearningMethod(
                x.teaching_mode ?? storedMethods.teaching[x.id],
                "teaching",
              ),
            }))
            .filter((x) => x.skill),
        );
        setLearning(
          l
            .map((x) => ({
              id: x.id,
              skill: x.skills as Skill,
              focus: storedFocuses.learning[x.id] ?? "",
              current_level: x.current_level,
              learning_mode: normalizeLearningMethod(
                x.learning_mode ?? storedMethods.learning[x.id],
                "mentorship",
              ),
            }))
            .filter((x) => x.skill),
        );

        if (!p?.avatar_url) return;
        const signedAvatarUrl = await signSingleAvatarUrl(p.avatar_url).catch(() => null);
        if (alive && !controller.signal.aborted && signedAvatarUrl) {
          setProfile((current) =>
            current ? { ...current, avatar_url: signedAvatarUrl } : current,
          );
        }
      } catch (error) {
        // Silently swallow any cancellation/abort signal — these fire whenever
        // the user's auth token refreshes mid-load and aren't real failures.
        if (!alive || controller.signal.aborted) return;
        const name =
          typeof error === "object" && error !== null && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (name === "AbortError" || code === "20" || code === "ABORT_ERR") return;
        setProfile({ full_name: "", bio: "", credits: 10, avatar_url: null });
        toast.error(error instanceof Error ? error.message : "Could not load profile");
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [userId]);

  const findOrCreate = async (name: string, category: string): Promise<Skill | null> => {
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
    if (!user) return;
    const selectedTeachMode = teachMode || "teaching";
    const selectedTeachLevel = teachLevel || "intermediate";
    const skill = await findOrCreate(teachInput, teachCategory || "Other");
    if (!skill) return;
    const existing = teaching.find((t) => t.skill.id === skill.id);
    if (existing) {
      const focus = teachFocusInput.trim();
      setStoredSkillFocus(user.id, "teaching", existing.id, focus);
      setTeaching(teaching.map((t) => (t.id === existing.id ? { ...t, focus } : t)));
      setTeachInput("");
      setTeachFocusInput("");
      setTeachCategory("");
      setTeachMode("");
      setTeachLevel("");
      return;
    }
    let methodSavedInDatabase = true;
    let result = await supabase
      .from("user_teaching_skills")
      .insert({
        user_id: user.id,
        skill_id: skill.id,
        level: selectedTeachLevel,
        teaching_mode: selectedTeachMode,
      })
      .select("id")
      .single();
    if (result.error?.message.includes("teaching_mode")) {
      methodSavedInDatabase = false;
      result = await supabase
        .from("user_teaching_skills")
        .insert({ user_id: user.id, skill_id: skill.id, level: selectedTeachLevel })
        .select("id")
        .single();
    }
    const { data, error } = result;
    if (error || !data) return toast.error(error?.message ?? "Failed");
    if (!methodSavedInDatabase) {
      setStoredSkillMethod(user.id, "teaching", data.id, selectedTeachMode);
    }
    const focus = teachFocusInput.trim();
    setStoredSkillFocus(user.id, "teaching", data.id, focus);
    setTeaching([
      ...teaching,
      { id: data.id, skill, focus, level: selectedTeachLevel, teaching_mode: selectedTeachMode },
    ]);
    setTeachInput("");
    setTeachFocusInput("");
    setTeachCategory("");
    setTeachMode("");
    setTeachLevel("");
    void invalidateAiSuggestionsCache();
  };

  const addLearn = async () => {
    if (!user) return;
    const selectedLearnMode = learnMode || "mentorship";
    const selectedLearnLevel = learnLevel || "basic";
    const skill = await findOrCreate(learnInput, learnCategory || "Other");
    if (!skill) return;
    const existing = learning.find((t) => t.skill.id === skill.id);
    if (existing) {
      const focus = learnFocusInput.trim();
      setStoredSkillFocus(user.id, "learning", existing.id, focus);
      setLearning(learning.map((t) => (t.id === existing.id ? { ...t, focus } : t)));
      setLearnInput("");
      setLearnFocusInput("");
      setLearnCategory("");
      setLearnMode("");
      setLearnLevel("");
      return;
    }
    let methodSavedInDatabase = true;
    let result = await supabase
      .from("user_learning_skills")
      .insert({
        user_id: user.id,
        skill_id: skill.id,
        current_level: selectedLearnLevel,
        learning_mode: selectedLearnMode,
      })
      .select("id")
      .single();
    if (result.error?.message.includes("learning_mode")) {
      methodSavedInDatabase = false;
      result = await supabase
        .from("user_learning_skills")
        .insert({ user_id: user.id, skill_id: skill.id, current_level: selectedLearnLevel })
        .select("id")
        .single();
    }
    const { data, error } = result;
    if (error || !data) return toast.error(error?.message ?? "Failed");
    if (!methodSavedInDatabase) {
      setStoredSkillMethod(user.id, "learning", data.id, selectedLearnMode);
    }
    const focus = learnFocusInput.trim();
    setStoredSkillFocus(user.id, "learning", data.id, focus);
    setLearning([
      ...learning,
      {
        id: data.id,
        skill,
        focus,
        current_level: selectedLearnLevel,
        learning_mode: selectedLearnMode,
      },
    ]);
    setLearnInput("");
    setLearnFocusInput("");
    setLearnCategory("");
    setLearnMode("");
    setLearnLevel("");
    void invalidateAiSuggestionsCache();
  };

  const removeTeach = async (id: string) => {
    const { error } = await supabase.from("user_teaching_skills").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setTeaching(teaching.filter((t) => t.id !== id));
    void invalidateAiSuggestionsCache();
  };
  const removeLearn = async (id: string) => {
    const { error } = await supabase.from("user_learning_skills").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setLearning(learning.filter((t) => t.id !== id));
    void invalidateAiSuggestionsCache();
  };

  const updateTeachLevel = async (id: string, level: string) => {
    const lvl = level as "basic" | "intermediate" | "advanced";
    const { error } = await supabase
      .from("user_teaching_skills")
      .update({ level: lvl })
      .eq("id", id);
    if (error) return toast.error(error.message);
    setTeaching(teaching.map((t) => (t.id === id ? { ...t, level: lvl } : t)));
  };
  const updateLearnLevel = async (id: string, level: string) => {
    const lvl = level as "basic" | "intermediate" | "advanced";
    const { error } = await supabase
      .from("user_learning_skills")
      .update({ current_level: lvl })
      .eq("id", id);
    if (error) return toast.error(error.message);
    setLearning(learning.map((t) => (t.id === id ? { ...t, current_level: lvl } : t)));
  };

  const updateTeachMode = async (id: string, mode: LearningMode) => {
    if (user) {
      setStoredSkillMethod(user.id, "teaching", id, mode);
    }
    setTeaching(teaching.map((t) => (t.id === id ? { ...t, teaching_mode: mode } : t)));
    const { error } = await supabase
      .from("user_teaching_skills")
      .update({ teaching_mode: mode })
      .eq("id", id);
    if (error) return;
  };

  const updateLearnMode = async (id: string, mode: LearningMode) => {
    if (user) {
      setStoredSkillMethod(user.id, "learning", id, mode);
    }
    setLearning(learning.map((t) => (t.id === id ? { ...t, learning_mode: mode } : t)));
    const { error } = await supabase
      .from("user_learning_skills")
      .update({ learning_mode: mode })
      .eq("id", id);
    if (error) return;
  };

  const uploadAvatar = async (file: File) => {
    if (!user || !profile) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be 2 MB or smaller");
      return;
    }
    setUploadingAvatar(true);
    // Read the previous storage key BEFORE overwriting the pointer so we can
    // remove the orphan from the bucket after the new upload commits.
    const { data: previousProfileRow } = await supabase
      .from("profiles")
      .select("avatar_url")
      .eq("id", user.id)
      .maybeSingle();
    const previousAvatarPath = previousProfileRow?.avatar_url ?? null;
    const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "png";
    const path = `${user.id}/avatar-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: false, contentType: file.type });
    if (uploadError) {
      setUploadingAvatar(false);
      toast.error(uploadError.message);
      return;
    }
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ avatar_url: path })
      .eq("id", user.id);
    if (updateError) {
      setUploadingAvatar(false);
      return toast.error(updateError.message);
    }
    // Best-effort cleanup of the previous avatar object. Failure here must not
    // surface to the user — the new avatar is already saved and live.
    if (previousAvatarPath && previousAvatarPath !== path) {
      await supabase.storage
        .from("avatars")
        .remove([previousAvatarPath])
        .catch(() => null);
    }
    const signedUrl = await signSingleAvatarUrl(path);
    setUploadingAvatar(false);
    setProfile({ ...profile, avatar_url: signedUrl });
    notifyProfileUpdated();
    toast.success("Avatar updated");
  };

  const saveProfile = async () => {
    if (!user || !profile) return;
    const values = nameBioRef.current?.getValues() ?? {
      full_name: profile.full_name,
      bio: profile.bio,
    };
    setSaving(true);
    const { data, error } = await supabase
      .from("profiles")
      .update({ full_name: values.full_name, bio: values.bio })
      .eq("id", user.id)
      .select("full_name, bio, avatar_url")
      .single();
    setSaving(false);
    if (error) return toast.error(error.message);
    const nextFullName = data.full_name ?? values.full_name;
    const nextBio = data.bio ?? values.bio;
    setProfile({
      full_name: nextFullName,
      bio: nextBio,
      credits: profile.credits,
      avatar_url: profile.avatar_url,
    });
    nameBioRef.current?.reset({ full_name: nextFullName, bio: nextBio });
    setNameBioDirty(false);
    notifyProfileUpdated();
    void invalidateAiSuggestionsCache();
    toast.success("Profile updated");
  };

  const deleteAccount = async () => {
    if (!user) return;
    setDeleting(true);
    const { error } = await supabase.rpc("delete_my_account");
    if (error) {
      setDeleting(false);
      toast.error(error.message);
      return;
    }
    await signOut();
    toast.success("Account deleted");
    navigate({ to: "/" });
  };

  if (authLoading || !profile) {
    return <PageLoading variant="profile" />;
  }

  const profileProgress =
    (profile.full_name.trim() ? 25 : 0) +
    (profile.bio.trim() ? 25 : 0) +
    (teaching.length ? 25 : 0) +
    (learning.length ? 25 : 0);
  const hasProfileChanges = nameBioDirty;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.16),transparent_55%)] pointer-events-none dark:hidden" />

          <div className="relative p-5 md:p-6">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
              <div className="relative mx-auto shrink-0 md:mx-0">
                <UserAvatar
                  name={profile.full_name}
                  url={profile.avatar_url}
                  className="h-24 w-24 rounded-3xl ring-2 ring-brand-purple/30 shadow-glow"
                  fallbackClassName="text-3xl rounded-3xl"
                />
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAvatar(file);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="absolute -bottom-1.5 -right-1.5 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-background/90 text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-background disabled:opacity-60"
                  title={profile.avatar_url ? "Change photo" : "Upload photo"}
                  aria-label={profile.avatar_url ? "Change photo" : "Upload photo"}
                >
                  {uploadingAvatar ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Profile strength ·{" "}
                    <span className="font-medium text-foreground/80">{profileProgress}%</span>
                  </p>
                  <Button
                    variant="hero"
                    size="sm"
                    className="h-9 px-4 disabled:opacity-55"
                    onClick={saveProfile}
                    disabled={saving || !hasProfileChanges}
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save
                  </Button>
                </div>
                <NameBioForm
                  ref={nameBioRef}
                  initialFullName={profile.full_name}
                  initialBio={profile.bio}
                  onDirtyChange={setNameBioDirty}
                />
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Teaching */}
          <section className="glass rounded-3xl border border-white/10 p-5 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-cyan" aria-hidden />
                <h2 className="text-sm font-semibold tracking-wide">Skills I teach</h2>
              </div>
              {teaching.length > 0 && (
                <span className="text-xs text-muted-foreground">{teaching.length}</span>
              )}
            </div>

            {teaching.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No skills yet. Add one you can teach.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {teaching.map((t) => (
                  <li
                    key={t.id}
                    className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 transition-colors hover:bg-white/[0.07]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {t.skill.name}
                        </span>
                        <Select
                          value={t.level}
                          onValueChange={(value) => updateTeachLevel(t.id, value)}
                        >
                          <SelectTrigger
                            className={cn(
                              "h-6 w-auto gap-1 rounded-full border-0 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60",
                              LEVEL_COLORS[t.level] ?? "bg-secondary/60",
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
                          value={t.teaching_mode}
                          onValueChange={(value) => updateTeachMode(t.id, value as LearningMode)}
                        >
                          <SelectTrigger className="h-6 w-auto gap-1 rounded-full border-0 bg-secondary/60 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-56 overflow-y-auto">
                            {LEARNING_METHODS.map((mode) => (
                              <SelectItem key={mode} value={mode}>
                                {formatLearningMode(mode)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {(t.focus || t.skill.category) && (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {t.focus ? t.focus : t.skill.category}
                        </p>
                      )}
                    </div>
                    <ConfirmAction
                      title={`Remove ${t.skill.name}?`}
                      description="Learners will no longer see you as a teacher for this skill. You can add it back anytime."
                      confirmLabel="Remove"
                      destructive
                      onConfirm={() => removeTeach(t.id)}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded-full text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                        title="Remove teaching skill"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </ConfirmAction>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 space-y-2 border-t border-white/[0.06] pt-4">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  name="teach-skill"
                  autoComplete="off"
                  value={teachInput}
                  onChange={(e) => setTeachInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTeach())}
                  placeholder="Add a skill you teach…"
                  className="glass h-10 border-white/10"
                />
                <Button
                  variant={teachInput.trim() ? "hero" : "outline"}
                  className="h-10 px-4"
                  onClick={addTeach}
                  disabled={!teachInput.trim()}
                  title="Add teaching skill"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>

              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                  More options
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Input
                    name="teach-skill-focus"
                    autoComplete="off"
                    value={teachFocusInput}
                    onChange={(e) => setTeachFocusInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTeach())}
                    placeholder="Focus, e.g. Python loops"
                    className="glass h-10 border-white/10"
                  />
                  <Select
                    value={teachLevel}
                    onValueChange={(v) => setTeachLevel(v as typeof teachLevel)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Level: Intermediate" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic</SelectItem>
                      <SelectItem value="intermediate">Intermediate</SelectItem>
                      <SelectItem value="advanced">Advanced</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={teachCategory} onValueChange={setTeachCategory}>
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Category: Other" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {SKILL_CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={teachMode}
                    onValueChange={(value) => setTeachMode(value as LearningMode)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Method: Teaching" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {LEARNING_METHODS.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {formatLearningMode(mode)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </details>
            </div>
          </section>

          {/* Learning */}
          <section className="glass rounded-3xl border border-white/10 p-5 md:p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-purple" aria-hidden />
                <h2 className="text-sm font-semibold tracking-wide">Skills I want to learn</h2>
              </div>
              {learning.length > 0 && (
                <span className="text-xs text-muted-foreground">{learning.length}</span>
              )}
            </div>

            {learning.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No skills yet. Add one you want help with.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {learning.map((t) => (
                  <li
                    key={t.id}
                    className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 transition-colors hover:bg-white/[0.07]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {t.skill.name}
                        </span>
                        <Select
                          value={t.current_level}
                          onValueChange={(value) => updateLearnLevel(t.id, value)}
                        >
                          <SelectTrigger
                            className={cn(
                              "h-6 w-auto gap-1 rounded-full border-0 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60",
                              LEVEL_COLORS[t.current_level] ?? "bg-secondary/60",
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
                          value={t.learning_mode}
                          onValueChange={(value) => updateLearnMode(t.id, value as LearningMode)}
                        >
                          <SelectTrigger className="h-6 w-auto gap-1 rounded-full border-0 bg-secondary/60 px-2 text-[11px] font-medium shadow-none focus:ring-1 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-60">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-56 overflow-y-auto">
                            {LEARNING_METHODS.map((mode) => (
                              <SelectItem key={mode} value={mode}>
                                {formatLearningMode(mode)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {(t.focus || t.skill.category) && (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {t.focus ? t.focus : t.skill.category}
                        </p>
                      )}
                    </div>
                    <ConfirmAction
                      title={`Remove ${t.skill.name}?`}
                      description="This skill will be removed from the things you want to learn. You can add it back anytime."
                      confirmLabel="Remove"
                      destructive
                      onConfirm={() => removeLearn(t.id)}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded-full text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                        title="Remove learning skill"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </ConfirmAction>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 space-y-2 border-t border-white/[0.06] pt-4">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  name="learn-skill"
                  autoComplete="off"
                  value={learnInput}
                  onChange={(e) => setLearnInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLearn())}
                  placeholder="Add a skill you want to learn…"
                  className="glass h-10 border-white/10"
                />
                <Button
                  variant={learnInput.trim() ? "hero" : "outline"}
                  className="h-10 px-4"
                  onClick={addLearn}
                  disabled={!learnInput.trim()}
                  title="Add learning skill"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>

              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                  More options
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Input
                    name="learn-skill-focus"
                    autoComplete="off"
                    value={learnFocusInput}
                    onChange={(e) => setLearnFocusInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLearn())}
                    placeholder="Focus, e.g. mobile layouts"
                    className="glass h-10 border-white/10"
                  />
                  <Select
                    value={learnLevel}
                    onValueChange={(v) => setLearnLevel(v as typeof learnLevel)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Level: Basic" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic</SelectItem>
                      <SelectItem value="intermediate">Intermediate</SelectItem>
                      <SelectItem value="advanced">Advanced</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={learnCategory} onValueChange={setLearnCategory}>
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Category: Other" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {SKILL_CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={learnMode}
                    onValueChange={(value) => setLearnMode(value as LearningMode)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Method: Mentorship" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {LEARNING_METHODS.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {formatLearningMode(mode)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </details>
            </div>
          </section>
        </div>

        <section className="glass rounded-3xl border border-white/10 p-5 md:p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brand-blue" aria-hidden />
              <h2 className="text-sm font-semibold tracking-wide">Availability</h2>
            </div>
            <span className="text-xs text-muted-foreground">Your local clock</span>
          </div>
          <AvailabilityEditor defaultMode="teach" />
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          {hasPasswordAuth && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-full border border-white/10 bg-white/5 px-4 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
              onClick={() => setPasswordDialogOpen(true)}
            >
              <KeyRound className="h-3 w-3" />
              Change password
            </Button>
          )}
          <ConfirmAction
            title="Delete your account?"
            description={
              openSessionCount > 0
                ? `You still have ${openSessionCount} open session${openSessionCount === 1 ? "" : "s"}. Deleting now will cancel them and refund any held credits to learners. Your profile, skills, and unread notifications will be removed permanently. Past sessions, reviews, and chat transcripts remain with the people you exchanged with, attributed to a deleted user.`
                : "This is permanent. Your profile, skills, and unread notifications will be deleted. Past sessions, reviews, and chat transcripts remain with the people you exchanged with, attributed to a deleted user."
            }
            confirmLabel="Delete my account"
            destructive
            onConfirm={deleteAccount}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full border border-destructive/30 bg-destructive/5 px-4 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Delete account
            </Button>
          </ConfirmAction>
        </div>

        <ChangePasswordDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
      </main>
    </div>
  );
}
