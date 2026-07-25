-- =============================================================================
-- Buying credits — package catalogue, checkout intents, and the demo
-- eSewa / Khalti gateway behind /credits/buy.
--
-- Until now every credit came from teaching, the welcome bonus, or an escrow
-- refund. This adds the last source: paying for them.
--
-- READ THIS BEFORE TRUSTING IT WITH REAL MONEY
-- -------------------------------------------------------------------------
-- The payment step here is SIMULATED. The QR the page renders is a demo code,
-- and confirm_credit_purchase() below takes the browser's word that the user
-- paid — it is granted to `authenticated`, so a signed-in user who calls it
-- directly can mint themselves the credits of an intent they opened. That is
-- deliberate for a demo build with no merchant account, and the two caps in
-- begin_credit_purchase() (one open intent per user, 500 credits per rolling
-- day) exist to bound the damage rather than prevent it.
--
-- Going live means exactly one change: revoke EXECUTE on
-- confirm_credit_purchase from `authenticated`, grant it to `service_role`
-- alone, and call it from an Edge Function that has first asked eSewa/Khalti
-- whether that reference really was paid, and for how much. Everything else —
-- the intent row, the price lookup, the idempotency lock, the ledger entry —
-- is already shaped for that and does not move.
--
-- What is *not* simulated, and holds either way:
--   * 20260509020000 revoked UPDATE (credits) on public.profiles from anon and
--     authenticated, so no client can write a balance directly. The RPCs below
--     are SECURITY DEFINER precisely so they can, and they are the only path.
--   * Prices live in credit_packages, never in the client. The browser sends a
--     package slug; the server reads the price. Editing the request body picks
--     a different package, which is the same as clicking a different card.
--   * confirm_credit_purchase locks the intent FOR UPDATE and returns
--     'already_granted' for a row that is already completed, so refreshing the
--     success screen (or double-clicking "I've paid") cannot double-credit.
-- =============================================================================

-- ─── 1. What you can buy ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.credit_packages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  credits      INT  NOT NULL CHECK (credits > 0),
  -- Nepali wallets settle in paisa (Rs 1 = 100 paisa) and reject anything under
  -- Rs 10, so paisa is the unit of record and the client formats for display.
  amount_paisa INT  NOT NULL CHECK (amount_paisa >= 1000),
  -- Optional line on the card ("Most popular").
  tagline      TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_packages ENABLE ROW LEVEL SECURITY;

-- A price list is not a secret, but only signed-in users ever see the buy
-- screen, so anon has no reason to read it.
DROP POLICY IF EXISTS "Active packages are readable" ON public.credit_packages;
CREATE POLICY "Active packages are readable" ON public.credit_packages
  FOR SELECT TO authenticated
  USING (is_active);

REVOKE INSERT, UPDATE, DELETE ON public.credit_packages FROM anon, authenticated;
GRANT SELECT ON public.credit_packages TO authenticated;
GRANT ALL ON public.credit_packages TO service_role;

-- Rs 10 a credit at the smallest size, tapering to Rs 8.33 at the largest, so
-- the bigger cards have something real to show. ON CONFLICT keeps a re-run (or
-- a paste into the SQL editor) from duplicating rows, while still letting a
-- later price change be made by editing the row instead of this seed.
INSERT INTO public.credit_packages (slug, name, credits, amount_paisa, tagline, sort_order)
VALUES
  ('taster',   'Taster',    5, 5000,  NULL,           1),
  ('starter',  'Starter',  10, 10000, NULL,           2),
  ('standard', 'Standard', 25, 22500, 'Most popular', 3),
  ('pro',      'Pro',      60, 50000, 'Best value',   4)
ON CONFLICT (slug) DO NOTHING;

-- ─── 2. One row per checkout attempt ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.credit_purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Kept for reporting if a package is later retired. credits/amount_paisa are
  -- copied at checkout, so a price change never rewrites history.
  package_id        UUID REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  -- Our own reference, shown on the payment panel and encoded in the QR. This
  -- is what a real gateway would receive as the merchant order id.
  purchase_order_id TEXT NOT NULL UNIQUE,
  method            TEXT NOT NULL,
  credits           INT  NOT NULL CHECK (credits > 0),
  amount_paisa      INT  NOT NULL CHECK (amount_paisa > 0),
  status            TEXT NOT NULL DEFAULT 'pending',
  -- An unpaid intent stops being payable after this. Bounds how long a QR on
  -- someone's screen stays good for, same as a real wallet's session.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '15 minutes',
  -- Why a confirmation was refused, when it was.
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- Reconciles a database that already has an earlier draft of this table (the
-- Khalti-only sketch, which had no method/expires_at) with the shape above.
-- No-ops on a table created by the statement above.
ALTER TABLE public.credit_purchases
  ADD COLUMN IF NOT EXISTS package_id     UUID REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS method         TEXT,
  ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;

UPDATE public.credit_purchases SET method = 'khalti' WHERE method IS NULL;
UPDATE public.credit_purchases
SET expires_at = created_at + INTERVAL '15 minutes'
WHERE expires_at IS NULL;

ALTER TABLE public.credit_purchases
  ALTER COLUMN method SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT now() + INTERVAL '15 minutes',
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.credit_purchases
  DROP CONSTRAINT IF EXISTS credit_purchases_status_chk,
  DROP CONSTRAINT IF EXISTS credit_purchases_method_chk;

ALTER TABLE public.credit_purchases
  -- 'initiated' is carried for compatibility with the earlier draft; this flow
  -- only ever writes pending → completed / canceled / expired / failed.
  ADD CONSTRAINT credit_purchases_status_chk CHECK (
    status IN ('initiated', 'pending', 'completed', 'failed', 'expired', 'canceled', 'refunded')
  ),
  ADD CONSTRAINT credit_purchases_method_chk CHECK (method IN ('esewa', 'khalti'));

CREATE INDEX IF NOT EXISTS credit_purchases_user_created_idx
  ON public.credit_purchases (user_id, created_at DESC);

DROP TRIGGER IF EXISTS credit_purchases_updated_at ON public.credit_purchases;
CREATE TRIGGER credit_purchases_updated_at BEFORE UPDATE ON public.credit_purchases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;

-- Users can watch their own attempts. Writes belong to the RPCs below, never
-- to a browser.
DROP POLICY IF EXISTS "Users read own credit purchases" ON public.credit_purchases;
CREATE POLICY "Users read own credit purchases" ON public.credit_purchases
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.credit_purchases FROM anon, authenticated;
GRANT SELECT ON public.credit_purchases TO authenticated;
GRANT ALL ON public.credit_purchases TO service_role;

-- ─── 3. Opening a checkout ───────────────────────────────────────────────────
--
-- Called when the user picks a package and a wallet and hits Pay. Returns the
-- reference and amount the payment panel renders (and the QR encodes). Nothing
-- has moved yet — this only records what the user is *about* to pay for, at a
-- price the server chose.

CREATE OR REPLACE FUNCTION public.begin_credit_purchase(
  p_package_slug TEXT,
  p_method       TEXT
)
RETURNS TABLE (
  purchase_id  UUID,
  reference    TEXT,
  method       TEXT,
  credits      INT,
  amount_paisa INT,
  expires_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_method    TEXT := lower(trim(coalesce(p_method, '')));
  v_package   public.credit_packages%ROWTYPE;
  v_reference TEXT;
  v_recent    INT;
  v_row       public.credit_purchases%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_method NOT IN ('esewa', 'khalti') THEN
    RAISE EXCEPTION 'Choose eSewa or Khalti to pay with';
  END IF;

  SELECT * INTO v_package
  FROM public.credit_packages
  WHERE slug = p_package_slug AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That credit package is no longer available';
  END IF;

  -- Sweep the caller's dead intents, then supersede any live one: a person can
  -- only be at one checkout at a time, so opening a new panel abandons the old
  -- QR rather than leaving two references payable.
  --
  -- Aliased because `expires_at` and `credits` are also OUT parameters of this
  -- function, and plpgsql treats an unqualified reference to either as
  -- ambiguous rather than guessing.
  UPDATE public.credit_purchases cp
  SET status = 'expired'
  WHERE cp.user_id = v_user AND cp.status = 'pending' AND cp.expires_at <= now();

  UPDATE public.credit_purchases cp
  SET status = 'canceled', failure_reason = 'superseded by a newer checkout'
  WHERE cp.user_id = v_user AND cp.status = 'pending';

  -- Damage control while the gateway is simulated — see the header. Counts
  -- credits actually granted in the last day, not intents opened.
  SELECT coalesce(sum(cp.credits), 0) INTO v_recent
  FROM public.credit_purchases cp
  WHERE cp.user_id = v_user
    AND cp.status = 'completed'
    AND cp.completed_at > now() - INTERVAL '1 day';

  IF v_recent + v_package.credits > 500 THEN
    RAISE EXCEPTION 'You have reached the daily top-up limit. Try again tomorrow.';
  END IF;

  -- Human-shaped and unique: SSC-260726-A1B2C3D4. Short enough to read off a
  -- screen when reconciling a payment by hand.
  v_reference := 'SSC-' || to_char(now(), 'YYMMDD') || '-'
    || upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8));

  INSERT INTO public.credit_purchases (
    user_id, package_id, purchase_order_id, method, credits, amount_paisa, status
  )
  VALUES (
    v_user, v_package.id, v_reference, v_method,
    v_package.credits, v_package.amount_paisa, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN QUERY SELECT
    v_row.id, v_row.purchase_order_id, v_row.method,
    v_row.credits, v_row.amount_paisa, v_row.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_credit_purchase(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_credit_purchase(TEXT, TEXT) TO authenticated;

-- ─── 4. Settling it ──────────────────────────────────────────────────────────
--
-- The one path from "paid" to "credited". Every branch is terminal and named,
-- so the page can say something specific rather than a generic failure:
--
--   granted          credits added, ledger row written
--   already_granted  a previous call did the work (refresh / double-click)
--   expired          the QR sat too long; open a new checkout
--   unknown          no such intent for this user
--   canceled | failed | refunded | initiated
--                    reported back as-is, nothing granted

CREATE OR REPLACE FUNCTION public.confirm_credit_purchase(p_purchase_id UUID)
RETURNS TABLE (outcome TEXT, credits_granted INT, new_balance INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user     UUID := auth.uid();
  v_purchase public.credit_purchases%ROWTYPE;
  v_balance  INT;
  v_label    TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- FOR UPDATE serialises two confirmations of the same intent — a
  -- double-clicked button, or a refreshed success screen racing the first call.
  SELECT * INTO v_purchase
  FROM public.credit_purchases
  WHERE id = p_purchase_id AND user_id = v_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown'::TEXT, 0, NULL::INT;
    RETURN;
  END IF;

  IF v_purchase.status = 'completed' THEN
    SELECT p.credits INTO v_balance FROM public.profiles p WHERE p.id = v_user;
    RETURN QUERY SELECT 'already_granted'::TEXT, v_purchase.credits, v_balance;
    RETURN;
  END IF;

  IF v_purchase.status <> 'pending' THEN
    RETURN QUERY SELECT v_purchase.status, 0, NULL::INT;
    RETURN;
  END IF;

  IF v_purchase.expires_at <= now() THEN
    UPDATE public.credit_purchases
    SET status = 'expired', failure_reason = 'not confirmed before the checkout expired'
    WHERE id = v_purchase.id;
    RETURN QUERY SELECT 'expired'::TEXT, 0, NULL::INT;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET credits = credits + v_purchase.credits
  WHERE id = v_user
  RETURNING credits INTO v_balance;

  v_label := CASE v_purchase.method WHEN 'esewa' THEN 'eSewa' ELSE 'Khalti' END;

  -- from_user NULL with session_id NULL marks credits entering the system
  -- rather than moving between two students. The 'Credit top-up' prefix is what
  -- /credits matches on to render this as a top-up instead of teaching income —
  -- keep the two in step if you ever reword it.
  INSERT INTO public.credit_transactions (from_user, to_user, amount, session_id, description)
  VALUES (NULL, v_user, v_purchase.credits, NULL, 'Credit top-up · ' || v_label);

  UPDATE public.credit_purchases
  SET status         = 'completed',
      failure_reason = NULL,
      completed_at   = now()
  WHERE id = v_purchase.id;

  RETURN QUERY SELECT 'granted'::TEXT, v_purchase.credits, v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_credit_purchase(UUID) FROM PUBLIC, anon;
-- Simulated gateway: the browser is the caller. See the header for the single
-- grant change that moves this behind real verification.
GRANT EXECUTE ON FUNCTION public.confirm_credit_purchase(UUID) TO authenticated;

-- ─── 5. Backing out ──────────────────────────────────────────────────────────
--
-- Closing the payment panel. Purely tidiness: it keeps an abandoned intent from
-- sitting pending until it expires, so the user's purchase list reads honestly.

CREATE OR REPLACE FUNCTION public.cancel_credit_purchase(p_purchase_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user   UUID := auth.uid();
  v_status TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.credit_purchases
  SET status = 'canceled', failure_reason = 'closed before paying'
  WHERE id = p_purchase_id AND user_id = v_user AND status = 'pending'
  RETURNING status INTO v_status;

  -- Nothing to cancel (already settled, expired, or not the caller's) is not an
  -- error — the caller only wanted it not-pending, and it isn't.
  RETURN coalesce(v_status, 'noop');
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_credit_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_credit_purchase(UUID) TO authenticated;
