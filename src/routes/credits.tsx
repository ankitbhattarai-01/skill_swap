import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import type { Enums } from "@/integrations/supabase/types";
import { ArrowDownLeft, ArrowUpRight, Coins, Gift, TrendingDown, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

export const Route = createFileRoute("/credits")({
  head: () => ({ meta: [{ title: "Credits - SkillSwap" }] }),
  component: CreditsPage,
});

type Profile = {
  full_name: string | null;
  credits: number;
  created_at: string;
};

type SessionStatus = Enums<"session_status">;

type CompletedSession = {
  id: string;
  learner_id: string;
  teacher_id: string;
  credits: number;
  duration_minutes: number;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  skills: { name: string } | null;
};

type CreditTransaction = {
  id: string;
  amount: number;
  created_at: string;
  description: string | null;
  from_user: string | null;
  to_user: string | null;
  sessions: {
    learner_id: string;
    teacher_id: string;
    credits: number;
    duration_minutes: number;
    skills: { name: string } | null;
  } | null;
};

type TransactionItem = {
  id: string;
  title: string;
  date: string;
  amount: number;
  kind: "earned" | "spent" | "bonus";
  durationMinutes?: number;
};

function CreditsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { data: liveCreditBalance } = useMyCreditBalance();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/credits" } });
    }
  }, [authLoading, navigate, user]);

  const loadCredits = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [
        { data: profileData, error: profileError },
        { data: creditBalance, error: balanceError },
        { data: transactionData, error: transactionError },
        { data: sessionData, error: sessionError },
      ] = await Promise.all([
        supabase.from("profiles").select("full_name, created_at").eq("id", user.id).maybeSingle(),
        supabase.rpc("my_credit_balance"),
        supabase
          .from("credit_transactions")
          .select(
            "id, amount, created_at, description, from_user, to_user, sessions:session_id(learner_id, teacher_id, credits, duration_minutes, skills:skill_id(name))",
          )
          .or(`from_user.eq.${user.id},to_user.eq.${user.id}`)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("sessions")
          .select(
            "id, learner_id, teacher_id, credits, duration_minutes, status, created_at, updated_at, skills:skill_id(name)",
          )
          .or(`learner_id.eq.${user.id},teacher_id.eq.${user.id}`)
          .eq("status", "completed")
          .order("updated_at", { ascending: false })
          .limit(20),
      ]);

      if (profileError) throw profileError;
      if (balanceError) throw balanceError;
      if (transactionError) throw transactionError;
      if (sessionError) throw sessionError;

      const completedSessions = (sessionData ?? []) as unknown as CompletedSession[];
      const participantIds = Array.from(
        new Set(completedSessions.flatMap((session) => [session.learner_id, session.teacher_id])),
      );
      const names = new Map<string, string>();
      if (participantIds.length) {
        const { data: people } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", participantIds);
        for (const person of people ?? []) {
          names.set(person.id, person.full_name ?? "Student");
        }
      }

      const creditRows = (transactionData ?? []) as unknown as CreditTransaction[];
      const fromLedger = creditRows.map((row) => {
        const isEarned = row.to_user === user.id;
        const session = row.sessions;
        const otherUserId = isEarned ? session?.learner_id : session?.teacher_id;
        const otherName = otherUserId ? (names.get(otherUserId) ?? "Student") : "SkillSwap";
        const skillName = session?.skills?.name ?? "a skill";
        return {
          id: row.id,
          title:
            row.description ??
            (isEarned
              ? `Taught ${skillName} to ${otherName}`
              : `Learned ${skillName} from ${otherName}`),
          date: row.created_at,
          amount: isEarned ? Math.abs(row.amount) : -Math.abs(row.amount),
          kind: isEarned ? ("earned" as const) : ("spent" as const),
          durationMinutes: session?.duration_minutes,
        };
      });

      const fallbackFromSessions = completedSessions.map((session) => {
        const isTeacher = session.teacher_id === user.id;
        const otherName =
          names.get(isTeacher ? session.learner_id : session.teacher_id) ?? "Student";
        const skillName = session.skills?.name ?? "a skill";
        return {
          id: session.id,
          title: isTeacher
            ? `Taught ${skillName} to ${otherName}`
            : `Learned ${skillName} from ${otherName}`,
          date: session.updated_at ?? session.created_at,
          amount: isTeacher ? session.credits : -session.credits,
          kind: isTeacher ? ("earned" as const) : ("spent" as const),
          durationMinutes: session.duration_minutes,
        };
      });

      const profileRow: Profile = profileData
        ? {
            full_name: (profileData as { full_name: string | null }).full_name,
            credits: creditBalance ?? 0,
            created_at: (profileData as { created_at: string }).created_at,
          }
        : {
            full_name: null,
            credits: creditBalance ?? 0,
            created_at: new Date().toISOString(),
          };
      const bonus: TransactionItem = {
        id: "welcome-bonus",
        title: "Welcome bonus for new users",
        date: profileRow.created_at,
        amount: 10,
        kind: "bonus",
      };

      setProfile(profileRow);
      setTransactions([...(fromLedger.length ? fromLedger : fallbackFromSessions), bonus]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load credits");
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadCredits();
  }, [loadCredits]);

  // complete_session writes ledger rows for both legs in the same transaction,
  // so we'd otherwise refetch the whole transactions list twice. Debouncing
  // collapses those into one reload.
  const debouncedReloadCredits = useDebouncedCallback(() => {
    void loadCredits();
  }, 250);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`credits-page-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "credit_transactions",
          filter: `from_user=eq.${user.id}`,
        },
        () => debouncedReloadCredits(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "credit_transactions",
          filter: `to_user=eq.${user.id}`,
        },
        () => debouncedReloadCredits(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [debouncedReloadCredits, user]);

  const sortedTransactions = useMemo(
    () =>
      [...transactions]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 5),
    [transactions],
  );

  const totalEarned = useMemo(
    () =>
      transactions
        .filter((transaction) => transaction.kind === "earned")
        .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0),
    [transactions],
  );
  const totalSpent = useMemo(
    () =>
      transactions
        .filter((transaction) => transaction.kind === "spent")
        .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0),
    [transactions],
  );

  if (authLoading || loading || !profile) {
    return <PageLoading />;
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-[18px] sm:px-[18px] md:py-6">
      <section className="space-y-7">
        <div>
          <h1 className="text-3xl font-bold tracking-normal text-foreground sm:text-4xl">
            Your <span className="text-primary">Credits</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Track your credits and transactions
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <SummaryCard
            label="Current Balance"
            value={liveCreditBalance ?? profile.credits}
            caption="Available to spend"
            tone="balance"
            icon={Coins}
          />
          <SummaryCard
            label="Recent Earned"
            value={totalEarned}
            caption="From your last 20 entries"
            tone="earned"
            icon={TrendingUp}
          />
          <SummaryCard
            label="Recent Spent"
            value={totalSpent}
            caption="From your last 20 entries"
            tone="spent"
            icon={TrendingDown}
          />
        </div>

        <section className="rounded-3xl bg-card px-5 py-6 shadow-card sm:px-7">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Gift className="h-5 w-5 text-primary" />
            How Credits Work
          </h2>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <HowItWorksCard
              title="Earn Credits"
              description="Teach your skills to others and earn credits for each completed session."
              tone="earned"
              icon={ArrowDownLeft}
            />
            <HowItWorksCard
              title="Spend Credits"
              description="Use your credits to book sessions and learn new skills from peers."
              tone="spent"
              icon={ArrowUpRight}
            />
            <HowItWorksCard
              title="Bonus Credits"
              description="Get bonus credits for completing challenges, referrals, and achievements."
              tone="bonus"
              icon={Gift}
            />
          </div>
        </section>

        <section className="rounded-3xl bg-card px-5 py-6 shadow-card sm:px-7">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xl font-bold">
              <Coins className="h-5 w-5 text-primary" />
              Transaction History
            </h2>
            <Link
              to="/history"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              View All
            </Link>
          </div>

          <div className="mt-6 space-y-4">
            {sortedTransactions.length === 0 ? (
              <div className="rounded-3xl bg-secondary/60 px-5 py-10 text-center">
                <Coins className="mx-auto h-8 w-8 text-muted-foreground" />
                <h3 className="mt-3 text-lg font-bold">No credit activity yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Complete a session to see earned and spent credits here.
                </p>
              </div>
            ) : (
              sortedTransactions.map((transaction) => (
                <TransactionRow key={transaction.id} transaction={transaction} />
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function SummaryCard({
  label,
  value,
  caption,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  caption: string;
  tone: "balance" | "earned" | "spent";
  icon: LucideIcon;
}) {
  const valueClass = {
    balance: "text-primary",
    earned: "text-emerald-500",
    spent: "text-orange-500",
  }[tone];
  const iconClass = {
    balance: "text-primary bg-primary/10 shadow-[0_20px_55px_-28px_rgb(124_58_237_/_0.8)]",
    earned: "text-emerald-500 bg-emerald-500/10",
    spent: "text-orange-500 bg-orange-500/10",
  }[tone];

  return (
    <article className="rounded-3xl bg-card px-6 py-7 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div
            className={cn(
              "mt-3 flex items-center gap-2 text-5xl font-bold leading-none",
              valueClass,
            )}
          >
            {value}
            {tone === "balance" ? (
              <Coins className="h-8 w-8" />
            ) : tone === "earned" ? (
              <TrendingUp className="h-7 w-7" />
            ) : (
              <TrendingDown className="h-7 w-7" />
            )}
          </div>
          <p className="mt-5 text-sm text-muted-foreground">{caption}</p>
        </div>
        <div
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-full",
            iconClass,
          )}
        >
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </article>
  );
}

function HowItWorksCard({
  title,
  description,
  tone,
  icon: Icon,
}: {
  title: string;
  description: string;
  tone: "earned" | "spent" | "bonus";
  icon: LucideIcon;
}) {
  const styles = {
    earned: "bg-emerald-500/10 text-emerald-500",
    spent: "bg-orange-500/10 text-orange-500",
    bonus: "bg-primary/10 text-primary",
  }[tone];

  return (
    <article className="rounded-3xl bg-secondary/60 px-5 py-5">
      <div className={cn("flex h-12 w-12 items-center justify-center rounded-full", styles)}>
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-5 text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </article>
  );
}

function TransactionRow({ transaction }: { transaction: TransactionItem }) {
  const isPositive = transaction.amount > 0;
  const styles = {
    earned: "bg-emerald-500/10 text-emerald-500",
    spent: "bg-orange-500/10 text-orange-500",
    bonus: "bg-primary/10 text-primary",
  }[transaction.kind];
  const Icon = transaction.kind === "bonus" ? Gift : isPositive ? ArrowDownLeft : ArrowUpRight;

  return (
    <article className="flex items-center gap-4 rounded-3xl bg-secondary/60 px-5 py-5">
      <div
        className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", styles)}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-bold sm:text-lg">{transaction.title}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {formatDate(transaction.date)}
          {transaction.durationMinutes != null && ` · ${transaction.durationMinutes} min`}
        </p>
      </div>
      <div className={cn("text-xl font-bold", isPositive ? "text-emerald-500" : "text-orange-500")}>
        {isPositive ? "+" : "-"}
        {Math.abs(transaction.amount)}
      </div>
    </article>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
