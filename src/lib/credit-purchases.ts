// Buying credits — everything the /credits/buy page needs that isn't markup.
//
// The payment step is a simulation: there is no merchant account, so the page
// renders a demo QR and then asks the database to settle the intent. What is
// real is the shape of the flow — one server-priced intent per checkout, a
// reference the user can read back, and an idempotent settle call — so swapping
// in a live eSewa/Khalti verification later touches the migration and this
// file's confirmCreditPurchase, and nothing else.
//
// See supabase/migrations/20260726000000_buy_credits_esewa_khalti.sql.

import { supabase } from "@/integrations/supabase/client";

export type PaymentMethod = "esewa" | "khalti";

export type CreditPackage = {
  id: string;
  slug: string;
  name: string;
  credits: number;
  amount_paisa: number;
  tagline: string | null;
  sort_order: number;
};

export type CheckoutIntent = {
  purchaseId: string;
  reference: string;
  method: PaymentMethod;
  credits: number;
  amountPaisa: number;
  expiresAt: string;
};

export type ConfirmOutcome =
  | "granted"
  | "already_granted"
  | "expired"
  | "unknown"
  | "canceled"
  | "failed"
  | "refunded"
  | "initiated"
  | "pending";

export type ConfirmResult = {
  outcome: ConfirmOutcome;
  creditsGranted: number;
  newBalance: number | null;
};

// Wallet presentation. Both are Nepali wallets that settle in NPR, which is why
// prices are held in paisa rather than the dollars the landing page quotes for
// the platform fee. `deeplink` is the scheme each app really uses, so the demo
// QR encodes something shaped like the genuine article.
export const PAYMENT_METHODS: Record<
  PaymentMethod,
  {
    label: string;
    blurb: string;
    // Brand colours, kept as literals rather than theme tokens: eSewa green and
    // Khalti purple are the whole point of recognising the button.
    accent: string;
    tint: string;
    ring: string;
    deeplink: string;
  }
> = {
  esewa: {
    label: "eSewa",
    blurb: "Scan with the eSewa app",
    accent: "#60BB46",
    tint: "rgba(96, 187, 70, 0.12)",
    ring: "rgba(96, 187, 70, 0.35)",
    deeplink: "esewa://pay",
  },
  khalti: {
    label: "Khalti",
    blurb: "Scan with the Khalti app",
    accent: "#5C2D91",
    tint: "rgba(139, 92, 246, 0.14)",
    ring: "rgba(139, 92, 246, 0.38)",
    deeplink: "khalti://pay",
  },
};

export const PAYMENT_METHOD_ORDER: readonly PaymentMethod[] = ["esewa", "khalti"];

// "225" rather than "225.00" — every seeded package is a whole rupee, and the
// decimals only add noise. Paisa still round-trips if a price ever needs them.
export function rupees(paisa: number): string {
  const amount = paisa / 100;
  return amount.toLocaleString("en-NP", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// The same figure with its unit, for anywhere the "Rs" isn't already rendered
// separately (the hero tile prints its own prefix).
export function formatNpr(paisa: number): string {
  return `Rs ${rupees(paisa)}`;
}

// "Rs 9.00 per credit" — the line that makes a bigger package look like the
// deal it is.
export function formatPerCredit(pkg: CreditPackage): string {
  return `${formatNpr(Math.round(pkg.amount_paisa / pkg.credits))} / credit`;
}

// How much cheaper a credit is here than in the smallest package on offer.
// Returns null for the baseline package (and anything not actually cheaper) so
// callers can skip the badge rather than print "Save 0%".
export function savingsPercent(pkg: CreditPackage, all: CreditPackage[]): number | null {
  const baseline = all.reduce<CreditPackage | null>(
    (cheapest, candidate) =>
      !cheapest || candidate.amount_paisa < cheapest.amount_paisa ? candidate : cheapest,
    null,
  );
  if (!baseline || baseline.id === pkg.id) return null;
  const baseRate = baseline.amount_paisa / baseline.credits;
  const rate = pkg.amount_paisa / pkg.credits;
  const saved = Math.round((1 - rate / baseRate) * 100);
  return saved >= 1 ? saved : null;
}

// What the demo QR encodes. Shaped like a wallet deep link so scanning it with
// a phone camera shows something that reads as a payment request, and so the
// reference stays visible to anyone reconciling by hand.
export function paymentPayload(intent: CheckoutIntent): string {
  const method = PAYMENT_METHODS[intent.method];
  const params = new URLSearchParams({
    pid: intent.reference,
    amt: (intent.amountPaisa / 100).toFixed(2),
    scd: "SKILLSWAP-DEMO",
  });
  return `${method.deeplink}?${params.toString()}`;
}

export async function fetchCreditPackages(): Promise<CreditPackage[]> {
  const { data, error } = await supabase
    .from("credit_packages")
    .select("id, slug, name, credits, amount_paisa, tagline, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function beginCreditPurchase(
  packageSlug: string,
  method: PaymentMethod,
): Promise<CheckoutIntent> {
  const { data, error } = await supabase.rpc("begin_credit_purchase", {
    p_package_slug: packageSlug,
    p_method: method,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("Could not start the payment. Please try again.");
  return {
    purchaseId: row.purchase_id,
    reference: row.reference,
    method: row.method as PaymentMethod,
    credits: row.credits,
    amountPaisa: row.amount_paisa,
    expiresAt: row.expires_at,
  };
}

export async function confirmCreditPurchase(purchaseId: string): Promise<ConfirmResult> {
  const { data, error } = await supabase.rpc("confirm_credit_purchase", {
    p_purchase_id: purchaseId,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("Could not confirm the payment. Please try again.");
  return {
    outcome: row.outcome as ConfirmOutcome,
    creditsGranted: row.credits_granted,
    newBalance: row.new_balance,
  };
}

// Fire-and-forget on closing the payment panel — the intent expires on its own
// anyway, so a failure here is not worth a toast.
export async function cancelCreditPurchase(purchaseId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_credit_purchase", { p_purchase_id: purchaseId });
  if (error) throw error;
}

// Copy for every confirm outcome that isn't a success, so the page never has to
// fall back to "something went wrong".
export function describeConfirmFailure(outcome: ConfirmOutcome): string {
  switch (outcome) {
    case "expired":
      return "This payment window closed. Start a new checkout to try again.";
    case "canceled":
      return "This checkout was cancelled. Start a new one to try again.";
    case "refunded":
      return "This payment was refunded, so no credits were added.";
    case "unknown":
      return "We couldn't find that payment. Start a new checkout to try again.";
    default:
      return "The payment didn't go through. No credits were added.";
  }
}
