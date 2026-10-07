/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { clientIp, createAuth, rateKeyForEmail } from "../convex/auth";

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

describe("auth helpers", () => {
  it("one mailbox, one key: case, whitespace and +tags collapse", () => {
    expect(rateKeyForEmail(" Rodrigo+spam@JaAntonio.com ")).toBe("rodrigo@jaantonio.com");
    expect(rateKeyForEmail("rodrigo@jaantonio.com")).toBe("rodrigo@jaantonio.com");
    expect(rateKeyForEmail("a+b+c@jaantonio.com")).toBe("a@jaantonio.com");
  });

  it("client ip is the last x-forwarded-for hop (earlier hops are caller-controlled)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBeUndefined();
    expect(clientIp(undefined)).toBeUndefined();
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
