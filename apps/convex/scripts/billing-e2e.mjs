// End-to-end test of the Convex billing path against REAL Stripe (test mode) on the local Convex backend (pnpm dev:backend).
// Nothing in Stripe or in our Convex functions is mocked: our own checkout action creates a real customer and Checkout session, a real
// $10 subscription is started with a test card, Stripe charges the first invoice, and the app gate (BILLING_REQUIRED) opens and closes.
//
//   needs: pnpm dev:backend running with STRIPE_SECRET_KEY + STRIPE_PRICE_ID in Doppler dev (run `pnpm stripe:setup` first, then
//          dev:backend again to push the env). Run from the repo root: pnpm billing:e2e
//
// Stripe webhooks cannot reach a local backend and the Stripe CLI is not installable in cloud containers, so deliveries are forwarded by
// this script: it reads the real events from Stripe's API and POSTs them to /stripe/webhook signed with a throwaway secret it sets on the
// deployment. The payloads are Stripe's; only the transport and the signing key are ours (Stripe's own signing is covered by the unit tests).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { signStripePayload } from "../core/billing.ts";
import { stripeClient } from "../core/stripe.ts";
import { APP_PRICE_CENTS } from "../core/billing.ts";
import { ensureAppPrice } from "../core/stripeSetup.ts";
import { codeFor, startMockResend } from "./mock-resend.mjs";

// The local backend from pnpm dev:backend (same defaults as run-e2e.sh).
const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const key = process.env.STRIPE_SECRET_KEY;
if (!key || key.startsWith("REPLACE_ME__")) throw new Error("STRIPE_SECRET_KEY is not set");
const stripe = stripeClient({ secretKey: key });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const convex = (args, input) => {
  const r = spawnSync("npx", ["convex", ...args], { encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`convex ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return r.stdout;
};
// Convex function env: the deployment must hold the same Stripe key/price (pnpm dev:backend pushes them). The webhook secret is ours.
const deployed = (n) => { try { return convex(["env", "get", n]).trim(); } catch { return ""; } };
if (!deployed("STRIPE_SECRET_KEY") || !deployed("STRIPE_PRICE_ID")) throw new Error("the deployment has no STRIPE_SECRET_KEY / STRIPE_PRICE_ID: run pnpm dev:backend after storing them in Doppler dev");
const whsec = `whsec_e2e_${randomBytes(16).toString("hex")}`;
convex(["env", "set", "STRIPE_WEBHOOK_SECRET"], whsec);

// The local Docker backend has no route to the internet in cloud containers (outbound HTTPS only goes through an agent proxy that the container
// does not use), so its Stripe calls go to this forwarder on the host, which relays them unchanged to api.stripe.com. Real Stripe, local transport.
const FORWARD_PORT = 8787;
const forwarder = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const headers = {};
    for (const h of ["authorization", "content-type", "idempotency-key", "stripe-version"]) if (req.headers[h]) headers[h] = req.headers[h];
    try {
      const r = await fetch(`https://api.stripe.com${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(await r.text());
    } catch {
      res.writeHead(502).end("{}");
    }
  });
});
await new Promise((r) => forwarder.listen(FORWARD_PORT, "127.0.0.1", r));
convex(["env", "set", "STRIPE_API_BASE_URL"], `http://127.0.0.1:${FORWARD_PORT}`);

const objs = await ensureAppPrice(stripe, () => {});
await startMockResend();

// ---- Stripe webhook transport (see header)
let forwardedUpTo = Math.floor(Date.now() / 1000) - 5;
const seen = new Set();
async function forwardEvents() {
  const list = await stripe.get("events", "/v1/events", { limit: 100, "created[gte]": forwardedUpTo, types: ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "checkout.session.completed"] });
  const fresh = list.data.filter((e) => !seen.has(e.id)).reverse(); // oldest first
  for (const e of fresh) {
    seen.add(e.id);
    const body = JSON.stringify(e);
    const res = await fetch(`${CONVEX_SITE_URL}/stripe/webhook`, { method: "POST", headers: { "stripe-signature": await signStripePayload(whsec, body) }, body });
    if (!res.ok) throw new Error(`webhook ${e.type} -> HTTP ${res.status}`);
  }
  return fresh.length;
}

// ---- sign in
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
const email = `billing${Date.now() % 100000}@dorks.build`;
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
await sleep(400);
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: codeFor(email) }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const client = new ConvexClient(CONVEX_URL);
client.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token);

let customerId, dork;
try {
  convex(["env", "set", "BILLING_REQUIRED", "true"]);
  const priceId = deployed("STRIPE_PRICE_ID");
  check("the price Stripe holds is the $10 monthly plan", objs.priceId === priceId, objs.priceId);
  const price = await stripe.get("price", `/v1/prices/${priceId}`);
  check("price is $10.00 per month", price.unit_amount === APP_PRICE_CENTS && price.currency === "usd" && price.recurring?.interval === "month" && price.recurring?.usage_type === "licensed", `${price.unit_amount} ${price.currency}/${price.recurring?.interval}`);

  await client.mutation(api.settings.setClaudeToken, { token: "sk-billing-e2e" });
  await client.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });

  // ---- gate closed: no subscription yet
  let st = await client.query(api.billing.status, {});
  check("before subscribing: configured, required, not entitled", st.configured && st.required && !st.entitled && st.status === "none", JSON.stringify(st));
  let blocked = "";
  try { await client.mutation(api.dorks.create, { repo: "o/r", message: "billing e2e" }); } catch (e) { blocked = String(e?.message ?? e); }
  check("dorks.create is refused without a subscription", /onboarding_incomplete|subscribe/.test(blocked), blocked.slice(0, 120));

  // ---- checkout: real Stripe customer + Checkout session from our own action
  const { url } = await client.action(api.billing.checkout, {});
  check("checkout returns a Stripe Checkout URL", /^https:\/\/checkout\.stripe\.com\//.test(url));
  const sessionId = /\/(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];
  const session = sessionId ? await stripe.get("session", `/v1/checkout/sessions/${sessionId}`) : null;
  check("the Checkout session is a $10 subscription", session?.mode === "subscription" && session?.amount_total === APP_PRICE_CENTS, `${session?.mode} ${session?.amount_total}`);
  const userId = session?.client_reference_id;
  customerId = session?.customer;
  check("a Stripe customer exists and is tied to the user", /^cus_/.test(customerId ?? "") && !!userId, customerId);

  // The hosted Checkout page is a browser flow; this does what it does on success: pay with a test card and start the subscription.
  const pm = await stripe.post("attach card", "/v1/payment_methods/pm_card_visa/attach", { customer: customerId }); // returns a new payment method id
  await stripe.post("default card", `/v1/customers/${customerId}`, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.post("subscription", "/v1/subscriptions", { customer: customerId, items: [{ price: priceId }], metadata: { dorks_user_id: userId }, expand: ["latest_invoice"] });
  check("Stripe charged the first invoice $10", sub.latest_invoice?.status === "paid" && sub.latest_invoice?.amount_paid === APP_PRICE_CENTS, `${sub.latest_invoice?.status} ${sub.latest_invoice?.amount_paid}`);
  for (let i = 0; i < 20; i++) { await forwardEvents(); st = await client.query(api.billing.status, {}); if (st.entitled) break; await sleep(1500); }
  check("webhook made the user entitled", st.entitled && st.status === "active" && !!st.currentPeriodEnd, JSON.stringify(st));

  // ---- gate open
  dork = await client.mutation(api.dorks.create, { repo: "o/r", message: "billing e2e" });
  check("dorks.create works while subscribed", !!dork, dork);

  // ---- portal (manage card / cancel)
  try {
    const portal = await client.action(api.billing.portal, {});
    check("portal returns a Stripe billing portal URL", /^https:\/\/billing\.stripe\.com\//.test(portal.url));
  } catch (e) {
    check("portal returns a Stripe billing portal URL", false, String(e?.message ?? e).slice(0, 200));
  }

  // ---- cancel: entitlement ends, gate closes again
  await stripe.del("cancel", `/v1/subscriptions/${sub.id}`);
  for (let i = 0; i < 20; i++) { await forwardEvents(); st = await client.query(api.billing.status, {}); if (!st.entitled) break; await sleep(1500); }
  check("webhook ended the entitlement", !st.entitled && st.status === "canceled", JSON.stringify(st));
  blocked = "";
  try { await client.mutation(api.dorks.create, { repo: "o/r", message: "after cancel" }); } catch (e) { blocked = String(e?.message ?? e); }
  check("dorks.create is refused again after cancelling", /onboarding_incomplete|subscribe/.test(blocked), blocked.slice(0, 120));
} catch (e) {
  results.push(false);
  console.error("FAIL", e instanceof Error ? e.message : e);
} finally {
  try { if (dork) await client.mutation(api.dorks.remove, { dorkId: dork }); } catch {}
  try { if (customerId) await stripe.del("delete customer", `/v1/customers/${customerId}`); } catch {}
  try { convex(["env", "remove", "BILLING_REQUIRED"]); } catch {}
  try { convex(["env", "remove", "STRIPE_API_BASE_URL"]); } catch {}
  forwarder.close();
  await client.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
