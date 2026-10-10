// End-to-end proof of the billing math against REAL services, no mocks: real Upstash Box compute, real Stripe (test mode).
//
//   doppler run -p dorks -c dev -- node apps/convex/scripts/stripe-e2e.mjs [--burn-seconds 240]
//
// 1. ensures the Stripe meter / product / price (core/stripeSetup.ts)
// 2. Stripe test clock + test customer with a test card + metered subscription
// 3. creates a real Upstash Box, burns CPU on both cores, reads the box's own total_compute_cost_usd, deletes the box
// 4. sends that cost to the Stripe meter in micro-USD, exactly like convex/billing.ts (same identifier, same value)
// 5. advances the test clock past the billing period and checks the invoice: line = cost x 1.15, quantity = micro-USD of cost
// Costs a few cents of Upstash compute. Refuses live Stripe keys (stripeClient). Cleans up (box, test clock, customer) even on failure.
import { billedCents, METER_EVENT_NAME, meterIdentifier, usdToMicro } from "../core/billing.ts";
import { stripeClient } from "../core/stripe.ts";
import { ensureBillingObjects } from "../core/stripeSetup.ts";

const args = process.argv.slice(2);
const burnSeconds = Number(args.includes("--burn-seconds") ? args[args.indexOf("--burn-seconds") + 1] : 240);
const need = (n) => {
  const v = process.env[n];
  if (!v || v.startsWith("REPLACE_ME__")) {
    console.error(`${n} is not set. Run under: doppler run -p dorks -c dev -- node ...`);
    process.exit(2);
  }
  return v;
};
const stripe = stripeClient({ secretKey: need("STRIPE_SECRET_KEY") });
const upKey = need("UPSTASH_BOX_API_KEY");
const UP = (process.env.UPSTASH_BOX_BASE_URL || "https://us-east-1.box.upstash.com").replace(/\/$/, "");
const log = (...a) => console.log("[e2e]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => {
  if (!ok) throw new Error(`ASSERT FAILED: ${msg}`);
  log("ok:", msg);
};

async function up(method, path, body, timeoutMs = 60_000) {
  const res = await fetch(UP + path, { method, headers: { "x-box-api-key": upKey, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`upstash ${method} ${path}: HTTP ${res.status}`);
  return text ? JSON.parse(text) : {};
}

const cleanup = [];
try {
  const objs = await ensureBillingObjects(stripe, (m) => log(m));

  // --- Stripe: test clock, customer, card, subscription ---------------------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const clock = await stripe.post("clock", "/v1/test_helpers/test_clocks", { frozen_time: now, name: `dorks-billing-e2e-${now}` });
  cleanup.push(() => stripe.del("delete clock", `/v1/test_helpers/test_clocks/${clock.id}`));
  const customer = await stripe.post("customer", "/v1/customers", { test_clock: clock.id, name: "dorks billing e2e", email: "billing-e2e@dorks.build", metadata: { dorks_user_id: "e2e" } });
  await stripe.post("attach card", "/v1/payment_methods/pm_card_visa/attach", { customer: customer.id });
  await stripe.post("default card", `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: "pm_card_visa" } });
  const sub = await stripe.post("subscription", "/v1/subscriptions", { customer: customer.id, items: [{ price: objs.priceId }] });
  check(sub.status === "active", `metered subscription is active (${sub.status})`);

  // --- Upstash: a real box, real CPU, the box's own cost figure -------------------------------------------------------------------
  let box = await up("POST", "/v2/box", { name: `dorks-billing-e2e-${now}`, runtime: "node", size: "small" });
  cleanup.push(() => up("DELETE", `/v2/box/${box.id}`).catch(() => {}));
  for (let i = 0; box.status === "creating" && i < 90; i++) {
    await sleep(2000);
    box = await up("GET", `/v2/box/${box.id}`);
  }
  check(box.status === "idle" || box.status === "running", `box ${box.id} is up (${box.status})`);
  log(`burning both cores for ${burnSeconds}s`);
  const burn = await up("POST", `/v2/box/${box.id}/exec`, { command: ["sh", "-c", `timeout ${burnSeconds} sh -c 'while :; do :; done' & timeout ${burnSeconds} sh -c 'while :; do :; done' & wait; echo done`] }, (burnSeconds + 120) * 1000);
  log("exec exit code", burn.exit_code);
  let usd = 0;
  for (let i = 0, stable = 0; i < 40 && stable < 2; i++) {
    const b = await up("GET", `/v2/box/${box.id}`);
    const v = b.total_compute_cost_usd ?? 0;
    stable = v > 0 && v === usd ? stable + 1 : 0;
    usd = v;
    await sleep(3000);
  }
  check(usd > 0, `Upstash reports total_compute_cost_usd = ${usd} for the box`);
  const costMicro = usdToMicro(usd);
  log(`cost ${usd} USD = ${costMicro} micro-USD; expected bill ${billedCents(costMicro).toFixed(4)} cents`);
  await up("DELETE", `/v2/box/${box.id}`);

  // --- Meter: the same event convex/billing.ts sends ------------------------------------------------------------------------------
  const identifier = meterIdentifier(box.id, { from: 0, to: costMicro });
  const send = () => stripe.createMeterEvent({ eventName: METER_EVENT_NAME, customerId: customer.id, value: costMicro, identifier });
  await send();
  log("meter event sent");
  // Retrying the same window must not double count. What Stripe returns for a repeat identifier is recorded here for convex/billing.ts isDuplicateIdentifier.
  const repeat = await send().then(() => "accepted (deduplicated silently)", (e) => `rejected: ${e.message}`);
  log("repeat of the same identifier:", repeat);

  // Wait for Stripe's aggregation to include the event.
  const minute = (t) => Math.floor(t / 60) * 60;
  let aggregated = 0;
  for (let i = 0; i < 40; i++) {
    const s = await stripe.get("summaries", `/v1/billing/meters/${objs.meterId}/event_summaries`, { customer: customer.id, start_time: minute(now), end_time: minute(Math.floor(Date.now() / 1000)) + 60 });
    aggregated = s.data.reduce((a, x) => a + x.aggregated_value, 0);
    if (aggregated >= costMicro) break;
    await sleep(15_000);
  }
  check(aggregated === costMicro, `Stripe meter aggregated ${aggregated} of ${costMicro} micro-USD (repeat did not double count)`);

  // --- Invoice: advance the clock past the period end -----------------------------------------------------------------------------
  const periodEnd = (await stripe.get("sub", `/v1/subscriptions/${sub.id}`)).items.data[0].current_period_end;
  await stripe.post("advance", `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: periodEnd + 2 * 3600 });
  for (let i = 0; i < 60; i++) {
    if ((await stripe.get("clock", `/v1/test_helpers/test_clocks/${clock.id}`)).status === "ready") break;
    await sleep(3000);
  }
  let invoice;
  for (let i = 0; i < 40; i++) {
    const list = await stripe.get("invoices", "/v1/invoices", { customer: customer.id, limit: 10 });
    invoice = list.data.find((x) => x.lines.data.some((l) => (l.amount ?? 0) >= 0 && JSON.stringify(l).includes(objs.priceId)));
    if (invoice) break;
    await sleep(5000);
  }
  check(!!invoice, "an invoice with the metered line exists");
  if (invoice.status === "draft") invoice = await stripe.post("finalize", `/v1/invoices/${invoice.id}/finalize_invoice`, {});
  const line = invoice.lines.data.find((l) => JSON.stringify(l).includes(objs.priceId));
  const expectedCents = Math.round(billedCents(costMicro));
  log("invoice line:", JSON.stringify({ id: invoice.id, status: invoice.status, amount: line.amount, quantity: line.quantity, description: line.description, currency: line.currency }));
  check(line.quantity === costMicro, `line quantity ${line.quantity} = ${costMicro} micro-USD of Upstash cost`);
  check(line.amount === expectedCents, `line amount ${line.amount}c = round(cost x 1.15) = ${expectedCents}c (cost ${(usd * 100).toFixed(3)}c)`);
  log("PASS");
} catch (e) {
  console.error("[e2e] FAIL:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch((e) => console.error("[e2e] cleanup failed:", e?.message));
}
