// Idempotent creation of the Stripe objects billing needs: one Product and one flat monthly Price (the app-access plan).
// Lookup is by product metadata / price lookup key, so running it twice (or on a fresh test account) is safe.
// Used by scripts/stripe-setup.mjs and scripts/billing-e2e.mjs. Test mode only: stripeClient refuses live keys.
import { APP_PRICE_CENTS, APP_PRICE_LOOKUP_KEY } from "./billing.ts";
import type { StripeClient } from "./stripe.ts";

export const PRODUCT_KEY = "dorks-app-access";
export const WEBHOOK_EVENTS = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "checkout.session.completed"];

export async function ensureAppPrice(stripe: StripeClient, log: (m: string) => void = () => {}) {
  const products = await stripe.get<{ data: { id: string; metadata?: Record<string, string> }[] }>("list_products", "/v1/products", { active: true, limit: 100 });
  let product = products.data.find((p) => p.metadata?.dorks_key === PRODUCT_KEY);
  if (!product) {
    product = await stripe.post("create_product", "/v1/products", { name: "Dorks", description: "App access (bring your own Upstash and Claude keys)", metadata: { dorks_key: PRODUCT_KEY } });
    log(`created product ${product!.id}`);
  } else log(`product exists ${product.id}`);

  const prices = await stripe.get<{ data: { id: string; unit_amount: number | null; currency: string; recurring?: { interval?: string; usage_type?: string } }[] }>("list_prices", "/v1/prices", { lookup_keys: [APP_PRICE_LOOKUP_KEY], active: true });
  let price = prices.data[0];
  if (price) {
    if (price.unit_amount !== APP_PRICE_CENTS || price.currency !== "usd" || price.recurring?.interval !== "month" || price.recurring?.usage_type !== "licensed") {
      throw new Error(`price ${price.id} does not match ${APP_PRICE_LOOKUP_KEY}; change the lookup key with the amount`);
    }
    log(`price exists ${price.id}`);
  } else {
    price = await stripe.post("create_price", "/v1/prices", {
      product: product!.id,
      currency: "usd",
      unit_amount: APP_PRICE_CENTS,
      lookup_key: APP_PRICE_LOOKUP_KEY,
      nickname: "App access, monthly",
      recurring: { interval: "month", usage_type: "licensed" },
    });
    log(`created price ${price.id}`);
  }
  return { productId: product!.id, priceId: price.id, amountCents: APP_PRICE_CENTS };
}

/** Webhook endpoint for a public URL. Stripe returns the signing secret only at creation, so `secret` is undefined when it already existed. */
export async function ensureWebhookEndpoint(stripe: StripeClient, url: string) {
  const list = await stripe.get<{ data: { id: string; url: string }[] }>("list_webhooks", "/v1/webhook_endpoints", { limit: 100 });
  const found = list.data.find((e) => e.url === url);
  if (found) return { id: found.id, secret: undefined as string | undefined };
  const created = await stripe.post<{ id: string; secret: string }>("create_webhook", "/v1/webhook_endpoints", { url, enabled_events: WEBHOOK_EVENTS, description: "dorks billing" });
  return { id: created.id, secret: created.secret };
}
