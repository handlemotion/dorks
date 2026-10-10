// Creates (or finds) the Stripe product and the flat monthly app-access price, in the account the key belongs to. Test mode only.
//
//   doppler run -p dorks -c dev -- node apps/convex/scripts/stripe-setup.mjs [--write-doppler dev] [--webhook-url https://<deployment>.convex.site/stripe/webhook]
//
// Prints ids (not secrets). --write-doppler <config> stores STRIPE_PRICE_ID (and a newly created webhook's signing secret, via stdin,
// never printed) in that Doppler config of project dorks. Use the dev config; production is set by a human in the dashboard.
import { spawnSync } from "node:child_process";
import { stripeClient } from "../core/stripe.ts";
import { ensureAppPrice, ensureWebhookEndpoint } from "../core/stripeSetup.ts";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const key = process.env.STRIPE_SECRET_KEY;
if (!key || key.startsWith("REPLACE_ME__")) {
  console.error("STRIPE_SECRET_KEY is not set (put a test-mode key in Doppler dorks/dev, then run this under `doppler run`)");
  process.exit(2);
}
const stripe = stripeClient({ secretKey: key }); // throws on a live key
const out = await ensureAppPrice(stripe, (m) => console.log("[stripe-setup]", m));
console.log("[stripe-setup]", JSON.stringify(out));

const config = opt("--write-doppler");
const put = (name, value) => {
  if (config === "prd" || config === "ci") throw new Error("refusing to write production/ci secrets from a script");
  const r = spawnSync("doppler", ["secrets", "set", name, "-p", "dorks", "-c", config, "--no-interactive"], { input: value, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`doppler set ${name} failed`);
  console.log(`[stripe-setup] ${name} saved to Doppler ${config}`);
};
if (config) put("STRIPE_PRICE_ID", out.priceId);

const url = opt("--webhook-url");
if (url) {
  const hook = await ensureWebhookEndpoint(stripe, url);
  console.log(`[stripe-setup] webhook endpoint ${hook.id}`);
  if (hook.secret && config) put("STRIPE_WEBHOOK_SECRET", hook.secret);
  else if (hook.secret) console.log("[stripe-setup] a new webhook secret was created but not stored (pass --write-doppler dev); delete the endpoint and re-run");
  else console.log("[stripe-setup] endpoint already existed: its signing secret is only shown in the Stripe dashboard");
}
