import { v } from "convex/values";
import { isEntitled, meterIdentifier, METER_EVENT_NAME, parseBillingEvent, type UsageWindow } from "../core/billing";
import { stripeClient, StripeError } from "../core/stripe";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { authComponent, requireUserId } from "./auth";
import { getBox } from "./lib/box";
import { fail } from "./lib/dispatch";

// Usage-based billing (docs/billing.md): customers pay what their boxes cost at Upstash plus 15%, through a Stripe Billing Meter.
// Stripe objects (meter, product, price) are created by `pnpm stripe:setup`; this file holds the user-facing functions, the webhook
// mutation and the metering loop. Stripe is optional: without STRIPE_SECRET_KEY nothing here sends or claims anything.

const SWEEP_BATCH = 500;
const RETENTION_MS = 7 * 24 * 3_600_000;
const METER_CONCURRENCY = 8;

const billingConfigured = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID;
const billingRequired = () => process.env.BILLING_REQUIRED === "true";

/** STRIPE_API_BASE_URL is for the local e2e only (a local backend in a locked-down container reaches Stripe through a forwarder). Unset in production. */
const stripeFromEnv = (secretKey: string) => stripeClient({ secretKey, allowLive: process.env.STRIPE_ALLOW_LIVE === "true", baseUrl: process.env.STRIPE_API_BASE_URL || undefined });

function stripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return fail("not_configured", "billing is not configured");
  return stripeFromEnv(secretKey);
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

/** Starts Stripe Checkout for the metered subscription and returns the hosted page URL. */
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

// --- metering -----------------------------------------------------------------------------------------------------------------

/**
 * Records what the provider says a box has cost and claims the next window to send to Stripe.
 *
 * costMicro only grows (a lower reading is ignored). A claimed window is stored (`inflightTo`) before it is sent and is retried
 * unchanged until `settle`, so a crash between "sent" and "settled" can only repeat the same Stripe identifier, never a wider window.
 * Cost that accrues while the user has no entitled subscription is not billed: the ledger skips past it (it is forgiven, not deferred).
 */
export const claim = internalMutation({
  args: { userId: v.string(), boxId: v.string(), costMicro: v.number() },
  handler: async (ctx, { userId, boxId, costMicro }): Promise<{ window: UsageWindow; customerId: string } | null> => {
    const now = Date.now();
    let row = await ctx.db.query("boxUsage").withIndex("by_box", (q) => q.eq("boxId", boxId)).unique();
    if (!row) {
      const id = await ctx.db.insert("boxUsage", { userId, boxId, costMicro: 0, reportedMicro: 0, observedAt: now });
      row = (await ctx.db.get(id))!;
    }
    if (row.userId !== userId) return null; // a box id never changes owner; do not bill the wrong customer
    const cost = Math.max(row.costMicro, Math.floor(costMicro));
    const billing = await ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const entitled = isEntitled(billing?.status);
    await ctx.db.patch(row._id, { costMicro: cost, observedAt: now });
    if (row.inflightTo !== undefined) return billing ? { window: { from: row.reportedMicro, to: row.inflightTo }, customerId: billing.stripeCustomerId } : null;
    if (cost <= row.reportedMicro) return null;
    if (!entitled || !billing) {
      await ctx.db.patch(row._id, { reportedMicro: cost });
      return null;
    }
    await ctx.db.patch(row._id, { inflightTo: cost });
    return { window: { from: row.reportedMicro, to: cost }, customerId: billing.stripeCustomerId };
  },
});

export const settle = internalMutation({
  args: { boxId: v.string(), to: v.number() },
  handler: async (ctx, { boxId, to }) => {
    const row = await ctx.db.query("boxUsage").withIndex("by_box", (q) => q.eq("boxId", boxId)).unique();
    if (row && row.inflightTo === to) await ctx.db.patch(row._id, { reportedMicro: to, inflightTo: undefined });
  },
});

export const closeBox = internalMutation({
  args: { boxId: v.string() },
  handler: async (ctx, { boxId }) => {
    const row = await ctx.db.query("boxUsage").withIndex("by_box", (q) => q.eq("boxId", boxId)).unique();
    if (row && row.closedAt === undefined && row.inflightTo === undefined) await ctx.db.patch(row._id, { closedAt: Date.now() });
  },
});

/** Stripe refuses a repeated meter event identifier; that means the window already counted, so it is settled, not retried forever. */
const isDuplicateIdentifier = (e: unknown) => e instanceof StripeError && e.status === 400 && /identifier|duplicate|already/i.test(e.message);

/**
 * One metering pass for one box: read the provider's cost, claim the next window, send it to Stripe, settle.
 * Never throws: a failure leaves the claimed window in place and the next pass retries it. `closed`: the box is gone (or being deleted).
 */
export async function meterBox(ctx: ActionCtx, p: { userId: string; boxId: string; closed?: boolean }): Promise<"sent" | "nothing" | "skipped" | "failed"> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return "skipped";
  try {
    const reading = await getBox(ctx).usage(p.boxId);
    if (!reading) {
      await ctx.runMutation(internal.billing.closeBox, { boxId: p.boxId });
      return "nothing";
    }
    const claim = await ctx.runMutation(internal.billing.claim, { userId: p.userId, boxId: p.boxId, costMicro: reading.costMicro });
    let result: "sent" | "nothing" = "nothing";
    if (claim) {
      const { window, customerId } = claim;
      try {
        await stripeFromEnv(secretKey).createMeterEvent({
          eventName: process.env.STRIPE_METER_EVENT_NAME || METER_EVENT_NAME,
          customerId,
          value: window.to - window.from,
          identifier: meterIdentifier(p.boxId, window),
        });
      } catch (e) {
        if (!isDuplicateIdentifier(e)) throw e;
      }
      await ctx.runMutation(internal.billing.settle, { boxId: p.boxId, to: window.to });
      result = "sent";
    }
    if (p.closed) await ctx.runMutation(internal.billing.closeBox, { boxId: p.boxId });
    return result;
  } catch (e) {
    console.error("meter_box failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return "failed";
  }
}

/** One page of dorks that hold a box. */
export const boxesPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("dorks").paginate({ cursor, numItems: 100 });
    return {
      boxes: page.page.flatMap((d) => (d.boxId ? [{ userId: d.userId, boxId: d.boxId }] : [])),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/** Cron: meter every live box. Paused boxes are read too (their last slice may not have been sent yet); it is one cheap GET each. */
export const meterAll = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.STRIPE_SECRET_KEY) return;
    let cursor: string | null = null;
    const totals = { sent: 0, nothing: 0, skipped: 0, failed: 0 };
    for (;;) {
      const page: { boxes: { userId: string; boxId: string }[]; cursor: string; done: boolean } = await ctx.runQuery(internal.billing.boxesPage, { cursor });
      for (let i = 0; i < page.boxes.length; i += METER_CONCURRENCY) {
        const results = await Promise.all(page.boxes.slice(i, i + METER_CONCURRENCY).map((b) => meterBox(ctx, b)));
        for (const r of results) totals[r]++;
      }
      if (page.done) break;
      cursor = page.cursor;
    }
    console.log("metering pass", JSON.stringify(totals));
  },
});

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const events = await ctx.db.query("stripeEvents").withIndex("by_received", (q) => q.lt("receivedAt", cutoff)).take(SWEEP_BATCH);
    for (const e of events) await ctx.db.delete(e._id);
    const closed = await ctx.db.query("boxUsage").withIndex("by_closed", (q) => q.gt("closedAt", 0).lt("closedAt", cutoff)).take(SWEEP_BATCH);
    for (const r of closed) await ctx.db.delete(r._id);
    if (events.length === SWEEP_BATCH || closed.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.billing.sweep, {});
  },
});
