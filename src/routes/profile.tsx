import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { PageLoading } from "@/components/PageLoading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/ConfirmAction";
import { SkillCombobox } from "@/components/SkillCombobox";
import { AvailabilityEditor, prefetchAvailability } from "@/components/AvailabilityEditor";
import { UserAvatar } from "@/components/UserAvatar";
import { cachedAvatarUrls, signSingleAvatarUrl } from "@/lib/avatars";
import { notifyProfileUpdated } from "@/lib/profile-events";
import { invalidateAiSuggestionsCache } from "@/lib/ai-suggestions";
import { invalidatePageCaches, PROFILE_CACHE_PREFIX } from "@/lib/page-caches";
import {
  getCachedSkillsCatalog,
  isSkillsCatalogFresh,
  loadSkillsCatalog,
} from "@/lib/skills-catalog";
import { GetVerifiedCard } from "@/components/GetVerifiedCard";
import {
  loadSkillVerifications,
  loadVerificationCooldowns,
  type SkillVerification,
} from "@/lib/skill-verification";
import { Camera, ChevronDown, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import { VerifiedTick } from "@/components/VerifiedTick";
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
  // Raw storage key. Kept alongside the signed URL so a background refetch can
  // tell "same photo" from "photo changed" and only re-sign when it actually
  // moved - and so the snapshot below can persist something that doesn't expire.
  avatar_path: string | null;
  avatar_url: string | null;
};

type TeachingEntry = {
  id: string;
  skill: Skill;
  focus: string;
  level: string;
  teaching_mode: LearningMode;
};

type LearningEntry = {
  id: string;
  skill: Skill;
  focus: string;
  current_level: string;
  learning_mode: LearningMode;
};

// The hero photo renders at 80×80 (h-20 w-20). Asking Supabase's image renderer
// for 200px covers 2.5× DPR and turns a full-resolution upload - commonly a few
// hundred KB - into a handful. The page used to request the original.
const AVATAR_TRANSFORM = { width: 200, height: 200, quality: 80, resize: "cover" } as const;

// Same stale-while-revalidate deal the dashboard / explore / credits pages
// already make: paint last visit's snapshot immediately, then reconcile with
// the server in the background. Profile data is edited almost exclusively by
// its owner from this very page (which rewrites the snapshot on every change),
// so the window for showing something stale is tiny.
const PROFILE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type ProfileSnapshot = {
  savedAt: number;
  full_name: string;
  bio: string;
  avatarPath: string | null;
  teaching: TeachingEntry[];
  learning: LearningEntry[];
  verifications: SkillVerification[];
  cooldowns: [string, string][];
};

function readProfileSnapshot(userId: string | undefined): ProfileSnapshot | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${PROFILE_CACHE_PREFIX}-${userId}`);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as ProfileSnapshot;
    if (Date.now() - snapshot.savedAt > PROFILE_CACHE_MAX_AGE_MS) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function writeProfileSnapshot(userId: string, snapshot: Omit<ProfileSnapshot, "savedAt">) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${PROFILE_CACHE_PREFIX}-${userId}`,
      JSON.stringify({ ...snapshot, savedAt: Date.now() } satisfies ProfileSnapshot),
    );
  } catch {
    // Cache is a paint-speed boost only; quota / private mode can ignore it.
  }
}

// Signed avatar URLs expire, so the snapshot stores the storage key instead.
// The avatar module keeps its own (longer-lived) map of key → signed URL, so on
// a revisit we can usually resolve one synchronously and paint the photo in the
// very first frame; a miss just shows initials until the signer resolves.
function snapshotToProfile(snapshot: ProfileSnapshot): ProfileState {
  const path = snapshot.avatarPath;
  return {
    full_name: snapshot.full_name,
    bio: snapshot.bio,
    avatar_path: path,
    avatar_url: path ? (cachedAvatarUrls([path], AVATAR_TRANSFORM).get(path) ?? null) : null,
  };
}

// Runs `task` once the browser is idle, falling back to a short timer where
// requestIdleCallback isn't available (Safari only shipped it in 16.4).
// Returns a canceller for unmount.
function whenIdle(task: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: 1500 });
    return () => window.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(task, 300);
  return () => window.clearTimeout(handle);
}

const LEVEL_COLORS: Record<string, string> = {
  basic: "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20",
  intermediate: "bg-brand-blue/15 text-brand-blue border-brand-blue/25",
  advanced: "bg-brand-purple/15 text-brand-purple border-brand-purple/25",
};

type SkillLevel = "basic" | "intermediate" | "advanced";
const LEVEL_ORDER: SkillLevel[] = ["basic", "intermediate", "advanced"];
const LEVEL_LABELS: Record<SkillLevel, string> = {
  basic: "Basic",
  intermediate: "Intermediate",
  advanced: "Advanced",
};
const levelRank = (level: string) => LEVEL_ORDER.indexOf(level as SkillLevel);

// Same rule the onboarding step enforces: a skill can sit in both lists, but you
// can't learn what you already teach at the same (or lower) level - learning
// must be at least one level above teaching. `relation` is read from the
// perspective of the list being edited: learning entries must stay "above" the
// matching teach level, teaching entries must stay "below" the matching learn
// level. With no matching cross entry, every level is allowed.
function allowedLevelsFor(
  crossLevel: string | undefined,
  relation: "above" | "below",
): SkillLevel[] {
  if (!crossLevel) return LEVEL_ORDER;
  const crossRank = levelRank(crossLevel);
  return LEVEL_ORDER.filter((level) =>
    relation === "above" ? levelRank(level) > crossRank : levelRank(level) < crossRank,
  );
}

// Options for an existing entry's level select: the constrained set, but always
// keep the entry's own current level so the trigger never renders blank and a
// legacy row saved before this rule existed can still be corrected.
function levelOptionsFor(
  current: string,
  crossLevel: string | undefined,
  relation: "above" | "below",
): SkillLevel[] {
  const allowed = allowedLevelsFor(crossLevel, relation);
  if (allowed.includes(current as SkillLevel)) return allowed;
  return LEVEL_ORDER.filter((l) => allowed.includes(l) || l === current);
}

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
      <DialogContent className="sm:max-w-md">
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
  // Read once, at mount. On in-app navigation the signed-in user is already
  // known here, so every slice below is seeded before the first paint and the
  // skeleton never appears at all. On a cold load `user` is still resolving -
  // the load effect hydrates instead, the moment the id lands.
  const [bootSnapshot] = useState(() => readProfileSnapshot(user?.id));
  const [profile, setProfile] = useState<ProfileState | null>(() =>
    bootSnapshot ? snapshotToProfile(bootSnapshot) : null,
  );
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  // Only users with an email/password identity can change a password. OAuth-
  // only accounts (Google, GitHub) have no password on file - they recover
  // access via the OAuth provider, not via this dialog.
  const hasPasswordAuth = (user?.identities ?? []).some((i) => i.provider === "email");
  const [openSessionCount, setOpenSessionCount] = useState(0);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const nameBioRef = useRef<NameBioFormHandle>(null);
  const [nameBioDirty, setNameBioDirty] = useState(false);
  // Mirrors nameBioDirty for the background refetch, which runs outside React's
  // render and must not reset the form under someone who is mid-edit.
  const nameBioDirtyRef = useRef(false);
  const handleNameBioDirty = useCallback((dirty: boolean) => {
    nameBioDirtyRef.current = dirty;
    setNameBioDirty(dirty);
  }, []);
  // Seeded from the shared catalog snapshot so the "add a skill" combobox is
  // usable on arrival; refreshed on an idle callback further down.
  const [allSkills, setAllSkills] = useState<Skill[]>(() => getCachedSkillsCatalog());
  const [teaching, setTeaching] = useState<TeachingEntry[]>(() => bootSnapshot?.teaching ?? []);
  const [learning, setLearning] = useState<LearningEntry[]>(() => bootSnapshot?.learning ?? []);
  const [verifications, setVerifications] = useState<Map<string, SkillVerification>>(
    () => new Map((bootSnapshot?.verifications ?? []).map((v) => [v.skill_id, v] as const)),
  );
  const [verificationCooldowns, setVerificationCooldowns] = useState<Map<string, string>>(
    () => new Map(bootSnapshot?.cooldowns ?? []),
  );
  const [teachInput, setTeachInput] = useState("");
  const [teachFocusInput, setTeachFocusInput] = useState("");
  const [learnInput, setLearnInput] = useState("");
  const [learnFocusInput, setLearnFocusInput] = useState("");
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
  // Guards the snapshot writer below: only state we actually trust (a snapshot
  // hydration or a successful fetch) is worth persisting. Without it, the empty
  // placeholder written on a failed load would be cached and then painted as a
  // blank profile on the next visit.
  const canPersistRef = useRef(Boolean(bootSnapshot));
  const snapshotAppliedForRef = useRef<string | null>(bootSnapshot ? (user?.id ?? null) : null);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const controller = new AbortController();

    // Cold load: `user` resolved after mount, so the snapshot couldn't be read
    // during state init. Apply it now - still synchronously, still before any
    // request comes back - so the skeleton gives way immediately.
    const previousUserId = snapshotAppliedForRef.current;
    if (previousUserId !== userId) {
      snapshotAppliedForRef.current = userId;
      const snapshot = readProfileSnapshot(userId);
      if (snapshot) {
        canPersistRef.current = true;
        setProfile(snapshotToProfile(snapshot));
        setTeaching(snapshot.teaching);
        setLearning(snapshot.learning);
        setVerifications(new Map(snapshot.verifications.map((v) => [v.skill_id, v] as const)));
        setVerificationCooldowns(new Map(snapshot.cooldowns));
      } else if (previousUserId) {
        // A different account than the one currently on screen, with nothing
        // cached for it. Show the skeleton rather than the previous user's name
        // and skills while their replacement loads.
        canPersistRef.current = false;
        setProfile(null);
        setTeaching([]);
        setLearning([]);
        setVerifications(new Map());
        setVerificationCooldowns(new Map());
        setOpenSessionCount(0);
      }
    }

    // Warm the availability schedule in parallel with the profile fetch. The
    // editor lives at the bottom of this page, so without this it couldn't
    // start its own RPC until the page had fully painted - the schedule then
    // showed a whole round-trip late. This collapses that serial hop.
    prefetchAvailability(userId);

    // Applies a resolved slice unless this mount has been torn down. Each
    // background query below settles on its own rather than through a shared
    // Promise.all: grouping them meant the slowest one (the skills catalog,
    // typically) held back the verified ticks and every other slice with it.
    const settle = <T,>(promise: PromiseLike<T>, apply: (value: T) => void) => {
      Promise.resolve(promise)
        .then((value) => {
          if (!alive || controller.signal.aborted) return;
          apply(value);
        })
        .catch(() => {
          // Decoration only - a failure leaves that slice as it was.
        });
    };

    // Phase 1 - the minimum needed to paint the page: identity + skill lists.
    // First paint is gated on `profile` when there was no snapshot to hydrate
    // from, so keep this fetch small; everything else loads below and never
    // blocks the render.
    (async () => {
      try {
        const [{ data: p }, t, l] = await Promise.all([
          supabase
            .from("profiles")
            .select("full_name, bio, avatar_url")
            .eq("id", userId)
            .abortSignal(controller.signal)
            .maybeSingle(),
          loadTeachingSkills(userId),
          loadLearningSkills(userId),
        ]);
        if (!alive || controller.signal.aborted) return;

        canPersistRef.current = true;
        const nextAvatarPath = p?.avatar_url ?? null;
        setProfile((current) => {
          // Don't yank the form out from under someone mid-edit: when there are
          // unsaved changes, keep the baseline they started from and let Save
          // reconcile. The avatar pointer still refreshes.
          const keepText = Boolean(current) && nameBioDirtyRef.current;
          return {
            full_name: keepText ? current!.full_name : (p?.full_name ?? ""),
            bio: keepText ? current!.bio : (p?.bio ?? ""),
            avatar_path: nextAvatarPath,
            // Same photo as the one already on screen? Keep its signed URL.
            // Blanking it here made the avatar vanish and pop back on every
            // background revalidation.
            avatar_url:
              current && current.avatar_path === nextAvatarPath ? current.avatar_url : null,
          };
        });
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

        if (!nextAvatarPath) return;
        const signedAvatarUrl = await signSingleAvatarUrl(nextAvatarPath, AVATAR_TRANSFORM).catch(
          () => null,
        );
        if (alive && !controller.signal.aborted && signedAvatarUrl) {
          setProfile((current) =>
            current ? { ...current, avatar_url: signedAvatarUrl } : current,
          );
        }
      } catch (error) {
        // Silently swallow any cancellation/abort signal - these fire whenever
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
        canPersistRef.current = false;
        // A failed revalidation must not wipe content the snapshot already
        // painted - only fall back to the empty shell when there is nothing.
        setProfile(
          (current) => current ?? { full_name: "", bio: "", avatar_path: null, avatar_url: null },
        );
        toast.error(error instanceof Error ? error.message : "Could not load profile");
      }
    })();

    // Phase 2 - the verified ticks. Cheap, visible above the fold, and each
    // lands independently of the other.
    settle(loadSkillVerifications(userId), setVerifications);
    settle(loadVerificationCooldowns(userId), setVerificationCooldowns);

    // Phase 3 - nothing here is on screen when the page opens: the catalog only
    // feeds the "add a skill" combobox and the count only appears inside the
    // delete-account confirmation. Both used to run on every visit, in front of
    // the work that does paint. Wait for an idle frame instead.
    const cancelIdle = whenIdle(() => {
      if (!alive || controller.signal.aborted) return;
      settle(loadSkillsCatalog(), setAllSkills);
      settle(
        supabase
          .from("sessions")
          .select("id", { count: "exact", head: true })
          .or(`teacher_id.eq.${userId},learner_id.eq.${userId}`)
          .in("status", ["pending", "accepted", "active"])
          .abortSignal(controller.signal),
        (res) => setOpenSessionCount(res.count ?? 0),
      );
    });

    return () => {
      alive = false;
      cancelIdle();
      controller.abort();
    };
  }, [userId]);

  // Mirror whatever is on screen into the snapshot. Writing from state rather
  // than from each fetch means local edits - add a skill, change a level, earn
  // a badge - are captured too, so a revisit paints the current page instead of
  // a pre-edit one.
  useEffect(() => {
    if (!userId || !profile || !canPersistRef.current) return;
    writeProfileSnapshot(userId, {
      full_name: profile.full_name,
      bio: profile.bio,
      avatarPath: profile.avatar_path,
      teaching,
      learning,
      verifications: Array.from(verifications.values()),
      cooldowns: Array.from(verificationCooldowns.entries()),
    });
  }, [userId, profile, teaching, learning, verifications, verificationCooldowns]);

  // Catalog lookup only - skills are curated and selection-only, so there is no
  // create path any more.
  //
  // The catalog loads lazily, so what's in state may be a stale snapshot (or
  // nothing yet on a first visit). A name that isn't in the snapshot is far more
  // likely to be a stale cache than a bad pick, so refresh before rejecting it.
  const findSkill = async (name: string): Promise<Skill | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    let catalog = allSkills;
    const match = (list: Skill[]) =>
      list.find((s) => s.name.toLowerCase() === trimmed.toLowerCase()) ?? null;

    const cached = match(catalog);
    if (cached) return cached;

    if (!isSkillsCatalogFresh()) {
      catalog = await loadSkillsCatalog();
      setAllSkills(catalog);
      const refreshed = match(catalog);
      if (refreshed) return refreshed;
    }

    toast.error("Pick a skill from the list.");
    return null;
  };

  const addTeach = async (nameOverride?: string) => {
    if (!user) return;
    const selectedTeachMode = teachMode || "teaching";
    let selectedTeachLevel: SkillLevel = teachLevel || "basic";
    const skill = await findSkill(nameOverride ?? teachInput);
    if (!skill) return;
    const existing = teaching.find((t) => t.skill.id === skill.id);
    if (existing) {
      const focus = teachFocusInput.trim();
      setStoredSkillFocus(user.id, "teaching", existing.id, focus);
      setTeaching(teaching.map((t) => (t.id === existing.id ? { ...t, focus } : t)));
      setTeachInput("");
      setTeachFocusInput("");
      setTeachMode("");
      setTeachLevel("");
      return;
    }
    // Keep teaching at least one level below the same skill on the learn side
    // (e.g. learning Guitar at intermediate ⇒ teach basic only).
    const learnedSame = learning.find((l) => l.skill.id === skill.id);
    if (learnedSame) {
      const maxRank = levelRank(learnedSame.current_level) - 1;
      if (maxRank < levelRank("basic")) {
        toast.error(
          `You're learning ${skill.name} at basic level, so teach it only once you're past the level you're learning.`,
        );
        return;
      }
      if (levelRank(selectedTeachLevel) > maxRank) selectedTeachLevel = LEVEL_ORDER[maxRank];
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
    let { data, error } = result;
    // Double-submit race on the (user, skill) unique constraint - the row
    // already exists, so adopt it instead of surfacing a conflict error.
    if (error?.code === "23505") {
      const { data: raced } = await supabase
        .from("user_teaching_skills")
        .select("id")
        .eq("user_id", user.id)
        .eq("skill_id", skill.id)
        .maybeSingle();
      if (raced) {
        data = raced;
        error = null;
      }
    }
    if (error || !data)
      return toast.error(error?.message ?? "Couldn't add that skill. Please try again.");
    const newRow = data;
    if (!methodSavedInDatabase) {
      setStoredSkillMethod(user.id, "teaching", newRow.id, selectedTeachMode);
    }
    const focus = teachFocusInput.trim();
    setStoredSkillFocus(user.id, "teaching", newRow.id, focus);
    setTeaching((prev) =>
      prev.some((t) => t.id === newRow.id)
        ? prev
        : [
            ...prev,
            {
              id: newRow.id,
              skill,
              focus,
              level: selectedTeachLevel,
              teaching_mode: selectedTeachMode,
            },
          ],
    );
    setTeachInput("");
    setTeachFocusInput("");
    setTeachMode("");
    setTeachLevel("");
    void invalidateAiSuggestionsCache();
    // Explore/dashboard rankings key off teaching skills - drop their snapshots.
    invalidatePageCaches(user.id);
  };

  const addLearn = async (nameOverride?: string) => {
    if (!user) return;
    const selectedLearnMode = learnMode || "teaching";
    let selectedLearnLevel: SkillLevel = learnLevel || "basic";
    const skill = await findSkill(nameOverride ?? learnInput);
    if (!skill) return;
    const existing = learning.find((t) => t.skill.id === skill.id);
    if (existing) {
      const focus = learnFocusInput.trim();
      setStoredSkillFocus(user.id, "learning", existing.id, focus);
      setLearning(learning.map((t) => (t.id === existing.id ? { ...t, focus } : t)));
      setLearnInput("");
      setLearnFocusInput("");
      setLearnMode("");
      setLearnLevel("");
      return;
    }
    // Learning must be at least one level above the same skill on the teach side
    // (e.g. teaching basic ⇒ learn intermediate/advanced, never basic).
    const taughtSame = teaching.find((t) => t.skill.id === skill.id);
    if (taughtSame) {
      const minRank = levelRank(taughtSame.level) + 1;
      if (minRank > levelRank("advanced")) {
        toast.error(
          `You already teach ${skill.name} at advanced level, and there's no higher level to learn.`,
        );
        return;
      }
      if (levelRank(selectedLearnLevel) < minRank) selectedLearnLevel = LEVEL_ORDER[minRank];
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
    let { data, error } = result;
    // Same double-submit recovery as addTeach.
    if (error?.code === "23505") {
      const { data: raced } = await supabase
        .from("user_learning_skills")
        .select("id")
        .eq("user_id", user.id)
        .eq("skill_id", skill.id)
        .maybeSingle();
      if (raced) {
        data = raced;
        error = null;
      }
    }
    if (error || !data)
      return toast.error(error?.message ?? "Couldn't add that skill. Please try again.");
    const newRow = data;
    if (!methodSavedInDatabase) {
      setStoredSkillMethod(user.id, "learning", newRow.id, selectedLearnMode);
    }
    const focus = learnFocusInput.trim();
    setStoredSkillFocus(user.id, "learning", newRow.id, focus);
    setLearning((prev) =>
      prev.some((t) => t.id === newRow.id)
        ? prev
        : [
            ...prev,
            {
              id: newRow.id,
              skill,
              focus,
              current_level: selectedLearnLevel,
              learning_mode: selectedLearnMode,
            },
          ],
    );
    setLearnInput("");
    setLearnFocusInput("");
    setLearnMode("");
    setLearnLevel("");
    void invalidateAiSuggestionsCache();
    invalidatePageCaches(user.id);
  };

  const removeTeach = async (id: string) => {
    const skillId = teaching.find((t) => t.id === id)?.skill.id;
    const { error } = await supabase.from("user_teaching_skills").delete().eq("id", id);
    if (error) return toastError(error);
    setTeaching((prev) => prev.filter((t) => t.id !== id));
    // A DB trigger retires the badge along with the skill - mirror that here so
    // the panel doesn't keep showing a tick for a skill that's gone.
    if (skillId) {
      setVerifications((prev) => {
        if (!prev.has(skillId)) return prev;
        const next = new Map(prev);
        next.delete(skillId);
        return next;
      });
    }
    void invalidateAiSuggestionsCache();
    invalidatePageCaches(user?.id);
  };
  const removeLearn = async (id: string) => {
    const { error } = await supabase.from("user_learning_skills").delete().eq("id", id);
    if (error) return toastError(error);
    setLearning((prev) => prev.filter((t) => t.id !== id));
    void invalidateAiSuggestionsCache();
    invalidatePageCaches(user?.id);
  };

  const updateTeachLevel = async (id: string, level: string) => {
    const lvl = level as "basic" | "intermediate" | "advanced";
    const row = teaching.find((t) => t.id === id);
    // Teaching must stay at least one level below the same skill on the learn
    // side, so a user can't set teach and learn to the same level.
    const learnedSame = row && learning.find((l) => l.skill.id === row.skill.id);
    if (learnedSame && levelRank(lvl) >= levelRank(learnedSame.current_level)) {
      toast.error(
        `You're learning ${row!.skill.name} at ${learnedSame.current_level} level. Teach it below the level you're learning.`,
      );
      return;
    }
    const { error } = await supabase
      .from("user_teaching_skills")
      .update({ level: lvl })
      .eq("id", id);
    if (error) return toastError(error);
    setTeaching((prev) => prev.map((t) => (t.id === id ? { ...t, level: lvl } : t)));
    // Mirrors the sync_skill_verification_level trigger: claiming a HIGHER
    // level than you tested at drops the badge (re-test required); lowering it
    // keeps the badge, pinned to the weaker claim.
    if (row) {
      const skillId = row.skill.id;
      const rank = (value: string) => (value === "advanced" ? 3 : value === "intermediate" ? 2 : 1);
      setVerifications((prev) => {
        const existing = prev.get(skillId);
        if (!existing) return prev;
        const next = new Map(prev);
        if (rank(lvl) > rank(row.level)) {
          next.delete(skillId);
          toast.info(`Verification for ${row.skill.name} was reset. Re-take the quiz at ${lvl}.`);
        } else {
          next.set(skillId, { ...existing, level: lvl });
        }
        return next;
      });
    }
    invalidatePageCaches(user?.id);
  };
  const updateLearnLevel = async (id: string, level: string) => {
    const lvl = level as "basic" | "intermediate" | "advanced";
    const row = learning.find((t) => t.id === id);
    // Learning must stay at least one level above the same skill on the teach
    // side (mirror of the guard in updateTeachLevel).
    const taughtSame = row && teaching.find((t) => t.skill.id === row.skill.id);
    if (taughtSame && levelRank(lvl) <= levelRank(taughtSame.level)) {
      toast.error(
        `You teach ${row!.skill.name} at ${taughtSame.level} level. Learn it above the level you teach.`,
      );
      return;
    }
    const { error } = await supabase
      .from("user_learning_skills")
      .update({ current_level: lvl })
      .eq("id", id);
    if (error) return toastError(error);
    setLearning((prev) => prev.map((t) => (t.id === id ? { ...t, current_level: lvl } : t)));
    invalidatePageCaches(user?.id);
  };

  const updateTeachMode = async (id: string, mode: LearningMode) => {
    const previous = teaching.find((t) => t.id === id)?.teaching_mode;
    if (user) {
      setStoredSkillMethod(user.id, "teaching", id, mode);
    }
    setTeaching((prev) => prev.map((t) => (t.id === id ? { ...t, teaching_mode: mode } : t)));
    const { error } = await supabase
      .from("user_teaching_skills")
      .update({ teaching_mode: mode })
      .eq("id", id);
    if (error) {
      // A missing teaching_mode column (migration drift) is expected - the
      // localStorage fallback above already holds the choice. Anything else
      // means the optimistic flip didn't stick: roll back and tell the user.
      if (error.message.includes("teaching_mode")) return;
      if (previous) {
        setTeaching((prev) =>
          prev.map((t) => (t.id === id ? { ...t, teaching_mode: previous } : t)),
        );
        if (user) setStoredSkillMethod(user.id, "teaching", id, previous);
      }
      toastError(error);
      return;
    }
    invalidatePageCaches(user?.id);
  };

  const updateLearnMode = async (id: string, mode: LearningMode) => {
    const previous = learning.find((t) => t.id === id)?.learning_mode;
    if (user) {
      setStoredSkillMethod(user.id, "learning", id, mode);
    }
    setLearning((prev) => prev.map((t) => (t.id === id ? { ...t, learning_mode: mode } : t)));
    const { error } = await supabase
      .from("user_learning_skills")
      .update({ learning_mode: mode })
      .eq("id", id);
    if (error) {
      // See updateTeachMode: tolerate migration drift, roll back real failures.
      if (error.message.includes("learning_mode")) return;
      if (previous) {
        setLearning((prev) =>
          prev.map((t) => (t.id === id ? { ...t, learning_mode: previous } : t)),
        );
        if (user) setStoredSkillMethod(user.id, "learning", id, previous);
      }
      toastError(error);
      return;
    }
    invalidatePageCaches(user?.id);
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
      toastError(uploadError);
      return;
    }
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ avatar_url: path })
      .eq("id", user.id);
    if (updateError) {
      // The pointer never moved, so the freshly-uploaded object is
      // unreachable - remove it rather than orphaning it in the bucket.
      await supabase.storage
        .from("avatars")
        .remove([path])
        .catch(() => null);
      setUploadingAvatar(false);
      return toastError(updateError);
    }
    // Best-effort cleanup of the previous avatar object. Failure here must not
    // surface to the user - the new avatar is already saved and live.
    if (previousAvatarPath && previousAvatarPath !== path) {
      await supabase.storage
        .from("avatars")
        .remove([previousAvatarPath])
        .catch(() => null);
    }
    const signedUrl = await signSingleAvatarUrl(path, AVATAR_TRANSFORM);
    setUploadingAvatar(false);
    setProfile({ ...profile, avatar_path: path, avatar_url: signedUrl });
    notifyProfileUpdated();
    invalidatePageCaches(user.id);
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
    if (error) return toastError(error);
    const nextFullName = data.full_name ?? values.full_name;
    const nextBio = data.bio ?? values.bio;
    setProfile({
      full_name: nextFullName,
      bio: nextBio,
      avatar_path: profile.avatar_path,
      avatar_url: profile.avatar_url,
    });
    nameBioRef.current?.reset({ full_name: nextFullName, bio: nextBio });
    handleNameBioDirty(false);
    notifyProfileUpdated();
    void invalidateAiSuggestionsCache();
    invalidatePageCaches(user.id);
    toast.success("Profile updated");
  };

  const deleteAccount = async () => {
    if (!user) return;
    setDeleting(true);
    const { error } = await supabase.rpc("delete_my_account");
    if (error) {
      setDeleting(false);
      toastError(error);
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

  // Levels offered in each "add a skill" form depend on whether the typed skill
  // already sits in the opposite list, matching the onboarding constraint.
  const typedTeachSkillId = allSkills.find(
    (s) => s.name.trim().toLowerCase() === teachInput.trim().toLowerCase(),
  )?.id;
  const teachAddLevels = typedTeachSkillId
    ? allowedLevelsFor(
        learning.find((l) => l.skill.id === typedTeachSkillId)?.current_level,
        "below",
      )
    : LEVEL_ORDER;
  const typedLearnSkillId = allSkills.find(
    (s) => s.name.trim().toLowerCase() === learnInput.trim().toLowerCase(),
  )?.id;
  const learnAddLevels = typedLearnSkillId
    ? allowedLevelsFor(teaching.find((t) => t.skill.id === typedLearnSkillId)?.level, "above")
    : LEVEL_ORDER;

  return (
    <div className="min-h-screen flex flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-[18px] sm:px-[18px] md:py-6 space-y-4">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.16),transparent_55%)] pointer-events-none dark:hidden" />
          {/* Dark-only wash - see .hero-wash in styles.css */}
          <div className="hero-wash" />

          <div className="relative p-5 md:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
                Your <span className="gradient-brand-text">Profile</span>
              </h1>
              <div className="flex items-center gap-3">
                <p className="hidden text-xs text-muted-foreground sm:block">
                  {profileProgress === 100 ? (
                    "Your profile is complete. Looking great!"
                  ) : (
                    <>
                      Profile strength ·{" "}
                      <span className="font-medium text-foreground/80">{profileProgress}%</span>
                    </>
                  )}
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
            </div>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-5">
              <div className="relative mx-auto shrink-0 md:mx-0">
                <UserAvatar
                  name={profile.full_name}
                  url={profile.avatar_url}
                  className="h-20 w-20 rounded-2xl ring-2 ring-brand-purple/30 shadow-glow"
                  fallbackClassName="text-2xl rounded-2xl"
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
                <NameBioForm
                  ref={nameBioRef}
                  initialFullName={profile.full_name}
                  initialBio={profile.bio}
                  onDirtyChange={handleNameBioDirty}
                />
              </div>

              <GetVerifiedCard
                teaching={teaching}
                verifications={verifications}
                cooldowns={verificationCooldowns}
                onVerified={(verification) => {
                  setVerifications((prev) =>
                    new Map(prev).set(verification.skill_id, verification),
                  );
                  invalidatePageCaches(user?.id);
                }}
              />
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
                  What could you help someone with? Add your first skill below.
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
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {t.skill.name}
                          </span>
                          {verifications.has(t.skill.id) && (
                            <VerifiedTick className="h-3.5 w-3.5" />
                          )}
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
                            {levelOptionsFor(
                              t.level,
                              learning.find((l) => l.skill.id === t.skill.id)?.current_level,
                              "below",
                            ).map((lvl) => (
                              <SelectItem key={lvl} value={lvl}>
                                {LEVEL_LABELS[lvl]}
                              </SelectItem>
                            ))}
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
                <SkillCombobox
                  skills={allSkills}
                  value={teachInput}
                  onChange={setTeachInput}
                  onCommit={(name) => addTeach(name)}
                  excludeIds={teaching.map((t) => t.skill.id)}
                  placeholder="Add a skill you teach…"
                />
                <Button
                  variant={teachInput.trim() ? "hero" : "outline"}
                  className="h-10 px-4"
                  onClick={() => addTeach()}
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
                      <SelectValue placeholder="Level: Basic" />
                    </SelectTrigger>
                    <SelectContent>
                      {teachAddLevels.map((lvl) => (
                        <SelectItem key={lvl} value={lvl}>
                          {LEVEL_LABELS[lvl]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={teachMode}
                    onValueChange={(value) => setTeachMode(value as LearningMode)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Method: Direct teaching" />
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
                  What have you always wanted to learn? Add it below and we'll help you find a
                  match.
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
                            {levelOptionsFor(
                              t.current_level,
                              teaching.find((tt) => tt.skill.id === t.skill.id)?.level,
                              "above",
                            ).map((lvl) => (
                              <SelectItem key={lvl} value={lvl}>
                                {LEVEL_LABELS[lvl]}
                              </SelectItem>
                            ))}
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
                                {formatLearningMode(mode, "learning")}
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
                <SkillCombobox
                  skills={allSkills}
                  value={learnInput}
                  onChange={setLearnInput}
                  onCommit={(name) => addLearn(name)}
                  excludeIds={learning.map((l) => l.skill.id)}
                  placeholder="Add a skill you want to learn…"
                />
                <Button
                  variant={learnInput.trim() ? "hero" : "outline"}
                  className="h-10 px-4"
                  onClick={() => addLearn()}
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
                      {learnAddLevels.map((lvl) => (
                        <SelectItem key={lvl} value={lvl}>
                          {LEVEL_LABELS[lvl]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={learnMode}
                    onValueChange={(value) => setLearnMode(value as LearningMode)}
                  >
                    <SelectTrigger className="glass h-10 border-white/10">
                      <SelectValue placeholder="Method: Direct learning" />
                    </SelectTrigger>
                    <SelectContent className="max-h-56 overflow-y-auto">
                      {LEARNING_METHODS.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {formatLearningMode(mode, "learning")}
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
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brand-blue" aria-hidden />
              <h2 className="text-sm font-semibold tracking-wide">Availability</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Let people know when you're usually free, so it's easy to find a time that works for
              both of you.
            </p>
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
