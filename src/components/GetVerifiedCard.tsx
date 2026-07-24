import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SkillVerificationDialog } from "@/components/SkillVerificationDialog";
import { cn } from "@/lib/utils";
import { ShieldCheck } from "lucide-react";
import { VerifiedTick, VERIFIED_BLUE } from "@/components/VerifiedTick";
import { formatRetryWait, type SkillVerification } from "@/lib/skill-verification";

// The "Get verified" panel that sits beside the name/bio form on the profile.
//
// One row per skill the user teaches: unverified skills get a Verify button,
// verified ones get the tick. With no teaching skills there is nothing to
// verify, so the panel says so rather than showing a dead button.

type TeachingSkill = {
  id: string;
  skill: { id: string; name: string };
  level: string;
};

type Props = {
  teaching: TeachingSkill[];
  verifications: Map<string, SkillVerification>;
  cooldowns: Map<string, string>;
  onVerified: (verification: SkillVerification) => void;
};

export function GetVerifiedCard({ teaching, verifications, cooldowns, onVerified }: Props) {
  const [active, setActive] = useState<{ id: string; name: string } | null>(null);
  const verifiedCount = teaching.filter((t) => verifications.has(t.skill.id)).length;

  return (
    <>
      <aside className="glass w-full shrink-0 rounded-2xl border border-white/10 p-4 md:w-64">
        <div className="flex items-center gap-2">
          <ShieldCheck className={cn("h-4 w-4", VERIFIED_BLUE)} />
          <h2 className="text-sm font-semibold">Get verified</h2>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {teaching.length === 0
            ? "Add a skill you teach and you can take a short quiz to earn a verified tick."
            : "Pass a short quiz at the level you teach to earn a tick. Verified skills stand out to learners."}
        </p>

        {teaching.length > 0 && (
          <>
            <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {verifiedCount} of {teaching.length} verified
            </p>
            <ul className="mt-2 space-y-1.5">
              {teaching.map((t) => {
                const verification = verifications.get(t.skill.id);
                const cooldownUntil = cooldowns.get(t.skill.id);
                return (
                  <li
                    key={t.id}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-2.5 py-2",
                      verification
                        ? "border-blue-500/25 bg-blue-500/[0.07]"
                        : "border-white/10 bg-white/[0.03]",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{t.skill.name}</p>
                      {verification ? (
                        <p className={cn("text-[11px]", VERIFIED_BLUE)}>Verified</p>
                      ) : cooldownUntil ? (
                        <p className="text-[11px] text-muted-foreground">
                          Retry in {formatRetryWait(cooldownUntil)}
                        </p>
                      ) : (
                        <p className="text-[11px] capitalize text-muted-foreground">{t.level}</p>
                      )}
                    </div>
                    {verification ? (
                      <VerifiedTick />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 rounded-full px-2.5 text-[11px]"
                        disabled={Boolean(cooldownUntil)}
                        onClick={() => setActive({ id: t.skill.id, name: t.skill.name })}
                        title={
                          cooldownUntil
                            ? `You can retry in about ${formatRetryWait(cooldownUntil)}`
                            : `Take the ${t.skill.name} quiz`
                        }
                      >
                        Verify
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>

      {active && (
        <SkillVerificationDialog
          open
          onOpenChange={(next) => !next && setActive(null)}
          skillId={active.id}
          skillName={active.name}
          onVerified={onVerified}
        />
      )}
    </>
  );
}
