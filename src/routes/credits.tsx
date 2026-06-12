import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageLoading } from "@/components/PageLoading";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import type { Enums } from "@/integrations/supabase/types";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Clock,
  Coins,
  Gift,
  RotateCcw,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
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
  kind: "earned" | "spent" | "bonus" | "refund" | "hold";
  durationMinutes?: number;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
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
    // user?.id is sufficient — the redirect only cares whether a user exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, navigate, user?.id]);

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
      const creditRows = (transactionData ?? []) as unknown as CreditTransaction[];
      // Names come from both the completed-session list and every session
      // referenced by a ledger row (refunds/holds live on cancelled sessions
      // that never appear in completedSessions).
      const participantIds = Array.from(
        new Set([
          ...completedSessions.flatMap((session) => [session.learner_id, session.teacher_id]),
          ...creditRows.flatMap((row) =>
            row.sessions ? [row.sessions.learner_id, row.sessions.teacher_id] : [],
          ),
        ]),
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

      const fromLedger = creditRows.map<TransactionItem>((row) => {
        const session = row.sessions;
        const description = row.description ?? "";
        // Escrow movements: a hold sets credits aside, a refund returns them.
        // Neither is real income/spend — they must not land in the earned card,
        // and a hold+refund pair has to net to zero in the spent card.
        const isRefund = description.startsWith("Refund");
        const isHold = description === "Held for upcoming session";
        // The counterparty is the other participant in the session. For escrow
        // rows one of from_user/to_user is NULL, so derive it from the session.
        const iAmTeacher = session?.teacher_id === user.id;
        const counterpartyId = session
          ? iAmTeacher
            ? session.learner_id
            : session.teacher_id
          : row.from_user === user.id
            ? row.to_user
            : row.from_user;
        const counterpartyName = counterpartyId ? (names.get(counterpartyId) ?? "Student") : null;
        const skillName = session?.skills?.name ?? "a skill";
        const durationMinutes = session?.duration_minutes;

        if (isRefund) {
          return {
            id: row.id,
            title: counterpartyName
              ? `Refund · session with ${counterpartyName}`
              : (row.description ?? "Refund"),
            date: row.created_at,
            amount: Math.abs(row.amount),
            kind: "refund",
            durationMinutes,
            counterpartyId,
            counterpartyName,
          };
        }
        if (isHold) {
          return {
            id: row.id,
            title: counterpartyName
              ? `Reserved for session with ${counterpartyName}`
              : "Held for upcoming session",
            date: row.created_at,
            amount: -Math.abs(row.amount),
            kind: "hold",
            durationMinutes,
            counterpartyId,
            counterpartyName,
          };
        }

        const isEarned = row.to_user === user.id;
        return {
          id: row.id,
          title:
            row.description ??
            (isEarned
              ? `Taught ${skillName} to ${counterpartyName ?? "a student"}`
              : `Learned ${skillName} from ${counterpartyName ?? "a teacher"}`),
          date: row.created_at,
          amount: isEarned ? Math.abs(row.amount) : -Math.abs(row.amount),
          kind: isEarned ? "earned" : "spent",
          durationMinutes,
          counterpartyId,
          counterpartyName,
        };
      });

      const fallbackFromSessions = completedSessions.map<TransactionItem>((session) => {
        const isTeacher = session.teacher_id === user.id;
        const counterpartyId = isTeacher ? session.learner_id : session.teacher_id;
        const otherName = names.get(counterpartyId) ?? "Student";
        const skillName = session.skills?.name ?? "a skill";
        return {
          id: session.id,
          title: isTeacher
            ? `Taught ${skillName} to ${otherName}`
            : `Learned ${skillName} from ${otherName}`,
          date: session.updated_at ?? session.created_at,
          amount: isTeacher ? session.credits : -session.credits,
          kind: isTeacher ? "earned" : "spent",
          durationMinutes: session.duration_minutes,
          counterpartyId,
          counterpartyName: otherName,
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
    // user.id is the only field read above — depending on the whole user object
    // re-created loadCredits on every auth event, which made the
    // useEffect(loadCredits) below refire and double-fetch the page on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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

  // Earned counts teaching income only — refunds (escrow returning your own
  // credits) are not earnings.
  const totalEarned = useMemo(
    () =>
      transactions
        .filter((transaction) => transaction.kind === "earned")
        .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0),
    [transactions],
  );
  // Spent nets holds against their refunds: a cancelled session (hold then
  // refund) collapses to zero, while a completed session's hold stays counted.
  const totalSpent = useMemo(
    () =>
      Math.max(
        0,
        transactions.reduce((sum, transaction) => {
          if (transaction.kind === "spent" || transaction.kind === "hold") {
            return sum + Math.abs(transaction.amount);
          }
          if (transaction.kind === "refund") {
            return sum - Math.abs(transaction.amount);
          }
          return sum;
        }, 0),
      ),
    [transactions],
  );

  if (authLoading || loading || !profile) {
    return <PageLoading variant="hero-stats" />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-[18px] sm:px-[18px] md:py-6">
      <section className="space-y-6">
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          <div className="relative flex flex-col gap-6 p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="flex items-start gap-4">
                <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 ring-1 ring-brand-purple/25">
                  <Coins className="h-5 w-5 text-brand-purple" />
                </div>
                <div>
                  <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                    Your <span className="gradient-brand-text">Credits</span>
                  </h1>
                  <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                    Track your balance, earnings, and every transaction in one place.
                  </p>
                </div>
              </div>
              <Link
                to="/explore"
                preload="intent"
                className="inline-flex items-center gap-2 self-start rounded-full border border-brand-purple/30 bg-brand-purple/10 px-4 py-2 text-sm font-medium text-brand-purple transition-all hover:bg-brand-purple/20 hover:shadow-glow md:self-auto"
              >
                <Sparkles className="h-4 w-4" />
                Earn more
              </Link>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
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
          </div>
        </section>

        <section className="animate-fade-up glass rounded-3xl border border-white/10 p-6 md:p-7">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-cyan/15">
                <Coins className="h-4 w-4 text-brand-cyan" />
              </div>
              <h2 className="text-lg font-semibold leading-tight">Transaction History</h2>
            </div>
            <Link
              to="/history"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {sortedTransactions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-10 text-center">
                <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-purple/15">
                  <Coins className="h-5 w-5 text-brand-purple" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">No credit activity yet</h3>
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
  const toneStyles = {
    balance: {
      value: "text-brand-purple",
      badge: "bg-brand-purple/15 text-brand-purple ring-1 ring-brand-purple/20",
      hover: "hover:border-brand-purple/30 hover:shadow-glow",
    },
    earned: {
      value: "text-emerald-400",
      badge: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
      hover: "hover:border-brand-cyan/30 hover:shadow-glow-blue",
    },
    spent: {
      value: "text-orange-400",
      badge: "bg-orange-400/15 text-orange-400 ring-1 ring-orange-400/20",
      hover: "hover:border-orange-400/30",
    },
  }[tone];

  return (
    <article
      className={cn(
        "group rounded-2xl border border-white/10 bg-white/5 px-5 py-4 transition-all hover:-translate-y-0.5 sm:px-5 sm:py-5",
        toneStyles.hover,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          <div
            className={cn(
              "mt-2 flex items-baseline gap-1 text-4xl font-bold leading-none sm:text-5xl",
              toneStyles.value,
            )}
          >
            {value}
            <span className="text-sm font-medium text-muted-foreground">Credits</span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{caption}</p>
        </div>
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-110",
            toneStyles.badge,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </article>
  );
}

function TransactionRow({ transaction }: { transaction: TransactionItem }) {
  const isPositive = transaction.amount > 0;
  const styles = {
    earned: {
      badge: "bg-brand-cyan/15 text-brand-cyan ring-1 ring-brand-cyan/20",
      amount: "text-emerald-400",
      hover: "hover:border-brand-cyan/30",
    },
    spent: {
      badge: "bg-orange-400/15 text-orange-400 ring-1 ring-orange-400/20",
      amount: "text-orange-400",
      hover: "hover:border-orange-400/30",
    },
    refund: {
      badge: "bg-emerald-400/15 text-emerald-400 ring-1 ring-emerald-400/20",
      amount: "text-emerald-400",
      hover: "hover:border-emerald-400/30",
    },
    hold: {
      badge: "bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/20",
      amount: "text-muted-foreground",
      hover: "hover:border-amber-400/30",
    },
    bonus: {
      badge: "bg-brand-purple/15 text-brand-purple ring-1 ring-brand-purple/20",
      amount: "text-brand-purple",
      hover: "hover:border-brand-purple/30",
    },
  }[transaction.kind];
  const Icon =
    transaction.kind === "bonus"
      ? Gift
      : transaction.kind === "refund"
        ? RotateCcw
        : transaction.kind === "hold"
          ? Clock
          : isPositive
            ? ArrowDownLeft
            : ArrowUpRight;

  const clickable = Boolean(transaction.counterpartyId);

  const body = (
    <>
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-transform group-hover:scale-110",
          styles.badge,
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold sm:text-base">{transaction.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
          {formatDate(transaction.date)}
          {transaction.durationMinutes != null && (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              {transaction.durationMinutes} min
            </>
          )}
          {transaction.counterpartyName && (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              with {transaction.counterpartyName}
            </>
          )}
        </p>
      </div>
      <div className={cn("text-lg font-bold sm:text-xl", styles.amount)}>
        {isPositive ? "+" : "−"}
        {Math.abs(transaction.amount)}
      </div>
      {clickable && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
      )}
    </>
  );

  const className = cn(
    "group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5 transition-all hover:bg-white/[0.07] sm:px-5",
    styles.hover,
  );

  if (clickable && transaction.counterpartyId) {
    return (
      <Link
        to="/users/$userId"
        params={{ userId: transaction.counterpartyId }}
        preload="intent"
        className={className}
      >
        {body}
      </Link>
    );
  }

  return <article className={className}>{body}</article>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
