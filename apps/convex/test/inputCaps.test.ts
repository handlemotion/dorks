/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { MAX_ACTIVE_DORKS } from "../convex/dorks";
import { MAX_CLAUDE_TOKEN_CHARS, MAX_SECRET_BYTES, MAX_SECRETS_PER_USER } from "../convex/settings";

// Auth is the better-auth component (covered end to end by scripts/e2e.mjs); here the identity subject is the user id.
vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));

const modules = import.meta.glob("../convex/**/*.*s");
const code = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e) => code(e));

beforeEach(() => {
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.BASE_SNAPSHOT_ID = "snap-1";
});

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, claudeTokenEnc: "enc", githubInstallationId: 1 });
  });
  return { t, u1: t.withIdentity({ subject: "u1" }) };
};
const insertDork = (t: ReturnType<typeof convexTest>, over: Record<string, unknown> = {}) =>
  t.run((ctx) => ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state: "idle", archived: false, lastActivityAt: 1, ...over }));

describe("settings caps", () => {
  it("claude token: 4KB max", async () => {
    const { u1 } = await setup();
    await u1.mutation(api.settings.setClaudeToken, { token: "x".repeat(MAX_CLAUDE_TOKEN_CHARS) });
    expect(await rejects(u1.mutation(api.settings.setClaudeToken, { token: "x".repeat(MAX_CLAUDE_TOKEN_CHARS + 1) }))).toBe("invalid");
  });

  it("cli secret: 16KB max (bytes, not chars)", async () => {
    const { u1 } = await setup();
    await u1.mutation(api.settings.setCliSecret, { name: "OK", value: "x".repeat(MAX_SECRET_BYTES) });
    expect(await rejects(u1.mutation(api.settings.setCliSecret, { name: "BIG", value: "x".repeat(MAX_SECRET_BYTES + 1) }))).toBe("invalid");
    expect(await rejects(u1.mutation(api.settings.setCliSecret, { name: "MULTI", value: "é".repeat(MAX_SECRET_BYTES / 2 + 1) }))).toBe("invalid");
  });

  it("cli secret: 50 per user; overwriting an existing one still works at the cap; other users are independent", async () => {
    const { t, u1 } = await setup();
    for (let i = 0; i < MAX_SECRETS_PER_USER; i++) await u1.mutation(api.settings.setCliSecret, { name: `S${i}`, value: "v" });
    expect(await rejects(u1.mutation(api.settings.setCliSecret, { name: "ONE_TOO_MANY", value: "v" }))).toBe("limit");
    await u1.mutation(api.settings.setCliSecret, { name: "S0", value: "new" });
    expect(await t.run((ctx) => ctx.db.query("userSecrets").collect().then((r) => r.length))).toBe(MAX_SECRETS_PER_USER);
    await t.withIdentity({ subject: "u2" }).mutation(api.settings.setCliSecret, { name: "S0", value: "v" });
  });

  it("sleep minutes: NaN and Infinity rejected, finite values clamped", async () => {
    const { t, u1 } = await setup();
    for (const minutes of [NaN, Infinity, -Infinity]) expect(await rejects(u1.mutation(api.settings.setSleepMinutes, { minutes }))).toBe("invalid");
    await u1.mutation(api.settings.setSleepMinutes, { minutes: 1e9 });
    expect(await t.run((ctx) => ctx.db.query("userSettings").first().then((s) => s?.sleepMinutes))).toBe(24 * 60);
  });
});

describe("dorks.create caps", () => {
  it.each(["./x", "o/..", "../r", "./.", "..//r", "a b/c", "o/r/x", "o"])("repo %s is refused", async (repo) => {
    const { u1 } = await setup();
    expect(await rejects(u1.mutation(api.dorks.create, { repo, message: "hi" }))).toBe("invalid");
  });

  it("dotted names that are not . or .. are fine", async () => {
    const { u1 } = await setup();
    await u1.mutation(api.dorks.create, { repo: "my.org/repo.js", message: "hi" });
    await u1.mutation(api.dorks.create, { repo: "o/..hidden", message: "hi" });
  });

  it("title: 120 chars max", async () => {
    const { u1 } = await setup();
    await u1.mutation(api.dorks.create, { repo: "o/r", message: "hi", title: "t".repeat(120) });
    expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi", title: "t".repeat(121) }))).toBe("invalid");
  });

  it("active dork cap: archived and deleting ones do not count, other users are independent", async () => {
    const { t, u1 } = await setup();
    for (let i = 0; i < MAX_ACTIVE_DORKS - 1; i++) await insertDork(t);
    await insertDork(t, { archived: true });
    await insertDork(t, { deleting: true });
    await u1.mutation(api.dorks.create, { repo: "o/r", message: "the 20th" });
    expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "the 21st" }))).toBe("limit");
    await t.run((ctx) => ctx.db.query("dorks").first().then((d) => ctx.db.patch(d!._id, { archived: true })));
    await u1.mutation(api.dorks.create, { repo: "o/r", message: "archiving frees a slot" });
    await t.run((ctx) => ctx.db.insert("userSettings", { userId: "u2", sleepMinutes: 5, claudeTokenEnc: "enc", githubInstallationId: 2 }));
    await t.withIdentity({ subject: "u2" }).mutation(api.dorks.create, { repo: "o/r", message: "hi" });
  });
});

describe("events.list", () => {
  it("returns an empty page once the dork is being deleted", async () => {
    const { t, u1 } = await setup();
    const dorkId = await insertDork(t);
    await t.run((ctx) => ctx.db.insert("events", { dorkId, seq: 1, ts: 1, body: { type: "user_message", text: "hi" } }));
    const opts = { dorkId, paginationOpts: { numItems: 10, cursor: null } };
    expect((await u1.query(api.events.list, opts)).page).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(dorkId, { deleting: true }));
    expect(await u1.query(api.events.list, opts)).toMatchObject({ page: [], isDone: true });
  });
});
