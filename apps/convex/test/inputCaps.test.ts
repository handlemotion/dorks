/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { MAX_CLAUDE_TOKEN_CHARS, MAX_SECRET_BYTES } from "../convex/settings";
import { bridgeSecret } from "../convex/lib/bridgeAuth";

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
  process.env.BOX_PROVIDER = "sim";
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

  it("cli secret: overwriting an existing one replaces it; other users are independent", async () => {
    const { t, u1 } = await setup();
    await u1.mutation(api.settings.setCliSecret, { name: "S0", value: "v" });
    await u1.mutation(api.settings.setCliSecret, { name: "S0", value: "new" });
    expect(await t.run((ctx) => ctx.db.query("userSecrets").collect().then((r) => r.length))).toBe(1);
    await t.withIdentity({ subject: "u2" }).mutation(api.settings.setCliSecret, { name: "S0", value: "v" });
    expect(await t.run((ctx) => ctx.db.query("userSecrets").collect().then((r) => r.length))).toBe(2);
  });

  it("sleep minutes: NaN and Infinity rejected, finite values clamped", async () => {
    const { t, u1 } = await setup();
    for (const minutes of [NaN, Infinity, -Infinity]) expect(await rejects(u1.mutation(api.settings.setSleepMinutes, { minutes }))).toBe("invalid");
    await u1.mutation(api.settings.setSleepMinutes, { minutes: 1e9 });
    expect(await t.run((ctx) => ctx.db.query("userSettings").first().then((s) => s?.sleepMinutes))).toBe(24 * 60);
  });
});

describe("dorks.create caps", () => {
  it("defaults to Codex without a Claude token and requires one only for Claude", async () => {
    const { t, u1 } = await setup();
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("userSettings").first();
      await ctx.db.patch(settings!._id, { claudeTokenEnc: undefined });
    });
    const id = await u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.provider).toBe("codex");
    expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi", provider: "claude" }))).toBe("onboarding_incomplete");
  });

  it("does not create Codex cloud boxes with a provider other than Boat", async () => {
    const { u1 } = await setup();
    const previous = process.env.BOX_PROVIDER;
    process.env.BOX_PROVIDER = "other";
    try {
      expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("not_configured");
    } finally {
      if (previous === undefined) delete process.env.BOX_PROVIDER;
      else process.env.BOX_PROVIDER = previous;
    }
  });

  it("uses a single account Boat connection for new Codex dorks", async () => {
    const { t, u1 } = await setup();
    process.env.BOX_PROVIDER = "boat";
    try {
      expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("onboarding_incomplete");
      expect(await rejects(u1.mutation(api.settings.setCodexBoatEnvironment, { environment: "../unsafe" }))).toBe("invalid");
      await u1.mutation(api.settings.setCodexBoatEnvironment, { environment: "dorks-codex" });
      const dorkId = await u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" });
      expect((await t.run((ctx) => ctx.db.get(dorkId)))?.codexAuthSource).toBe("boat");
      expect(await t.query(internal.lifecycle.boxInfo, { dorkId })).toMatchObject({ boatEnvironment: "dorks-codex", requiresBoatEnvironment: true });
      const second = await u1.mutation(api.dorks.create, { repo: "o/r", message: "another thread" });
      expect((await t.run((ctx) => ctx.db.get(second)))?.codexAuthSource).toBe("boat");
      expect((await u1.query(api.settings.onboarding, {})).codexBoatEnvironment).toBe("dorks-codex");
      const other = t.withIdentity({ subject: "u2" });
      await t.run((ctx) => ctx.db.insert("userSettings", { userId: "u2", sleepMinutes: 5, githubInstallationId: 2 }));
      expect((await other.query(api.settings.onboarding, {})).codexBoatEnvironment).toBeNull();
      expect(await rejects(other.mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("onboarding_incomplete");
    } finally {
      process.env.BOX_PROVIDER = "sim";
    }
  });

  it("only lets the owner choose a model and effort offered by Codex before retrying", async () => {
    const { t, u1 } = await setup();
    const dorkId = await u1.mutation(api.dorks.create, { repo: "o/r", message: "fix tests" });
    const creds = { dorkId, secret: await bridgeSecret(dorkId) };
    await t.mutation(api.bridge.push, { ...creds, frames: [
      { t: "codex_models", models: [{ model: "gpt-6.1-sol", efforts: ["medium", "high"] }] },
      { t: "codex_issue", message: "Choose an available ChatGPT model" },
      { t: "agent_exited", code: 1, stderrTail: "" },
    ] });
    expect((await t.run((ctx) => ctx.db.get(dorkId)))?.state).toBe("error");
    expect(await rejects(u1.mutation(api.dorks.chooseCodexModel, { dorkId, model: "invalid", effort: "high" }))).toBe("invalid");
    expect(await rejects(t.withIdentity({ subject: "u2" }).mutation(api.dorks.chooseCodexModel, { dorkId, model: "gpt-6.1-sol", effort: "high" }))).toBe("not_found");
    await u1.mutation(api.dorks.chooseCodexModel, { dorkId, model: "gpt-6.1-sol", effort: "high" });
    const dork = await t.run((ctx) => ctx.db.get(dorkId));
    expect(dork?.codexModel).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(["creating", "waking"]).toContain(dork?.state);
    expect(dork?.codexModelChoices).toBeUndefined();
  });

  it("reconnects only an idle Codex dork", async () => {
    const { t, u1 } = await setup();
    const dorkId = await insertDork(t, { provider: "codex" });
    await t.run((ctx) => ctx.db.insert("dorkRuntime", {
      dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {},
    }));
    await u1.mutation(api.dorks.reconnectCodex, { dorkId });
    expect((await t.run((ctx) => ctx.db.get(dorkId)))?.state).toBe("waking");
    expect(await t.run((ctx) => ctx.db.query("commands").collect().then((rows) => rows.map((r) => r.kind)))).toContain("codex_reconnect");
    expect(await rejects(u1.mutation(api.dorks.reconnectCodex, { dorkId }))).toBe("conflict");
    const other = await insertDork(t, { provider: "claude" });
    expect(await rejects(u1.mutation(api.dorks.reconnectCodex, { dorkId: other }))).toBe("conflict");
    const boat = await insertDork(t, { provider: "codex", codexAuthSource: "boat" });
    expect(await rejects(u1.mutation(api.dorks.reconnectCodex, { dorkId: boat }))).toBe("conflict");
  });

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
