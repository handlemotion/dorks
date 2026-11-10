/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { clientIp, createAuth, otpLimits, personalOwnerEmail, rateKeyForEmail, sendChecks } from "../convex/auth";

const modules = import.meta.glob("../convex/**/*.*s");
const H = 3_600_000;
const check = (key: string, limit: number, windowMs = H) => ({ key, limit, windowMs });

afterEach(() => vi.useRealTimers());

describe("rateLimit.hit", () => {
  it("allows up to the limit, then refuses with the time left", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 3; i++) expect(await t.mutation(internal.rateLimit.hit, { checks: [check("k", 3)] })).toEqual({ ok: true });
    const r = await t.mutation(internal.rateLimit.hit, { checks: [check("k", 3)] });
    expect(r).toMatchObject({ ok: false, key: "k" });
    expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(H - 5_000);
  });

  it("is all-or-nothing: a refusal on one key does not spend the others", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.rateLimit.hit, { checks: [check("email", 1)] });
    for (let i = 0; i < 5; i++) expect(await t.mutation(internal.rateLimit.hit, { checks: [check("ip", 5), check("email", 1)] })).toMatchObject({ ok: false, key: "email" });
    const ip = await t.run((ctx) => ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", "ip")).unique());
    expect(ip).toBeNull();
  });

  it("starts a fresh window once the old one has elapsed", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(internal.rateLimit.hit, { checks: [check("k", 1)] });
    expect((await t.mutation(internal.rateLimit.hit, { checks: [check("k", 1)] })).ok).toBe(false);
    vi.advanceTimersByTime(H + 1);
    expect((await t.mutation(internal.rateLimit.hit, { checks: [check("k", 1)] })).ok).toBe(true);
    expect((await t.mutation(internal.rateLimit.hit, { checks: [check("k", 1)] })).ok).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("rateLimits").collect().then((r) => r.length))).toBe(1);
  });

  it("sweep drops counters older than a day and keeps recent ones", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.mutation(internal.rateLimit.hit, { checks: [check("old", 1)] });
    vi.advanceTimersByTime(25 * H);
    await t.mutation(internal.rateLimit.hit, { checks: [check("new", 1)] });
    await t.mutation(internal.rateLimit.sweep, {});
    expect(await t.run((ctx) => ctx.db.query("rateLimits").collect().then((r) => r.map((x) => x.key)))).toEqual(["new"]);
  });
});

describe("rateLimit.reset", () => {
  it("clears every counter", async () => {
    const t = convexTest(schema, modules);
    for (const k of ["a", "b", "c"]) await t.mutation(internal.rateLimit.hit, { checks: [check(k, 1)] });
    await t.mutation(internal.rateLimit.reset, {});
    expect(await t.run((ctx) => ctx.db.query("rateLimits").collect().then((r) => r.length))).toBe(0);
    expect((await t.mutation(internal.rateLimit.hit, { checks: [check("a", 1)] })).ok).toBe(true);
  });
});

describe("auth helpers", () => {
  it("requires a real owner email for Boat but leaves local sim and legacy boxes alone", () => {
    expect(personalOwnerEmail({ BOX_PROVIDER: "sim" })).toBeNull();
    expect(personalOwnerEmail({ BOX_PROVIDER: "other" })).toBeNull();
    expect(() => personalOwnerEmail({ BOX_PROVIDER: "boat" })).toThrow("DORKS_OWNER_EMAIL");
    expect(() => personalOwnerEmail({ DORKS_OWNER_EMAIL: "REPLACE_ME__OWNER" })).toThrow("DORKS_OWNER_EMAIL");
    expect(personalOwnerEmail({ BOX_PROVIDER: "boat", DORKS_OWNER_EMAIL: " Rodrigo@Example.com " })).toBe("rodrigo@example.com");
  });

  it("uses the deployment owner email when no test environment is supplied", () => {
    const previous = { owner: process.env.DORKS_OWNER_EMAIL, provider: process.env.BOX_PROVIDER };
    try {
      process.env.DORKS_OWNER_EMAIL = " Owner@Example.com ";
      process.env.BOX_PROVIDER = "boat";
      expect(personalOwnerEmail()).toBe("owner@example.com");
    } finally {
      if (previous.owner === undefined) delete process.env.DORKS_OWNER_EMAIL;
      else process.env.DORKS_OWNER_EMAIL = previous.owner;
      if (previous.provider === undefined) delete process.env.BOX_PROVIDER;
      else process.env.BOX_PROVIDER = previous.provider;
    }
  });

  it("one mailbox, one key: case, whitespace and +tags collapse", () => {
    expect(rateKeyForEmail(" Rodrigo+spam@example.com ")).toBe("rodrigo@example.com");
    expect(rateKeyForEmail("rodrigo@example.com")).toBe("rodrigo@example.com");
    expect(rateKeyForEmail("a+b+c@example.com")).toBe("a@example.com");
  });

  it("client ip is the last x-forwarded-for hop (earlier hops are caller-controlled)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBeUndefined();
    expect(clientIp(undefined)).toBeUndefined();
  });

  it("every send is checked against the global key, whatever the caller does with headers", () => {
    const l = { windowMs: H, sendPerEmail: 5, sendPerIp: 30, sendGlobal: 100 };
    const keys = (ip?: string) => sendChecks("rand-1@example.com", ip, l).map((c) => c.key);
    expect(keys(undefined)).toEqual(["otp-send:email:rand-1@example.com", "otp-send:global"]); // no header: no IP key, global still there
    expect(keys("1.2.3.4")).toEqual(["otp-send:email:rand-1@example.com", "otp-send:ip:1.2.3.4", "otp-send:global"]);
    expect(sendChecks("x@example.com", undefined, l).at(-1)).toEqual({ key: "otp-send:global", limit: 100 });
  });

  it("the global budget caps total sends across many mailboxes and spoofed IPs", async () => {
    const t = convexTest(schema, modules);
    const l = { windowMs: H, sendPerEmail: 5, sendPerIp: 30, sendGlobal: 10 };
    const results = [];
    for (let i = 0; i < 15; i++) {
      const checks = sendChecks(`rand-${i}@example.com`, i % 2 ? `9.9.9.${i}` : undefined, l).map((c) => ({ ...c, windowMs: H }));
      results.push((await t.mutation(internal.rateLimit.hit, { checks })).ok);
    }
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.slice(10).every((ok) => !ok)).toBe(true);
  });

  it("limits come from env with sane defaults; the window is clamped so the sweep cannot drop live counters", () => {
    const keys = ["OTP_WINDOW_MS", "OTP_SEND_PER_EMAIL", "OTP_SEND_PER_IP", "OTP_SEND_GLOBAL"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      expect(otpLimits()).toEqual({ windowMs: H, sendPerEmail: 5, sendPerIp: 30, sendGlobal: 100 });
      process.env.OTP_SEND_GLOBAL = "7";
      process.env.OTP_SEND_PER_EMAIL = "junk";
      process.env.OTP_WINDOW_MS = String(30 * H);
      expect(otpLimits()).toMatchObject({ sendGlobal: 7, sendPerEmail: 5, windowMs: 24 * H });
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  it("createAuth fails fast, naming the missing variable", () => {
    const saved = { SITE_URL: process.env.SITE_URL, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };
    try {
      process.env.BETTER_AUTH_SECRET = "s";
      delete process.env.SITE_URL;
      expect(() => createAuth({} as never)).toThrow(/SITE_URL is not set/);
      process.env.SITE_URL = "http://localhost:3000";
      delete process.env.BETTER_AUTH_SECRET;
      expect(() => createAuth({} as never)).toThrow(/BETTER_AUTH_SECRET is not set/);
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});
