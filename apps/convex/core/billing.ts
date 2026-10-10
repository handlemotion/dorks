// Billing primitives with no Convex or Node dependency (WebCrypto only), so Convex functions, unit tests and the e2e scripts share them.
//
// Model (docs/billing.md): a customer is billed for what their sandboxes cost us at Upstash, plus a markup. Upstash reports a running
// `total_compute_cost_usd` per box. Each metering run sends the growth of that number to a Stripe Billing Meter in micro-USD
// (1 unit = $0.000001 of Upstash cost), and the Stripe price charges `unit_amount_decimal` cents per unit = cost * (1 + markup).

/** Our markup over the Upstash Box cost, in basis points (1 bp = 0.01%). 1500 = 15%. Changing it means a new Stripe price. */
export const MARKUP_BPS = 1500;
export const MICRO_PER_USD = 1_000_000;
/** Stripe meter event name. Fixed: it is part of the meter that the setup script creates. */
export const METER_EVENT_NAME = "dorks_box_cost_micro_usd";
export const PRICE_LOOKUP_KEY = `dorks_box_usage_markup_${MARKUP_BPS}bps`;

/** Upstash reports dollars as a float; the ledger holds whole micro-dollars so sums never drift. */
export const usdToMicro = (usd: number): number => Math.round(usd * MICRO_PER_USD);

/**
 * Stripe `unit_amount_decimal` (cents, at most 12 decimals) for one micro-USD of cost at the given markup.
 * 1 micro-USD = 0.0001 cents, so with a 15% markup: 0.0001 * 1.15 = 0.000115. Done in integers to avoid float noise.
 */
export function unitAmountDecimalCents(markupBps: number = MARKUP_BPS): string {
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 100_000) throw new Error("bad markup");
  // (10000 + bps) / 10000 * 1e-4 cents = (10000 + bps) * 1e-8 cents
  const digits = String(10_000 + markupBps).padStart(9, "0"); // value * 1e-8
  const whole = digits.slice(0, -8) || "0";
  const frac = digits.slice(-8).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** What the customer pays for `costMicro` of Upstash cost, in (fractional) cents, before Stripe rounds the invoice line. */
export const billedCents = (costMicro: number, markupBps: number = MARKUP_BPS): number => (costMicro * (10_000 + markupBps)) / 1e8;

export type UsageWindow = { from: number; to: number };

/** Stripe dedupes meter events by `identifier`; the window is in it, so a retry of the same window can never be counted twice. */
export const meterIdentifier = (boxId: string, w: UsageWindow): string => `${boxId}:${w.from}-${w.to}`;

/** Subscription statuses that keep a customer entitled (and billed). `past_due` still accrues: Stripe is retrying the card. */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;
export const isEntitled = (status: string | undefined | null): boolean => !!status && (ENTITLED_STATUSES as readonly string[]).includes(status);

// --- webhook signatures ---------------------------------------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** Signs a payload the way Stripe does (`Stripe-Signature: t=<unix>,v1=<hmac>`). Used by tests and by the e2e's own deliveries. */
export async function signStripePayload(secret: string, payload: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${nowSec},v1=${await hmacHex(secret, `${nowSec}.${payload}`)}`;
}

/** Verifies `Stripe-Signature` over the raw body. Rejects stale timestamps (replay) and accepts any matching `v1` (Stripe sends several while a secret rolls). */
export async function verifyStripeSignature(secret: string, payload: string, header: string | null, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || sigs.length === 0 || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

// --- webhook events -------------------------------------------------------------------------------------------------------------

export type BillingEvent =
  | { kind: "subscription"; customerId: string; subscriptionId: string; status: string; currentPeriodEndMs?: number; cancelAtPeriodEnd: boolean; userId?: string }
  | { kind: "checkout"; customerId: string; subscriptionId: string; userId?: string };

const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
const idOf = (x: unknown): string | undefined => str(x) ?? str((x as { id?: unknown } | null | undefined)?.id); // an expandable field: id or object

/**
 * The part of a Stripe event dorks acts on, or null for everything else. Newer API versions moved `current_period_end` from the
 * subscription to its items, so both places are read.
 */
export function parseBillingEvent(event: { type?: unknown; data?: { object?: any } }): BillingEvent | null {
  const o = event.data?.object;
  if (!o || typeof o !== "object") return null;
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const customerId = idOf(o.customer);
      const subscriptionId = str(o.id);
      const status = event.type === "customer.subscription.deleted" ? "canceled" : str(o.status);
      if (!customerId || !subscriptionId || !status) return null;
      const end = typeof o.current_period_end === "number" ? o.current_period_end : o.items?.data?.[0]?.current_period_end;
      return {
        kind: "subscription", customerId, subscriptionId, status,
        currentPeriodEndMs: typeof end === "number" ? end * 1000 : undefined,
        cancelAtPeriodEnd: !!o.cancel_at_period_end,
        userId: str(o.metadata?.dorks_user_id),
      };
    }
    case "checkout.session.completed": {
      const customerId = idOf(o.customer);
      const subscriptionId = idOf(o.subscription);
      if (o.mode !== "subscription" || !customerId || !subscriptionId) return null;
      return { kind: "checkout", customerId, subscriptionId, userId: str(o.client_reference_id) };
    }
    default:
      return null;
  }
}
