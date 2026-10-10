import { httpRouter } from "convex/server";
import { verifyStripeSignature } from "../core/billing";
import { verifyWebhook } from "../core/github";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { parseGithubEvent } from "./lib/githubEvents";

const http = httpRouter();
// Lazy: the auth is built per request, so a deploy (CI, fresh project) can precede `convex env set`; createAuth then fails fast on missing env.
authComponent.registerRoutesLazy(http, createAuth, { cors: true });

const reply = (status: number, text: string) => new Response(text, { status });

// GitHub App webhook (docs/github-app.md). Verifies the signature, parses what we use, and hands it to one mutation that does the
// routing: GitHub gives up on a slow endpoint, so nothing here waits on anything but the database.
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    // Without the slug the App's own comments cannot be told apart, and the dork would answer itself: refuse like an unconfigured endpoint.
    if (!secret || !process.env.GITHUB_APP_SLUG) return reply(503, "webhook not configured"); // before reading the body: nothing of it is logged
    const body = await req.text();
    if (!(await verifyWebhook(secret, body, req.headers.get("x-hub-signature-256")))) return reply(401, "bad signature");
    const event = req.headers.get("x-github-event");
    const deliveryId = req.headers.get("x-github-delivery");
    if (!event || !deliveryId) return reply(400, "missing headers");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(400, "bad json");
    }
    const parsed = parseGithubEvent(event, payload); // null: an event or action we do not act on (incl. `ping` and installation events): acknowledged
    if (parsed) await ctx.runMutation(internal.github.ingest, { deliveryId, event: parsed });
    return reply(200, "ok");
  }),
});

// Stripe webhook (docs/billing.md): subscription lifecycle -> billing row. Verified over the raw body; answers fast, work is one mutation.
http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return reply(503, "webhook not configured");
    const body = await req.text();
    if (!(await verifyStripeSignature(secret, body, req.headers.get("stripe-signature")))) return reply(401, "bad signature");
    let event: { id?: unknown; type?: unknown };
    try {
      event = JSON.parse(body);
    } catch {
      return reply(400, "bad json");
    }
    if (typeof event.id !== "string") return reply(400, "bad event");
    await ctx.runMutation(internal.billing.ingest, { eventId: event.id, event });
    return reply(200, "ok");
  }),
});
export default http;
