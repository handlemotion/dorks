/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { aad, encrypt, keyringFromEnv } from "../../api/src/lib/crypto";

const gh = vi.hoisted(() => ({ calls: [] as { installationId: unknown; scope: unknown }[], fail: false }));
vi.mock("../../api/src/lib/github", async (orig) => ({
  ...(await orig<typeof import("../../api/src/lib/github")>()),
  createInstallationToken: async (_env: unknown, installationId: unknown, _f: unknown, scope: unknown) => {
    gh.calls.push({ installationId, scope });
    if (gh.fail) throw new Error("GitHub installation token failed: 502");
    return { token: "ghs_scoped", expiresAt: "2030-01-01T00:00:00Z" };
  },
}));

const modules = import.meta.glob("../convex/**/*.*s");

beforeEach(() => {
  Object.assign(gh, { calls: [], fail: false });
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "unused";
  delete process.env.BOX_PROVIDER;
});

async function seed(t: ReturnType<typeof convexTest>, over: { state?: string; archived?: boolean; repo?: string } = {}) {
  const claudeTokenEnc = (await encrypt(keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! }), "sk-ant-x", aad.claudeToken("u1"))).value;
  const dorkId = await t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, claudeTokenEnc, githubInstallationId: 42 });
    const id = await ctx.db.insert("dorks", {
      userId: "u1", title: "t", repo: over.repo ?? "octo/hello", branch: "agent/x", state: (over.state ?? "working") as never, archived: over.archived ?? false, lastActivityAt: 1,
    });
    await ctx.db.insert("dorkRuntime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
    return id;
  });
  return { dorkId, secret: await bridgeSecret(dorkId) };
}

describe("bridge.configure / ghToken scoping", () => {
  it("mints a token scoped to the dork's repo only", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    const cfg = await t.action(api.bridge.configure, c);
    expect(cfg).toMatchObject({ t: "configure", ghToken: "ghs_scoped", repo: { fullName: "octo/hello" } });
    expect(gh.calls).toEqual([{ installationId: 42, scope: { repositories: ["hello"], permissions: { contents: "write", pull_requests: "write" } } }]);
    expect(await t.action(api.bridge.ghToken, c)).toEqual({ t: "gh_token", token: "ghs_scoped" });
    expect(gh.calls[1].scope).toEqual(gh.calls[0].scope);
  });

  it.each(["creating", "waking", "working", "idle"])("allows %s", async (state) => {
    const t = convexTest(schema, modules);
    const c = await seed(t, { state });
    expect(await t.action(api.bridge.ghToken, c)).not.toBeNull();
  });

  it.each([{ state: "sleeping" }, { state: "error" }, { state: "working", archived: true }, { state: "idle", archived: true }])("refuses %o and mints nothing", async (over) => {
    const t = convexTest(schema, modules);
    const c = await seed(t, over);
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(await t.action(api.bridge.ghToken, c)).toBeNull();
    expect(gh.calls).toEqual([]);
    // a refusal is not an op failure: the dork must not be pushed into `error`
    expect(await t.run((ctx) => ctx.db.get(c.dorkId).then((d) => d?.state))).toBe(over.state);
  });

  it("rejects a wrong bridge secret", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    await expect(t.action(api.bridge.ghToken, { ...c, secret: "0".repeat(64) })).rejects.toThrow();
  });
});

describe("failed token refresh", () => {
  it("retries in ~2 minutes instead of waiting for the 45-minute tick", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const c = await seed(t);
      gh.fail = true;
      expect(await t.action(api.bridge.ghToken, c)).toBeNull();
      const rt = await t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", c.dorkId)).unique());
      const id = rt!.timers.gh_token as Id<"_scheduled_functions">;
      expect(id).toBeTruthy();
      const job = await t.run((ctx) => ctx.db.system.get(id));
      expect(job!.scheduledTime - Date.now()).toBeGreaterThan(110_000);
      expect(job!.scheduledTime - Date.now()).toBeLessThanOrEqual(120_000);
      vi.advanceTimersByTime(121_000); // the timer fires: marker queued, normal tick re-armed (it re-arms itself, so don't run to completion)
      await t.finishInProgressScheduledFunctions();
      const cmds = await t.run((ctx) => ctx.db.query("commands").collect());
      expect(cmds.map((x) => x.kind)).toEqual(["gh_token"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm for a dork that is not working or idle", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t, { state: "sleeping" });
    await t.mutation(internal.bridge.retryGhToken, { dorkId: c.dorkId });
    const rt = await t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", c.dorkId)).unique());
    expect(rt!.timers).toEqual({});
  });
});
