// Idempotent creation of the Stripe objects billing needs: a Billing Meter, a Product and a metered Price at cost + markup.
// Lookup is by meter event name / product metadata / price lookup key, so running it twice (or on a fresh test account) is safe.
// Used by scripts/stripe-setup.mjs and scripts/stripe-e2e.mjs. Test mode only: stripeClient refuses live keys.
import { METER_EVENT_NAME, PRICE_LOOKUP_KEY, unitAmountDecimalCents } from "./billing.ts";
import type { StripeClient } from "./stripe.ts";

export const PRODUCT_KEY = "dorks-box-usage";
export const WEBHOOK_EVENTS = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "checkout.session.completed"];

export async function ensureBillingObjects(stripe: StripeClient, log: (m: string) => void = () => {}) {
  const unit = unitAmountDecimalCents();

  const meters = await stripe.get<{ data: { id: string; event_name: string }[] }>("list_meters", "/v1/billing/meters", { status: "active", limit: 100 });
  let meter = meters.data.find((m) => m.event_name === METER_EVENT_NAME);
  if (!meter) {
    meter = await stripe.post("create_meter", "/v1/billing/meters", {
      display_name: "Dorks sandbox cost (micro-USD)",
      event_name: METER_EVENT_NAME,
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
    log(`created meter ${meter!.id}`);
  } else log(`meter exists ${meter.id}`);

  const products = await stripe.get<{ data: { id: string; metadata?: Record<string, string> }[] }>("list_products", "/v1/products", { active: true, limit: 100 });
  let product = products.data.find((p) => p.metadata?.dorks_key === PRODUCT_KEY);
  if (!product) {
    product = await stripe.post("create_product", "/v1/products", { name: "Dorks sandbox usage", metadata: { dorks_key: PRODUCT_KEY } });
    log(`created product ${product!.id}`);
  } else log(`product exists ${product.id}`);

  const prices = await stripe.get<{ data: { id: string; unit_amount_decimal: string | null; recurring?: { meter?: string } }[] }>("list_prices", "/v1/prices", { lookup_keys: [PRICE_LOOKUP_KEY], active: true });
  let price = prices.data[0];
  if (price) {
    if (Number(price.unit_amount_decimal) !== Number(unit)) throw new Error(`price ${price.id} has unit_amount_decimal ${price.unit_amount_decimal}, expected ${unit}; change PRICE_LOOKUP_KEY with the markup`);
    if (price.recurring?.meter !== meter!.id) throw new Error(`price ${price.id} is attached to a different meter`);
    log(`price exists ${price.id}`);
  } else {
    price = await stripe.post("create_price", "/v1/prices", {
      product: product!.id,
      currency: "usd",
      unit_amount_decimal: unit,
      billing_scheme: "per_unit",
      lookup_key: PRICE_LOOKUP_KEY,
      nickname: "Box cost + 15% (per micro-USD)",
      recurring: { interval: "month", usage_type: "metered", meter: meter!.id },
    });
    log(`created price ${price.id}`);
  }
  return { meterId: meter!.id, productId: product!.id, priceId: price.id, unitAmountDecimalCents: unit };
}

/** Webhook endpoint for a public URL. Stripe returns the signing secret only at creation, so `secret` is undefined when it already existed. */
export async function ensureWebhookEndpoint(stripe: StripeClient, url: string) {
  const list = await stripe.get<{ data: { id: string; url: string }[] }>("list_webhooks", "/v1/webhook_endpoints", { limit: 100 });
  const found = list.data.find((e) => e.url === url);
  if (found) return { id: found.id, secret: undefined as string | undefined };
  const created = await stripe.post<{ id: string; secret: string }>("create_webhook", "/v1/webhook_endpoints", { url, enabled_events: WEBHOOK_EVENTS, description: "dorks billing" });
  return { id: created.id, secret: created.secret };
}
