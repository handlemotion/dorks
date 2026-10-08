/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest, type TestConvexForDataModel } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { aad, encrypt, keyringFromEnv } from "../../api/src/lib/crypto";

const gh = vi.hoisted(() => ({
  calls: [] as { installationId: unknown; scope: unknown }[],
  fail: null as null | { status: number } | "network",
  repositories: undefined as undefined | "match" | string[],
}));
vi.mock("../../api/src/lib/github", async (orig) => {
  const actual = await orig<typeof import("../../api/src/lib/github")>();
  return {
    ...actual,
    createInstallationToken: async (_env: unknown, installationId: unknown, _f: unknown, scope: { repositories: string[] }) => {
      gh.calls.push({ installationId, scope });
      if (gh.fail === "network") throw new TypeError("fetch failed");
      if (gh.fail) throw new actual.GithubHttpError(gh.fail.status);
      const repositories = gh.repositories === "match" ? scope.repositories.map((n) => `octo/${n}`) : gh.repositories;
      return { token: "ghs_scoped", expiresAt: "2030-01-01T00:00:00Z", ...(repositories ? { repositories } : {}) };
    },
  };
});

const modules = import.meta.glob("../convex/**/*.*s");
type T = TestConvexForDataModel<DataModel>;

beforeEach(() => {
  Object.assign(gh, { calls: [], fail: null, repositories: undefined });
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "unused";
  delete process.env.BOX_PROVIDER;
});

async function seed(t: T, over: { state?: string; archived?: boolean; repo?: string } = {}) {
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

  const runtimeOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique());
  const dorkOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.get(dorkId));
  const eventsOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).collect().then((r) => r.map((e) => e.body)));
  const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect().then((r) => r.map((j) => j.name)));

  it.each([{ state: "sleeping" }, { state: "error" }, { state: "working", archived: true }, { state: "idle", archived: true }])("refuses %o and mints nothing", async (over) => {
    const t = convexTest(schema, modules);
    const c = await seed(t, over);
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(await t.action(api.bridge.ghToken, c)).toBeNull();
    expect(gh.calls).toEqual([]);
    // a refusal is not an op failure: the dork keeps its state, and nothing is paused or scheduled on its behalf
    expect((await dorkOf(t, c.dorkId))!.state).toBe(over.state);
    expect(await scheduled(t)).toEqual([]);
  });

  // The machine only pauses an archived creating/waking dork on `agent_ready`; a refused configure means the bridge never sends it.
  it.each(["creating", "waking"])("archived while %s: configure is refused but the box still gets paused", async (state) => {
    const t = convexTest(schema, modules);
    const c = await seed(t, { state, archived: true });
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(gh.calls).toEqual([]);
    expect((await dorkOf(t, c.dorkId))!.state).toBe("idle"); // machine: archived + agent_ready -> idle + pause_box
    expect(await scheduled(t)).toContain("boxes:pause"); // bridge not live in the fixture, so pause_box schedules the pause directly
    expect(await eventsOf(t, c.dorkId)).toEqual([{ type: "status", state: "idle" }]);
    expect(await t.action(api.bridge.configure, c)).toBeNull(); // a second refused call is a no-op
    expect(await scheduled(t).then((n) => n.filter((x) => x === "boxes:pause"))).toHaveLength(1);
  });

  it("an archived dork's ghToken refusal does not touch the lifecycle", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t, { state: "creating", archived: true });
    expect(await t.action(api.bridge.ghToken, c)).toBeNull();
    expect((await dorkOf(t, c.dorkId))!.state).toBe("creating");
  });

  it("rejects a wrong bridge secret", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    await expect(t.action(api.bridge.ghToken, { ...c, secret: "0".repeat(64) })).rejects.toThrow();
  });

  it.each([404, 422])("GitHub %i names the repo and tells the user what to do", async (status) => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.fail = { status };
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(await eventsOf(t, c.dorkId)).toContainEqual({ type: "error", message: "GitHub App can't access octo/hello; add it to the installation" });
    expect((await dorkOf(t, c.dorkId))!.state).toBe("error");
  });

  it("a token for a same-named repo under another owner is refused", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.repositories = ["alice/hello"]; // dork is octo/hello, but the installation is alice's
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(await eventsOf(t, c.dorkId)).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("octo/hello") }));
  });

  it("repo ownership check is case-insensitive", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.repositories = ["OCTO/Hello"];
    expect(await t.action(api.bridge.configure, c)).toMatchObject({ t: "configure" });
  });

  it("a 5xx during configure is a generic failure (no GitHub detail leaks)", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.fail = { status: 502 };
    expect(await t.action(api.bridge.configure, c)).toBeNull();
    expect(await eventsOf(t, c.dorkId)).toContainEqual({ type: "error", message: "could not configure the sandbox" });
  });
});

describe("failed token refresh", () => {
  const runtimeOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique());
  const eventsOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).collect().then((r) => r.map((e) => e.body)));
  /** ms until the pending gh_token timer, or null if none */
  const delay = async (t: T, dorkId: Id<"dorks">) => {
    const id = (await runtimeOf(t, dorkId))!.timers.gh_token as Id<"_scheduled_functions"> | undefined;
    if (!id) return null;
    return (await t.run((ctx) => ctx.db.system.get(id)))!.scheduledTime - Date.now();
  };
  const near = (actual: number | null, ms: number) => {
    expect(actual).toBeGreaterThan(ms - 5_000);
    expect(actual).toBeLessThanOrEqual(ms);
  };

  it("retries in ~2 minutes instead of waiting for the 45-minute tick, then queues a fresh marker", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const c = await seed(t);
      gh.fail = { status: 502 };
      expect(await t.action(api.bridge.ghToken, c)).toBeNull();
      near(await delay(t, c.dorkId), 120_000);
      vi.advanceTimersByTime(121_000); // the timer fires (it re-arms itself, so don't run to completion)
      await t.finishInProgressScheduledFunctions();
      expect((await t.run((ctx) => ctx.db.query("commands").collect())).map((x) => x.kind)).toEqual(["gh_token"]);
      near(await delay(t, c.dorkId), 45 * 60_000); // back on the normal cadence
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off 2, 4, 8, 10 minutes and tells the user once after 3 consecutive failures", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.fail = { status: 503 };
    const seen: (number | null)[] = [];
    const notices: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await t.action(api.bridge.ghToken, c)).toBeNull();
      seen.push(Math.round((await delay(t, c.dorkId))! / 60_000));
      notices.push((await eventsOf(t, c.dorkId)).filter((e: any) => e.type === "error").length);
    }
    expect(seen).toEqual([2, 4, 8, 10, 10]);
    expect(notices).toEqual([0, 0, 1, 1, 1]); // one notice, on the third failure
    expect(await eventsOf(t, c.dorkId)).toContainEqual({ type: "error", message: expect.stringContaining("GitHub access is failing") });
    // recovery resets the counter, so a later outage warns again
    gh.fail = null;
    expect(await t.action(api.bridge.ghToken, c)).toMatchObject({ t: "gh_token" });
    expect((await runtimeOf(t, c.dorkId))!.ghFailures).toBe(0);
  });

  it("a network error is retried like a 5xx", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.fail = "network";
    await t.action(api.bridge.ghToken, c);
    near(await delay(t, c.dorkId), 120_000);
  });

  it.each([401, 403, 404, 422])("GitHub %i is not retried early but is reported immediately, once", async (status) => {
    const t = convexTest(schema, modules);
    const c = await seed(t);
    gh.fail = { status };
    await t.action(api.bridge.ghToken, c);
    await t.action(api.bridge.ghToken, c);
    expect(await delay(t, c.dorkId)).toBeNull(); // no 2-minute loop against a permanent error
    const errors = (await eventsOf(t, c.dorkId)).filter((e: any) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(String(status)); // no GitHub detail in the transcript
  });

  it("does not retry or report for a dork that is not working or idle", async () => {
    const t = convexTest(schema, modules);
    const c = await seed(t, { state: "sleeping" });
    await t.mutation(internal.bridge.ghTokenFailed, { dorkId: c.dorkId, transient: true });
    expect((await runtimeOf(t, c.dorkId))!.timers).toEqual({});
    expect(await eventsOf(t, c.dorkId)).toEqual([]);
  });
});
