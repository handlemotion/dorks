import { v } from "convex/values";
import { isEntitled, parseBillingEvent } from "../core/billing";
import { stripeClient, StripeError } from "../core/stripe";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { authComponent, requireUserId } from "./auth";
import { fail } from "./lib/dispatch";

// Billing (docs/billing.md): one flat monthly Stripe subscription for app access; users bring their own Upstash and Claude keys.
// The Stripe product and price are created by `pnpm stripe:setup`; this file holds the user-facing functions and the webhook mutation.
// Stripe is optional: without STRIPE_SECRET_KEY / STRIPE_PRICE_ID billing is "not configured" and BILLING_REQUIRED cannot be turned on.

const SWEEP_BATCH = 500;
const RETENTION_MS = 7 * 24 * 3_600_000;

const billingConfigured = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID;
const billingRequired = () => process.env.BILLING_REQUIRED === "true";

/** STRIPE_API_BASE_URL is for the local e2e only (a local backend in a locked-down container reaches Stripe through a forwarder). Unset in production. */
function stripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return fail("not_configured", "billing is not configured");
  return stripeClient({ secretKey, allowLive: process.env.STRIPE_ALLOW_LIVE === "true", baseUrl: process.env.STRIPE_API_BASE_URL || undefined });
}

const siteUrl = (path: string) => {
  const base = process.env.SITE_URL;
  if (!base) return fail("not_configured", "SITE_URL is not set");
  return new URL(path, base).toString();
};

/** Safe to show: no ids, only what the settings screen needs. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return {
      configured: billingConfigured(),
      required: billingRequired(),
      status: row?.status ?? "none",
      entitled: isEntitled(row?.status),
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    };
  },
});

export const rowOf = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return row ? { customerId: row.stripeCustomerId, status: row.status } : null;
  },
});

/** Records the customer for a user. The first writer wins, so two racing checkouts end up with one customer id. */
export const ensureCustomer = internalMutation({
  args: { userId: v.string(), customerId: v.string() },
  handler: async (ctx, { userId, customerId }) => {
    const row = await ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (row) return row.stripeCustomerId;
    await ctx.db.insert("billing", { userId, stripeCustomerId: customerId, status: "none", updatedAt: Date.now() });
    return customerId;
  },
});

/** Starts Stripe Checkout for the $10 monthly subscription and returns the hosted page URL. */
export const checkout = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const user = await authComponent.getAuthUser(ctx);
    const userId = user._id as string;
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) return fail("not_configured", "billing is not configured");
    const client = stripe();
    try {
      let row = await ctx.runQuery(internal.billing.rowOf, { userId });
      if (isEntitled(row?.status)) return fail("conflict", "already subscribed");
      let customerId = row?.customerId;
      if (!customerId) {
        const created = await client.createCustomer({ userId, email: (user as { email?: string }).email });
        customerId = await ctx.runMutation(internal.billing.ensureCustomer, { userId, customerId: created.id });
      }
      const session = await client.createCheckoutSession({
        customerId, priceId, userId,
        successUrl: siteUrl("/settings?billing=success"),
        cancelUrl: siteUrl("/settings?billing=cancel"),
      });
      return { url: session.url };
    } catch (e) {
      if (e instanceof StripeError) {
        console.error("checkout failed", e.message);
        return fail("failed", "could not start checkout");
      }
      throw e;
    }
  },
});

/** Stripe's hosted customer portal (payment method, invoices, cancel). */
export const portal = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const userId = await requireUserId(ctx);
    const row = await ctx.runQuery(internal.billing.rowOf, { userId });
    if (!row) return fail("not_found", "no billing account yet");
    try {
      const session = await stripe().createPortalSession({ customerId: row.customerId, returnUrl: siteUrl("/settings") });
      return { url: session.url };
    } catch (e) {
      if (e instanceof StripeError) {
        console.error("portal failed", e.message);
        return fail("failed", "could not open the billing portal");
      }
      throw e;
    }
  },
});

/** For dorks.create when BILLING_REQUIRED=true. */
export async function assertCanStartDork(ctx: { db: any }, userId: string) {
  if (!billingRequired()) return;
  const row = await ctx.db.query("billing").withIndex("by_user", (q: any) => q.eq("userId", userId)).unique();
  if (!isEntitled(row?.status)) fail("onboarding_incomplete", "subscribe to start a dork");
}

// --- webhook ------------------------------------------------------------------------------------------------------------------

/** Applies a verified Stripe event. Idempotent on the event id (Stripe retries, and delivers out of order only across events). */
export const ingest = internalMutation({
  args: { eventId: v.string(), event: v.any() },
  handler: async (ctx, { eventId, event }) => {
    if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", eventId)).first()) return "duplicate";
    await ctx.db.insert("stripeEvents", { eventId, receivedAt: Date.now() });
    const parsed = parseBillingEvent(event);
    if (!parsed) return "ignored";
    let row = await ctx.db.query("billing").withIndex("by_customer", (q) => q.eq("stripeCustomerId", parsed.customerId)).unique();
    if (!row && parsed.userId) {
      // A customer we did not record (e.g. the create call succeeded but ensureCustomer never ran): adopt it, but never steal a user's row.
      const mine = await ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", parsed.userId!)).unique();
      if (!mine) {
        const id = await ctx.db.insert("billing", { userId: parsed.userId, stripeCustomerId: parsed.customerId, status: "none", updatedAt: Date.now() });
        row = (await ctx.db.get(id))!;
      }
    }
    if (!row) {
      console.error("stripe event for an unknown customer", parsed.kind);
      return "unknown_customer";
    }
    if (parsed.kind === "checkout") {
      // The subscription event carries the status; this only makes sure the id is known even if that event arrives later.
      if (!row.stripeSubscriptionId) await ctx.db.patch(row._id, { stripeSubscriptionId: parsed.subscriptionId, updatedAt: Date.now() });
      return "ok";
    }
    // A different, older subscription (a canceled one after a re-subscribe) must not overwrite the current one.
    if (row.stripeSubscriptionId && row.stripeSubscriptionId !== parsed.subscriptionId && isEntitled(row.status) && !isEntitled(parsed.status)) return "stale_subscription";
    await ctx.db.patch(row._id, {
      stripeSubscriptionId: parsed.subscriptionId,
      status: parsed.status,
      currentPeriodEnd: parsed.currentPeriodEndMs,
      cancelAtPeriodEnd: parsed.cancelAtPeriodEnd,
      updatedAt: Date.now(),
    });
    return "ok";
  },
});

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const events = await ctx.db.query("stripeEvents").withIndex("by_received", (q) => q.lt("receivedAt", cutoff)).take(SWEEP_BATCH);
    for (const e of events) await ctx.db.delete(e._id);
    if (events.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.billing.sweep, {});
  },
});
