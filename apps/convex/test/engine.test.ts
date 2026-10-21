/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest, type TestConvexForDataModel } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { aad, encrypt, keyringFromEnv } from "../core/crypto";

// The agent engine (packages/shared/src/agent.ts): chosen per dork at create, and it decides what `configure` hands the box.

vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));
vi.mock("../core/github", async (orig) => ({
  ...(await orig<typeof import("../core/github")>()),
  createInstallationToken: async () => ({ token: "ghs_installation", expiresAt: "2030-01-01T00:00:00Z" }),
}));

const modules = import.meta.glob("../convex/**/*.*s");
type T = TestConvexForDataModel<DataModel>;
const code = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e) => code(e));
const ring = () => keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "unused";
  delete process.env.BOX_PROVIDER;
});

async function setup(over: { claudeToken?: boolean; defaultEngine?: "claude" | "opencode"; opencodeModel?: string } = {}) {
  const t = convexTest(schema, modules);
  const claudeTokenEnc = over.claudeToken === false ? undefined : (await encrypt(ring(), "sk-ant-oat-x", aad.claudeToken("u1"))).value;
  await t.run(async (ctx) => {
    await ctx.db.insert("userSettings", {
      userId: "u1", sleepMinutes: 5, githubInstallationId: 42, claudeTokenEnc,
      ...(over.defaultEngine ? { defaultEngine: over.defaultEngine } : {}), ...(over.opencodeModel ? { opencodeModel: over.opencodeModel } : {}),
    });
    await ctx.db.insert("userSecrets", { userId: "u1", name: "ANTHROPIC_API_KEY", valueEnc: (await encrypt(ring(), "sk-ant-api-x", aad.secret("u1", "ANTHROPIC_API_KEY"))).value });
  });
  return { t, u1: t.withIdentity({ subject: "u1" }) };
}

const dorkOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.get(id));
/** The dork as its box sees it: awake, so configure hands out secrets. */
async function configureFor(t: T, dorkId: Id<"dorks">) {
  await t.run((ctx) => ctx.db.patch(dorkId, { state: "working" }));
  return t.action(api.bridge.configure, { dorkId, secret: await bridgeSecret(dorkId) });
}

describe("dorks.create: engine", () => {
  it("defaults to Claude Code, and the configure frame carries the Claude token", async () => {
    const { t, u1 } = await setup();
    const id = await u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" });
    expect((await dorkOf(t, id))!.engine).toBe("claude");
    const cfg = await configureFor(t, id);
    expect(cfg).toMatchObject({ t: "configure", engine: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", ANTHROPIC_API_KEY: "sk-ant-api-x" } });
    expect(cfg).not.toHaveProperty("model");
  });

  it("an OpenCode dork never receives the Claude token, and gets the user's model", async () => {
    const { t, u1 } = await setup({ opencodeModel: "anthropic/claude-sonnet-4-5" });
    const id = await u1.mutation(api.dorks.create, { repo: "o/r", message: "hi", engine: "opencode" });
    expect((await dorkOf(t, id))!.engine).toBe("opencode");
    const cfg = await configureFor(t, id);
    expect(cfg).toMatchObject({ t: "configure", engine: "opencode", model: "anthropic/claude-sonnet-4-5", env: { ANTHROPIC_API_KEY: "sk-ant-api-x" } });
    expect((cfg as { env: Record<string, string> }).env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("uses the user's default engine when the call names none; an explicit engine wins", async () => {
    const { t, u1 } = await setup({ defaultEngine: "opencode" });
    expect((await dorkOf(t, await u1.mutation(api.dorks.create, { repo: "o/r", message: "a" })))!.engine).toBe("opencode");
    expect((await dorkOf(t, await u1.mutation(api.dorks.create, { repo: "o/r", message: "b", engine: "claude" })))!.engine).toBe("claude");
  });

  it("OpenCode does not need a Claude token; Claude Code does", async () => {
    const { u1 } = await setup({ claudeToken: false });
    expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("onboarding_incomplete");
    expect(await rejects(u1.mutation(api.dorks.create, { repo: "o/r", message: "hi", engine: "opencode" }))).toBeUndefined();
  });

  it("a dork made before engines existed configures as Claude Code", async () => {
    const { t } = await setup();
    const id = await t.run(async (ctx) => {
      const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state: "working", archived: false, lastActivityAt: 1 });
      await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
      return dorkId;
    });
    expect(await configureFor(t, id)).toMatchObject({ engine: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" } });
  });
});

describe("settings.setEngineDefaults", () => {
  it("stores the default engine and model, and onboarding reports them", async () => {
    const { u1 } = await setup();
    expect(await u1.query(api.settings.onboarding, {})).toMatchObject({ defaultEngine: "claude", opencodeModel: null, providerKey: true });
    await u1.mutation(api.settings.setEngineDefaults, { defaultEngine: "opencode", opencodeModel: " openrouter/anthropic/claude-sonnet-4.5 " });
    expect(await u1.query(api.settings.onboarding, {})).toMatchObject({ defaultEngine: "opencode", opencodeModel: "openrouter/anthropic/claude-sonnet-4.5" });
    await u1.mutation(api.settings.setEngineDefaults, { opencodeModel: "" }); // clears the model, keeps the engine
    expect(await u1.query(api.settings.onboarding, {})).toMatchObject({ defaultEngine: "opencode", opencodeModel: null });
  });

  it.each(["claude-sonnet", "a b/c", "/model", "x/" + "m".repeat(200)])("refuses the model %j", async (model) => {
    const { u1 } = await setup();
    expect(await rejects(u1.mutation(api.settings.setEngineDefaults, { opencodeModel: model }))).toBe("invalid");
  });
});
