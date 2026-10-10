// End-to-end test of the Convex billing path against REAL Stripe (test mode) on the local Convex backend (pnpm dev:backend).
// Nothing in Stripe or in our Convex functions is mocked. The one simulated input is the box's cost figure: the local backend runs
// BOX_PROVIDER=sim, so the sandbox "cost" is set by hand (simbox:setCost). The real Upstash cost source is proven by stripe-e2e.mjs.
//
//   needs: pnpm dev:backend running with STRIPE_SECRET_KEY + STRIPE_PRICE_ID in Doppler dev (run: node scripts/stripe-setup.mjs --write-doppler dev
//          first, then dev:backend again to push the env). Run from apps/convex:
//          doppler run -p dorks -c dev -- node scripts/billing-e2e.mjs
//
// Stripe webhooks cannot reach a local backend and the Stripe CLI is not installable in cloud containers, so deliveries are forwarded by
// this script: it reads the real events from Stripe's API and POSTs them to /stripe/webhook signed with a throwaway secret it sets on the
// deployment. The payloads are Stripe's; only the transport and the signing key are ours (Stripe's own signing is covered by the unit tests).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { signStripePayload } from "../core/billing.ts";
import { stripeClient } from "../core/stripe.ts";
import { ensureBillingObjects } from "../core/stripeSetup.ts";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL } = process.env;
const key = process.env.STRIPE_SECRET_KEY;
if (!CONVEX_URL || !CONVEX_SITE_URL) throw new Error("CONVEX_URL / CONVEX_SITE_URL not set (Doppler dev has them)");
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
const run = (fn, argsObj = {}) => convex(["run", fn, JSON.stringify(argsObj)]);
const usageRows = () => JSON.parse(convex(["data", "boxUsage", "--format", "json"]));

// Convex function env: the deployment must hold the same Stripe key/price (pnpm dev:backend pushes them). The webhook secret is ours.
const deployed = (n) => { try { return convex(["env", "get", n]).trim(); } catch { return ""; } };
if (!deployed("STRIPE_SECRET_KEY") || !deployed("STRIPE_PRICE_ID")) throw new Error("the deployment has no STRIPE_SECRET_KEY / STRIPE_PRICE_ID: run pnpm dev:backend after storing them in Doppler dev");
const whsec = `whsec_e2e_${randomBytes(16).toString("hex")}`;
convex(["env", "set", "STRIPE_WEBHOOK_SECRET"], whsec);

const objs = await ensureBillingObjects(stripe);
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
  await client.mutation(api.settings.setClaudeToken, { token: "sk-billing-e2e" });
  await client.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
  dork = await client.mutation(api.dorks.create, { repo: "o/r", message: "billing e2e" });
  let row;
  for (let i = 0; i < 40 && !row?.boxId; i++) { await sleep(250); row = await client.query(api.dorks.get, { dorkId: dork }); }
  check("a dork with a box exists", !!row?.boxId, row?.boxId);
  const userId = row.userId;

  // ---- checkout: real Stripe customer + Checkout session
  let st = await client.query(api.billing.status, {});
  check("before subscribing: configured, not entitled", st.configured && !st.entitled && st.status === "none", JSON.stringify(st));
  const { url } = await client.action(api.billing.checkout, {});
  check("checkout returns a Stripe Checkout URL", /^https:\/\/checkout\.stripe\.com\//.test(url));
  customerId = JSON.parse(run("billing:rowOf", { userId }).trim() || "null")?.customerId;
  check("a Stripe customer was created and recorded", /^cus_/.test(customerId ?? ""), customerId);

  // The hosted Checkout page is a browser flow; this does what it does on success: pay with a test card and start the subscription.
  await stripe.post("attach card", "/v1/payment_methods/pm_card_visa/attach", { customer: customerId });
  await stripe.post("default card", `/v1/customers/${customerId}`, { invoice_settings: { default_payment_method: "pm_card_visa" } });
  const sub = await stripe.post("subscription", "/v1/subscriptions", { customer: customerId, items: [{ price: objs.priceId }], metadata: { dorks_user_id: userId } });
  for (let i = 0; i < 20; i++) { await forwardEvents(); st = await client.query(api.billing.status, {}); if (st.entitled) break; await sleep(1500); }
  check("webhook made the user entitled", st.entitled && st.status === "active", JSON.stringify(st));

  // ---- metering: real Stripe meter events from our own claim/settle code
  const aggregated = async () => {
    const m = (t) => Math.floor(t / 60) * 60;
    const s = await stripe.get("summaries", `/v1/billing/meters/${objs.meterId}/event_summaries`, { customer: customerId, start_time: m(Date.now() / 1000 - 600), end_time: m(Date.now() / 1000) + 60 });
    return s.data.reduce((a, x) => a + x.aggregated_value, 0);
  };
  const waitFor = async (want, ms = 240_000) => { const t0 = Date.now(); let v = 0; while (Date.now() - t0 < ms) { v = await aggregated(); if (v === want) return v; await sleep(10_000); } return v; };
  run("simbox:setCost", { id: row.boxId, costMicro: 12_345 });
  run("billing:meterAll");
  let u = usageRows().find((x) => x.boxId === row.boxId);
  check("ledger settled the first window", u?.reportedMicro === 12_345 && u.inflightTo === undefined, JSON.stringify(u));
  check("Stripe meter shows 12345 micro-USD", (await waitFor(12_345)) === 12_345);
  run("billing:meterAll"); // nothing new: must not send again
  run("simbox:setCost", { id: row.boxId, costMicro: 20_000 });
  run("billing:meterAll");
  check("Stripe meter shows 20000 after growth (only the delta was sent, nothing counted twice)", (await waitFor(20_000)) === 20_000);

  // ---- cancel: usage after cancel is not billed
  await stripe.del("cancel", `/v1/subscriptions/${sub.id}`);
  for (let i = 0; i < 20; i++) { await forwardEvents(); st = await client.query(api.billing.status, {}); if (!st.entitled) break; await sleep(1500); }
  check("webhook ended the entitlement", !st.entitled && st.status === "canceled", JSON.stringify(st));
  run("simbox:setCost", { id: row.boxId, costMicro: 50_000 });
  run("billing:meterAll");
  await sleep(70_000);
  check("usage after cancellation is not sent to Stripe", (await aggregated()) === 20_000);
} catch (e) {
  results.push(false);
  console.error("FAIL", e instanceof Error ? e.message : e);
} finally {
  try { if (dork) await client.mutation(api.dorks.remove, { dorkId: dork }); } catch {}
  try { if (customerId) await stripe.del("delete customer", `/v1/customers/${customerId}`); } catch {}
  await client.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
