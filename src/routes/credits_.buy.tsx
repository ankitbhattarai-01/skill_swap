import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  Coins,
  CreditCard,
  Info,
  Loader2,
  QrCode,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { PageLoading } from "@/components/PageLoading";
import { CreditSummaryCard } from "@/components/CreditSummaryCard";
import { DemoQrCode } from "@/components/DemoQrCode";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/errors";
import { useMyCreditBalance, useInvalidateMyCreditBalance } from "@/hooks/useMyCreditBalance";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_ORDER,
  beginCreditPurchase,
  cancelCreditPurchase,
  confirmCreditPurchase,
  describeConfirmFailure,
  fetchCreditPackages,
  formatNpr,
  formatPerCredit,
  paymentPayload,
  rupees,
  savingsPercent,
  type CheckoutIntent,
  type CreditPackage,
  type PaymentMethod,
} from "@/lib/credit-purchases";

export const Route = createFileRoute("/credits_/buy")({
  head: () => ({ meta: [{ title: "Buy Credits - SkillSwap" }] }),
  component: BuyCreditsPage,
});

// The package the cards land on before the user touches anything. Falls back to
// the first package if the catalogue is ever reseeded without this slug.
const DEFAULT_SLUG = "standard";

type Stage = "choosing" | "paying" | "done";

type Receipt = {
  credits: number;
  balance: number | null;
  amountPaisa: number;
};

function BuyCreditsPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { data: balance } = useMyCreditBalance();
  const invalidateBalance = useInvalidateMyCreditBalance();

  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("esewa");
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Snapshotted rather than read back off `intent`, which is cleared the moment
  // the payment settles — the hero still has to show what was paid.
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/credits/buy" } });
    }
    // user?.id is sufficient — the redirect only cares whether a user exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, navigate, user?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchCreditPackages();
        if (cancelled) return;
        setPackages(rows);
        setSelectedSlug(
          rows.find((row) => row.slug === DEFAULT_SLUG)?.slug ?? rows[0]?.slug ?? null,
        );
      } catch (error) {
        if (!cancelled) toastError(error, "Could not load the credit packages.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => packages.find((row) => row.slug === selectedSlug) ?? null,
    [packages, selectedSlug],
  );

  const stage: Stage = receipt ? "done" : intent ? "paying" : "choosing";

  // Countdown on the open checkout. Ticking off intent.expiresAt rather than
  // counting down a stored number keeps it honest across a backgrounded tab,
  // where interval callbacks get throttled or skipped entirely.
  useEffect(() => {
    if (!intent) {
      setSecondsLeft(0);
      return;
    }
    const deadline = new Date(intent.expiresAt).getTime();
    const tick = () => setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [intent]);

  // Expiry is enforced server-side too (confirm_credit_purchase refuses a stale
  // intent); this just clears the panel instead of leaving a dead QR on screen.
  const expiredRef = useRef(false);
  useEffect(() => {
    if (!intent || secondsLeft > 0) {
      expiredRef.current = false;
      return;
    }
    if (expiredRef.current) return;
    expiredRef.current = true;
    setIntent(null);
    toast.error("That payment window closed. Start a new checkout to try again.");
  }, [intent, secondsLeft]);

  const startPayment = useCallback(async () => {
    if (!selected) return;
    setStarting(true);
    try {
      setIntent(await beginCreditPurchase(selected.slug, method));
    } catch (error) {
      toastError(error, "Could not start the payment.");
    } finally {
      setStarting(false);
    }
  }, [method, selected]);

  const confirmPayment = useCallback(async () => {
    if (!intent) return;
    setConfirming(true);
    try {
      const result = await confirmCreditPurchase(intent.purchaseId);
      if (result.outcome === "granted" || result.outcome === "already_granted") {
        setReceipt({
          credits: result.creditsGranted,
          balance: result.newBalance,
          amountPaisa: intent.amountPaisa,
        });
        setIntent(null);
        // Refreshes the header balance and drops the /credits snapshot, so the
        // top-up is already in the ledger when the user navigates back.
        void invalidateBalance();
        toast.success(`${result.creditsGranted} credits added to your balance.`);
        return;
      }
      setIntent(null);
      toast.error(describeConfirmFailure(result.outcome));
    } catch (error) {
      toastError(error, "Could not confirm the payment.");
    } finally {
      setConfirming(false);
    }
  }, [intent, invalidateBalance]);

  const abandonPayment = useCallback(() => {
    if (!intent) return;
    const { purchaseId } = intent;
    setIntent(null);
    // Tidiness only — an abandoned intent expires on its own, so a failure here
    // is not worth interrupting the user for.
    void cancelCreditPurchase(purchaseId).catch(() => {});
  }, [intent]);

  const buyAgain = useCallback(() => {
    setReceipt(null);
    setIntent(null);
  }, []);

  if (authLoading || loading) {
    return <PageLoading variant="credits-buy" />;
  }

  const currentBalance = receipt?.balance ?? balance ?? 0;
  // Once an intent is open the hero follows it rather than the cards, so the
  // figures on screen always describe the payment actually in flight.
  const pendingCredits = intent?.credits ?? selected?.credits ?? 0;
  const pendingPaisa = intent?.amountPaisa ?? selected?.amount_paisa ?? 0;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-[18px] sm:px-[18px] md:py-6">
      <section className="space-y-6">
        {/* Hero — same construction as the /credits card it was opened from:
            glass-strong shell, light-mode gradient layers, dark-mode wash. */}
        <section className="animate-fade-up relative overflow-hidden rounded-3xl glass-strong border border-white/10 shadow-glow">
          <div className="absolute inset-0 gradient-hero pointer-events-none dark:hidden" />
          <div className="absolute inset-0 bg-[radial-gradient(at_85%_15%,rgba(167,139,250,0.18),transparent_55%)] pointer-events-none dark:hidden" />
          {/* Dark-only wash - see .hero-wash in styles.css */}
          <div className="hero-wash" />
          <div className="relative flex flex-col gap-6 p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="flex items-start gap-4">
                <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-purple/15 ring-1 ring-brand-purple/25">
                  <CreditCard className="h-5 w-5 text-brand-purple" />
                </div>
                <div>
                  <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                    Buy <span className="gradient-brand-text">Credits</span>
                  </h1>
                  <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                    Top up instantly with eSewa or Khalti, then spend them on any peer session.
                  </p>
                </div>
              </div>
              <Link
                to="/credits"
                preload="intent"
                className="inline-flex items-center gap-2 self-start rounded-full border border-brand-purple/30 bg-brand-purple/10 px-4 py-2 text-sm font-medium text-brand-purple transition-all hover:bg-brand-purple/20 hover:shadow-glow md:self-auto"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to credits
              </Link>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <CreditSummaryCard
                label="Current Balance"
                value={currentBalance}
                caption="Available to spend"
                tone="balance"
                icon={Coins}
              />
              <CreditSummaryCard
                label={receipt ? "Just Added" : "After Top-Up"}
                value={receipt ? receipt.credits : currentBalance + pendingCredits}
                caption={
                  receipt
                    ? "Already in your balance"
                    : `${pendingCredits} credits from this purchase`
                }
                tone="earned"
                icon={TrendingUp}
              />
              <CreditSummaryCard
                label={receipt ? "You Paid" : "You Pay"}
                value={rupees(receipt ? receipt.amountPaisa : pendingPaisa)}
                prefix="Rs"
                unit={null}
                caption={receipt ? "Demo payment, nothing charged" : "One-off, no subscription"}
                tone="spent"
                icon={Wallet}
              />
            </div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
          <div className="space-y-6">
            <section className="animate-fade-up glass rounded-3xl border border-white/10 p-6 md:p-7">
              <SectionHeader
                icon={Coins}
                tone="purple"
                title="Choose a package"
                hint="Bigger packages cost less per credit"
              />
              {packages.length === 0 ? (
                <p className="mt-5 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-center text-sm text-muted-foreground">
                  No credit packages are on sale right now. Try again shortly.
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Credit package"
                  className="mt-5 grid gap-3 sm:grid-cols-2"
                >
                  {packages.map((pkg) => (
                    <PackageCard
                      key={pkg.id}
                      pkg={pkg}
                      all={packages}
                      selected={pkg.slug === selectedSlug}
                      disabled={stage !== "choosing"}
                      onSelect={() => setSelectedSlug(pkg.slug)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="animate-fade-up glass rounded-3xl border border-white/10 p-6 md:p-7">
              <SectionHeader
                icon={Wallet}
                tone="cyan"
                title="Pay with"
                hint="Both settle in Nepali rupees"
              />
              <div
                role="radiogroup"
                aria-label="Payment method"
                className="mt-5 grid gap-3 sm:grid-cols-2"
              >
                {PAYMENT_METHOD_ORDER.map((key) => (
                  <MethodCard
                    key={key}
                    method={key}
                    selected={key === method}
                    disabled={stage !== "choosing"}
                    onSelect={() => setMethod(key)}
                  />
                ))}
              </div>
              {stage === "paying" && (
                <p className="mt-4 text-xs text-muted-foreground">
                  Cancel the payment to change your package or wallet.
                </p>
              )}
            </section>
          </div>

          <aside className="lg:sticky lg:top-6">
            {stage === "done" && receipt ? (
              <ReceiptPanel receipt={receipt} onBuyAgain={buyAgain} />
            ) : stage === "paying" && intent ? (
              <PaymentPanel
                intent={intent}
                secondsLeft={secondsLeft}
                confirming={confirming}
                onConfirm={() => void confirmPayment()}
                onCancel={abandonPayment}
              />
            ) : (
              <OrderPanel
                pkg={selected}
                method={method}
                starting={starting}
                onPay={() => void startPayment()}
              />
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function SectionHeader({
  icon: Icon,
  tone,
  title,
  hint,
}: {
  icon: LucideIcon;
  tone: "purple" | "cyan";
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-xl",
            tone === "purple" ? "bg-brand-purple/15" : "bg-brand-cyan/15",
          )}
        >
          <Icon
            className={cn("h-4 w-4", tone === "purple" ? "text-brand-purple" : "text-brand-cyan")}
          />
        </div>
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PackageCard({
  pkg,
  all,
  selected,
  disabled,
  onSelect,
}: {
  pkg: CreditPackage;
  all: CreditPackage[];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const saved = savingsPercent(pkg, all);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      // Same selected-state language as the session-length cards, so picking a
      // package feels like every other choice in the app.
      className={cn(
        "relative flex flex-col items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-all",
        selected
          ? "border-brand-purple/60 bg-brand-purple/10 shadow-glow"
          : "border-border bg-muted hover:border-brand-purple/40 hover:bg-brand-purple/[0.07]",
        disabled && "cursor-not-allowed opacity-60 hover:border-border hover:bg-muted",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {pkg.name}
          </p>
          <p className="mt-1.5 flex items-baseline gap-1 text-3xl font-bold leading-none">
            <span className="tabular-nums">{pkg.credits}</span>
            <span className="text-xs font-medium text-muted-foreground">credits</span>
          </p>
        </div>
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            selected ? "border-brand-purple bg-brand-purple text-white" : "border-border",
          )}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </div>

      <div className="w-full">
        <p className={cn("text-lg font-semibold", selected && "text-brand-purple")}>
          {formatNpr(pkg.amount_paisa)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{formatPerCredit(pkg)}</p>
      </div>

      {(pkg.tagline || saved) && (
        <div className="flex flex-wrap gap-1.5">
          {pkg.tagline && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-purple/15 px-2 py-0.5 text-[11px] font-medium text-brand-purple ring-1 ring-brand-purple/20">
              <Sparkles className="h-3 w-3" />
              {pkg.tagline}
            </span>
          )}
          {saved && (
            <span className="inline-flex items-center rounded-full bg-brand-cyan/15 px-2 py-0.5 text-[11px] font-medium text-brand-cyan ring-1 ring-brand-cyan/20">
              Save {saved}%
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function MethodCard({
  method,
  selected,
  disabled,
  onSelect,
}: {
  method: PaymentMethod;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const wallet = PAYMENT_METHODS[method];

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      // The selected border/tint come from the wallet's own brand colour rather
      // than the app's purple — recognising the wallet is the whole point.
      className={cn(
        "flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all",
        selected ? "shadow-glow" : "border-border bg-muted hover:bg-white/[0.04]",
        disabled && "cursor-not-allowed opacity-60",
      )}
      style={selected ? { borderColor: wallet.ring, backgroundColor: wallet.tint } : undefined}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
        style={{ backgroundColor: wallet.accent }}
      >
        {wallet.label.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{wallet.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{wallet.blurb}</span>
      </span>
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "text-white" : "border-border",
        )}
        style={
          selected ? { backgroundColor: wallet.accent, borderColor: wallet.accent } : undefined
        }
      >
        {selected && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <section className="animate-fade-up glass rounded-3xl border border-white/10 p-6">
      {children}
    </section>
  );
}

function DemoNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-2xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-500 dark:text-amber-300">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function OrderPanel({
  pkg,
  method,
  starting,
  onPay,
}: {
  pkg: CreditPackage | null;
  method: PaymentMethod;
  starting: boolean;
  onPay: () => void;
}) {
  const wallet = PAYMENT_METHODS[method];

  return (
    <PanelShell>
      <h2 className="text-lg font-semibold leading-tight">Order summary</h2>
      <dl className="mt-4 space-y-2.5 text-sm">
        <Line label="Package" value={pkg ? pkg.name : "—"} />
        <Line label="Credits" value={pkg ? `${pkg.credits}` : "—"} />
        <Line label="Wallet" value={wallet.label} />
        <div className="border-t border-white/10 pt-2.5">
          <Line label="Total" value={pkg ? formatNpr(pkg.amount_paisa) : "—"} emphasise />
        </div>
      </dl>

      <Button
        variant="hero"
        size="lg"
        className="mt-5 w-full"
        disabled={!pkg || starting}
        onClick={onPay}
      >
        {starting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Starting…
          </>
        ) : (
          <>
            <QrCode className="h-4 w-4" />
            Pay with {wallet.label}
          </>
        )}
      </Button>

      <div className="mt-4">
        <DemoNote>
          Demo checkout — the QR is generated for this project and no real money moves. Credits are
          added the moment you confirm.
        </DemoNote>
      </div>
    </PanelShell>
  );
}

function PaymentPanel({
  intent,
  secondsLeft,
  confirming,
  onConfirm,
  onCancel,
}: {
  intent: CheckoutIntent;
  secondsLeft: number;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const wallet = PAYMENT_METHODS[intent.method];
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <PanelShell>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Scan to pay</h2>
          <p className="mt-1 text-xs text-muted-foreground">{wallet.blurb}</p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      </div>

      <div className="mt-4 flex justify-center">
        <DemoQrCode
          value={paymentPayload(intent)}
          method={intent.method}
          className="w-full max-w-[236px]"
        />
      </div>

      <dl className="mt-5 space-y-2.5 text-sm">
        <Line label="Amount" value={formatNpr(intent.amountPaisa)} emphasise />
        <Line label="Credits" value={`${intent.credits}`} />
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Reference</dt>
          <dd className="font-mono text-xs font-semibold">{intent.reference}</dd>
        </div>
      </dl>

      <Button
        variant="hero"
        size="lg"
        className="mt-5 w-full"
        disabled={confirming}
        onClick={onConfirm}
      >
        {confirming ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Confirming…
          </>
        ) : (
          <>
            <BadgeCheck className="h-4 w-4" />
            I've paid
          </>
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 w-full"
        disabled={confirming}
        onClick={onCancel}
      >
        Cancel payment
      </Button>

      <div className="mt-4">
        <DemoNote>
          This code is a demo, so there is nothing to scan in the {wallet.label} app. Press
          &ldquo;I&rsquo;ve paid&rdquo; to complete the purchase.
        </DemoNote>
      </div>
    </PanelShell>
  );
}

function ReceiptPanel({
  receipt,
  onBuyAgain,
}: {
  receipt: { credits: number; balance: number | null };
  onBuyAgain: () => void;
}) {
  return (
    <PanelShell>
      <div className="text-center">
        <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-cyan/15 ring-1 ring-brand-cyan/25">
          <BadgeCheck className="h-6 w-6 text-brand-cyan" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Payment complete</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {receipt.credits} credits are in your balance
          {receipt.balance != null ? `, taking you to ${receipt.balance}` : ""}.
        </p>
      </div>

      <Link
        to="/credits"
        preload="intent"
        className="gradient-brand mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-medium text-white shadow-glow transition-all hover:opacity-95 hover:shadow-glow-blue"
      >
        <Coins className="h-4 w-4" />
        Back to credits
      </Link>
      <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={onBuyAgain}>
        Buy more credits
      </Button>
    </PanelShell>
  );
}

function Line({ label, value, emphasise }: { label: string; value: string; emphasise?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold", emphasise && "text-base text-brand-purple")}>{value}</dd>
    </div>
  );
}
