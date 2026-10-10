/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { APP_PRICE_CENTS, APP_PRICE_LOOKUP_KEY, isEntitled, parseBillingEvent, signStripePayload, verifyStripeSignature } from "../core/billing";
import { encodeForm, isLiveKey, stripeClient } from "../core/stripe";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.*s");

describe("plan", () => {
  it("is $10 a month and the price lookup key carries the amount, so a price change needs a new key", () => {
    expect(APP_PRICE_CENTS).toBe(1000);
    expect(APP_PRICE_LOOKUP_KEY).toBe("dorks_app_monthly_1000");
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
  it("sends a subscription Checkout for quantity 1 and never puts the key or request in an error", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ok = stripeClient({ secretKey: "sk_test_secret", fetch: (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x" })))) as unknown as typeof fetch });
    await ok.createCheckoutSession({ customerId: "cus_1", priceId: "price_1", userId: "u1", successUrl: "https://a/s", cancelUrl: "https://a/c" });
    expect(seen!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const body = decodeURIComponent(String(seen!.init.body));
    expect(body).toContain("mode=subscription");
    expect(body).toContain("line_items[0][price]=price_1&line_items[0][quantity]=1");
    expect(body).toContain("client_reference_id=u1");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_secret");
    const bad = stripeClient({ secretKey: "sk_test_secret", fetch: (async () => new Response(JSON.stringify({ error: { code: "x", message: "nope" } }), { status: 400 })) as unknown as typeof fetch });
    const err = await bad.createPortalSession({ customerId: "cus_1", returnUrl: "https://a" }).catch((e) => e);
    expect(err.message).not.toContain("sk_test_secret");
    expect(err.message).toContain("HTTP 400");
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
