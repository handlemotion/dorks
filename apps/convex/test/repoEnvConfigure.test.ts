/// <reference types="vite/client" />
// @vitest-environment edge-runtime
// What a dork's sandbox actually receives (bridge.configure) once variables are set per repo: the whole path from the settings calls to
// the decrypted environment the bridge applies.
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { aad, encrypt, keyringFromEnv } from "../core/crypto";

vi.mock("../core/github", async (orig) => ({ ...(await orig<typeof import("../core/github")>()), createInstallationToken: async () => ({ token: "ghs_installation", expiresAt: "2030-01-01T00:00:00Z" }) }));
vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));

const modules = import.meta.glob("../convex/**/*.*s");

beforeEach(() => {
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "unused";
});

async function world() {
  const t = convexTest(schema, modules);
  const claudeTokenEnc = (await encrypt(keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! }), "sk-ant-x", aad.claudeToken("u1"))).value;
  await t.run((ctx) => ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, claudeTokenEnc, githubInstallationId: 42 }));
  const dork = async (repo: string) => {
    const dorkId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo, branch: "agent/x", state: "working", archived: false, lastActivityAt: 1 });
      await ctx.db.insert("dorkRuntime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
      return id;
    });
    return { dorkId, secret: await bridgeSecret(dorkId) };
  };
  const envOf = async (repo: string) => {
    const cfg = (await t.action(api.bridge.configure, await dork(repo))) as { env: Record<string, string> };
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...vars } = cfg.env;
    return vars;
  };
  return { t, u1: t.withIdentity({ subject: "u1" }), envOf };
}

describe("per-repo environment variables reach the right sandboxes", () => {
  it("account-wide ones go to every repo; a repo's own go to that repo only and win over a same-named account-wide one", async () => {
    const { u1, envOf } = await world();
    await u1.mutation(api.settings.setCliSecret, { name: "SHARED", value: "everyone" });
    await u1.mutation(api.settings.setCliSecret, { name: "STRIPE_KEY", value: "live-for-all" });
    await u1.mutation(api.settings.setCliSecret, { name: "STRIPE_KEY", value: "test-for-web", repo: "Acme/Web" });
    await u1.mutation(api.settings.setCliSecret, { name: "ONLY_API", value: "api-only", repo: "acme/api" });
    expect(await envOf("acme/web")).toEqual({ SHARED: "everyone", STRIPE_KEY: "test-for-web" });
    expect(await envOf("Acme/Web")).toEqual({ SHARED: "everyone", STRIPE_KEY: "test-for-web" }); // any casing
    expect(await envOf("acme/api")).toEqual({ SHARED: "everyone", STRIPE_KEY: "live-for-all", ONLY_API: "api-only" });
    expect(await envOf("someone/else")).toEqual({ SHARED: "everyone", STRIPE_KEY: "live-for-all" });
  });

  it("removing a repo's variable falls back to the account-wide one", async () => {
    const { u1, envOf } = await world();
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "wide" });
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "narrow", repo: "o/r" });
    expect(await envOf("o/r")).toEqual({ K: "narrow" });
    await u1.mutation(api.settings.removeCliSecret, { name: "K", repo: "o/r" });
    expect(await envOf("o/r")).toEqual({ K: "wide" });
  });

  it("variables saved before repos existed (no repo) still decrypt", async () => {
    const { t, envOf } = await world();
    const valueEnc = (await encrypt(keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! }), "legacy", aad.secret("u1", "OLD"))).value;
    await t.run((ctx) => ctx.db.insert("userSecrets", { userId: "u1", name: "OLD", valueEnc }));
    expect(await envOf("o/r")).toEqual({ OLD: "legacy" });
  });
});
