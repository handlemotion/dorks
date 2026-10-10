/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import {
  billedCents, isEntitled, MARKUP_BPS, meterIdentifier, parseBillingEvent, signStripePayload, unitAmountDecimalCents, usdToMicro, verifyStripeSignature,
} from "../core/billing";
import { encodeForm, isLiveKey, stripeClient } from "../core/stripe";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.*s");

describe("pricing", () => {
  it("charges cost + 15% as an exact Stripe decimal (cents per micro-USD)", () => {
    expect(MARKUP_BPS).toBe(1500);
    expect(unitAmountDecimalCents()).toBe("0.000115");
    expect(unitAmountDecimalCents(0)).toBe("0.0001");
    expect(unitAmountDecimalCents(2000)).toBe("0.00012");
    expect(() => unitAmountDecimalCents(-1)).toThrow();
  });

  it("bills $1.00 of Upstash cost as $1.15", () => {
    expect(billedCents(usdToMicro(1))).toBeCloseTo(115, 9);
    expect(billedCents(usdToMicro(0.2))).toBeCloseTo(23, 9); // 1 hour of two busy cores on a Small box
    expect(billedCents(0)).toBe(0);
  });

  it("converts the provider's float dollars to whole micro-dollars", () => {
    expect(usdToMicro(0.0123456789)).toBe(12346);
    expect(usdToMicro(0.1 + 0.2)).toBe(300_000); // float noise is rounded away
  });

  it("names a window uniquely, so a retry repeats the identifier and a wider window does not", () => {
    expect(meterIdentifier("b1", { from: 5, to: 9 })).toBe(meterIdentifier("b1", { from: 5, to: 9 }));
    expect(meterIdentifier("b1", { from: 5, to: 9 })).not.toBe(meterIdentifier("b1", { from: 5, to: 12 }));
  });

  it("keeps past_due customers entitled and cancelled/unpaid ones out", () => {
    for (const s of ["active", "trialing", "past_due"]) expect(isEntitled(s)).toBe(true);
    for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "none", "", undefined, null]) expect(isEntitled(s)).toBe(false);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const now = 1_800_000_000;

  it("accepts a correctly signed, fresh payload", async () => {
    expect(await verifyStripeSignature(secret, body, await signStripePayload(secret, body, now), now)).toBe(true);
  });
  it("rejects a tampered body, wrong secret, stale timestamp and malformed headers", async () => {
    const h = await signStripePayload(secret, body, now);
    expect(await verifyStripeSignature(secret, body + " ", h, now)).toBe(false);
    expect(await verifyStripeSignature("whsec_other", body, h, now)).toBe(false);
    expect(await verifyStripeSignature(secret, body, h, now + 301)).toBe(false);
    for (const bad of [null, "", "garbage", `t=${now}`, `v1=abc`, `t=x,v1=abc`]) expect(await verifyStripeSignature(secret, body, bad, now)).toBe(false);
  });
  it("accepts any matching v1 while a secret is rolling", async () => {
    const good = (await signStripePayload(secret, body, now)).split(",v1=")[1];
    expect(await verifyStripeSignature(secret, body, `t=${now},v1=${"0".repeat(64)},v1=${good}`, now)).toBe(true);
  });
});

describe("parseBillingEvent", () => {
  const sub = (over: object = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: { dorks_user_id: "u1" }, ...over });
  it("reads a subscription, with the period end on the subscription or on its first item", () => {
    expect(parseBillingEvent({ type: "customer.subscription.updated", data: { object: sub({ current_period_end: 100 }) } })).toMatchObject({ kind: "subscription", customerId: "cus_1", status: "active", currentPeriodEndMs: 100_000, userId: "u1" });
    expect(parseBillingEvent({ type: "customer.subscription.created", data: { object: sub({ items: { data: [{ current_period_end: 200 }] } }) } })).toMatchObject({ currentPeriodEndMs: 200_000 });
  });
  it("treats a deleted subscription as canceled whatever its last status says", () => {
    expect(parseBillingEvent({ type: "customer.subscription.deleted", data: { object: sub({ status: "active" }) } })).toMatchObject({ status: "canceled" });
  });
  it("reads a subscription Checkout, and ignores payment-mode checkouts and unrelated events", () => {
    expect(parseBillingEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", customer: "cus_1", subscription: "sub_1", client_reference_id: "u1" } } })).toEqual({ kind: "checkout", customerId: "cus_1", subscriptionId: "sub_1", userId: "u1" });
    expect(parseBillingEvent({ type: "checkout.session.completed", data: { object: { mode: "payment", customer: "cus_1" } } })).toBeNull();
    expect(parseBillingEvent({ type: "invoice.paid", data: { object: {} } })).toBeNull();
    expect(parseBillingEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } })).toBeNull();
  });
});

describe("stripe client", () => {
  it("encodes nested params the way Stripe expects", () => {
    expect(decodeURIComponent(encodeForm({ mode: "subscription", line_items: [{ price: "price_1" }], payload: { value: "5" }, skip: undefined, nil: null }))).toBe("mode=subscription&line_items[0][price]=price_1&payload[value]=5");
  });
  it("refuses live keys unless explicitly allowed", () => {
    expect(isLiveKey("sk_live_abc")).toBe(true);
    expect(isLiveKey("rk_live_abc")).toBe(true);
    expect(isLiveKey("sk_test_abc")).toBe(false);
    expect(() => stripeClient({ secretKey: "sk_live_abc" })).toThrow(/live keys are refused/);
    expect(() => stripeClient({ secretKey: "sk_live_abc", allowLive: true })).not.toThrow();
  });
  it("sends the meter event with an identifier and never puts the key or request in an error", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ok = stripeClient({ secretKey: "sk_test_secret", fetch: (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify({ identifier: "x" })))) as unknown as typeof fetch });
    await ok.createMeterEvent({ eventName: "e", customerId: "cus_1", value: 42, identifier: "b:0-42", timestampSec: 1 });
    expect(seen!.url).toBe("https://api.stripe.com/v1/billing/meter_events");
    expect(decodeURIComponent(String(seen!.init.body))).toBe("event_name=e&identifier=b:0-42&timestamp=1&payload[stripe_customer_id]=cus_1&payload[value]=42");
    const bad = stripeClient({ secretKey: "sk_test_secret", fetch: (async () => new Response(JSON.stringify({ error: { code: "x", message: "nope" } }), { status: 400 })) as unknown as typeof fetch });
    const err = await bad.createMeterEvent({ eventName: "e", customerId: "cus_1", value: 1, identifier: "i" }).catch((e) => e);
    expect(err.message).not.toContain("sk_test_secret");
    expect(err.message).toContain("HTTP 400");
  });
});

describe("billing ledger (Convex)", () => {
  const subscribe = (t: TestConvex<typeof schema>, status = "active") =>
    t.run((ctx) => ctx.db.insert("billing", { userId: "u1", stripeCustomerId: "cus_1", status, updatedAt: 1 }));
  const claim = (t: TestConvex<typeof schema>, costMicro: number, userId = "u1") => t.mutation(internal.billing.claim, { userId, boxId: "box1", costMicro });
  const row = (t: TestConvex<typeof schema>) => t.run((ctx) => ctx.db.query("boxUsage").withIndex("by_box", (q) => q.eq("boxId", "box1")).unique());

  it("claims the growth since the last settled window, once", async () => {
    const t = convexTest(schema, modules);
    await subscribe(t);
    expect(await claim(t, 1000)).toEqual({ window: { from: 0, to: 1000 }, customerId: "cus_1" });
    await t.mutation(internal.billing.settle, { boxId: "box1", to: 1000 });
    expect(await claim(t, 1000)).toBeNull(); // nothing new
    expect(await claim(t, 1750)).toEqual({ window: { from: 1000, to: 1750 }, customerId: "cus_1" });
  });

  it("retries a claimed but unsettled window unchanged, even after the cost grew (no double count, no widened window)", async () => {
    const t = convexTest(schema, modules);
    await subscribe(t);
    await claim(t, 1000); // sent to Stripe, then the action died before settle
    const again = await claim(t, 1600);
    expect(again).toEqual({ window: { from: 0, to: 1000 }, customerId: "cus_1" });
    await t.mutation(internal.billing.settle, { boxId: "box1", to: 1000 });
    expect(await claim(t, 1600)).toEqual({ window: { from: 1000, to: 1600 }, customerId: "cus_1" });
  });

  it("never lets the cost go backwards", async () => {
    const t = convexTest(schema, modules);
    await subscribe(t);
    await claim(t, 900);
    await t.mutation(internal.billing.settle, { boxId: "box1", to: 900 });
    expect(await claim(t, 400)).toBeNull();
    expect((await row(t))!.costMicro).toBe(900);
  });

  it("does not bill usage that accrued while the user had no entitled subscription", async () => {
    const t = convexTest(schema, modules);
    expect(await claim(t, 500)).toBeNull(); // no billing row
    await subscribe(t);
    expect(await claim(t, 800)).toEqual({ window: { from: 500, to: 800 }, customerId: "cus_1" }); // only the part after subscribing
  });

  it("stops billing once the subscription is canceled", async () => {
    const t = convexTest(schema, modules);
    const id = await subscribe(t, "canceled");
    expect(await claim(t, 700)).toBeNull();
    expect((await row(t))!.reportedMicro).toBe(700);
    await t.run((ctx) => ctx.db.patch(id, { status: "past_due" }));
    expect(await claim(t, 900)).toMatchObject({ window: { from: 700, to: 900 } });
  });

  it("ignores a claim from a different user for the same box", async () => {
    const t = convexTest(schema, modules);
    await subscribe(t);
    await claim(t, 100);
    expect(await claim(t, 5000, "u2")).toBeNull();
  });

  it("settle only applies to the window it names", async () => {
    const t = convexTest(schema, modules);
    await subscribe(t);
    await claim(t, 1000);
    await t.mutation(internal.billing.settle, { boxId: "box1", to: 999 });
    expect(await row(t)).toMatchObject({ reportedMicro: 0, inflightTo: 1000 });
  });
});

describe("billing webhook ingest (Convex)", () => {
  const ev = (type: string, object: object) => ({ type, data: { object } });
  const sub = (status: string, over: object = {}) => ({ id: "sub_1", customer: "cus_1", status, metadata: { dorks_user_id: "u1" }, ...over });
  const billingOf = (t: TestConvex<typeof schema>) => t.run((ctx) => ctx.db.query("billing").withIndex("by_user", (q) => q.eq("userId", "u1")).unique());

  it("follows the subscription lifecycle and drops duplicate deliveries", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.billing.ensureCustomer, { userId: "u1", customerId: "cus_1" });
    expect(await t.mutation(internal.billing.ingest, { eventId: "e1", event: ev("customer.subscription.created", sub("active", { current_period_end: 100 })) })).toBe("ok");
    expect(await billingOf(t)).toMatchObject({ status: "active", stripeSubscriptionId: "sub_1", currentPeriodEnd: 100_000 });
    expect(await t.mutation(internal.billing.ingest, { eventId: "e1", event: ev("customer.subscription.deleted", sub("active")) })).toBe("duplicate");
    expect((await billingOf(t))!.status).toBe("active");
    await t.mutation(internal.billing.ingest, { eventId: "e2", event: ev("customer.subscription.updated", sub("past_due")) });
    expect((await billingOf(t))!.status).toBe("past_due");
    await t.mutation(internal.billing.ingest, { eventId: "e3", event: ev("customer.subscription.deleted", sub("active")) });
    expect((await billingOf(t))!.status).toBe("canceled");
  });

  it("adopts a customer it never recorded when the event names the user, but never steals another user's customer", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.billing.ingest, { eventId: "e1", event: ev("customer.subscription.created", sub("active")) });
    expect(await billingOf(t)).toMatchObject({ stripeCustomerId: "cus_1", status: "active" });
    expect(await t.mutation(internal.billing.ingest, { eventId: "e2", event: ev("customer.subscription.created", sub("active", { customer: "cus_other", id: "sub_2" })) })).toBe("unknown_customer");
    expect((await billingOf(t))!.stripeCustomerId).toBe("cus_1");
  });

  it("ignores events about customers it does not know and events it does not act on", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.billing.ingest, { eventId: "e1", event: ev("customer.subscription.created", sub("active", { metadata: {} })) })).toBe("unknown_customer");
    expect(await t.mutation(internal.billing.ingest, { eventId: "e2", event: ev("invoice.paid", {}) })).toBe("ignored");
  });

  it("a late 'canceled' for an old subscription does not cancel the current one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.billing.ensureCustomer, { userId: "u1", customerId: "cus_1" });
    await t.mutation(internal.billing.ingest, { eventId: "e1", event: ev("customer.subscription.created", sub("active", { id: "sub_new" })) });
    expect(await t.mutation(internal.billing.ingest, { eventId: "e2", event: ev("customer.subscription.deleted", sub("active", { id: "sub_old" })) })).toBe("stale_subscription");
    expect(await billingOf(t)).toMatchObject({ status: "active", stripeSubscriptionId: "sub_new" });
  });

  it("first customer wins when two checkouts race", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.billing.ensureCustomer, { userId: "u1", customerId: "cus_a" })).toBe("cus_a");
    expect(await t.mutation(internal.billing.ensureCustomer, { userId: "u1", customerId: "cus_b" })).toBe("cus_a");
  });
});
