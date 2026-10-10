// Minimal Stripe REST client on fetch (no SDK, so it runs in the Convex runtime, Workers and plain Node). Shared by the Convex
// billing functions and the setup/e2e scripts. Only the calls dorks makes.
//
// Safety: a live key (`sk_live_` / `rk_live_`) is refused unless the caller passes `allowLive` (Convex: STRIPE_ALLOW_LIVE=true).
// Nothing in the repo sets that. Error messages carry the operation and Stripe's error code/type, never the request or the key.

const BASE = "https://api.stripe.com";

export type StripeOptions = { secretKey: string; allowLive?: boolean; fetch?: typeof fetch; baseUrl?: string };

export class StripeError extends Error {
  // Plain fields, not constructor parameter properties: the scripts import this file straight into Node's type stripping.
  status?: number;
  code?: string;
  type?: string;
  constructor(message: string, status?: number, code?: string, type?: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export const isLiveKey = (key: string) => /^(sk|rk)_live_/.test(key);

/** Stripe's form encoding: nested objects as `a[b]=c`, arrays as `a[0]=x`; undefined/null are dropped. */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return pairs.join("&");
}

export function stripeClient(opts: StripeOptions) {
  if (!opts.secretKey) throw new StripeError("stripe: no secret key");
  if (isLiveKey(opts.secretKey) && !opts.allowLive) throw new StripeError("stripe: live keys are refused (test mode only)");
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? BASE).replace(/\/$/, "");

  async function call<T = any>(op: string, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const form = encodeForm(params);
    const url = method === "GET" && form ? `${base}${path}?${form}` : `${base}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${opts.secretKey}` };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body: method === "POST" ? form : undefined, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new StripeError(`stripe ${op}: network error`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new StripeError(`stripe ${op}: HTTP ${res.status}${e.code ? ` ${e.code}` : ""}${e.message ? `: ${String(e.message).slice(0, 200)}` : ""}`, res.status, e.code, e.type);
    }
    return json as T;
  }

  return {
    call,
    get: <T = any>(op: string, path: string, params?: Record<string, unknown>) => call<T>(op, "GET", path, params),
    post: <T = any>(op: string, path: string, params?: Record<string, unknown>, idempotencyKey?: string) => call<T>(op, "POST", path, params, idempotencyKey),
    del: <T = any>(op: string, path: string) => call<T>(op, "DELETE", path),

    createCustomer: (p: { userId: string; email?: string }) =>
      call<{ id: string }>("create_customer", "POST", "/v1/customers", { email: p.email, metadata: { dorks_user_id: p.userId } }, `dorks-customer-${p.userId}`),

    createCheckoutSession: (p: { customerId: string; priceId: string; userId: string; successUrl: string; cancelUrl: string }) =>
      call<{ id: string; url: string }>("create_checkout", "POST", "/v1/checkout/sessions", {
        mode: "subscription",
        customer: p.customerId,
        client_reference_id: p.userId,
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        subscription_data: { metadata: { dorks_user_id: p.userId } },
      }),

    createPortalSession: (p: { customerId: string; returnUrl: string }) =>
      call<{ url: string }>("create_portal", "POST", "/v1/billing_portal/sessions", { customer: p.customerId, return_url: p.returnUrl }),
  };
}

export type StripeClient = ReturnType<typeof stripeClient>;
