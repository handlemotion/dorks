/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { buildBaseSnapshot, verifyUpstashKey } from "../convex/lib/workstationBuild";

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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
});
afterEach(() => {
  delete process.env.BOX_PROVIDER;
  vi.unstubAllGlobals();
});

describe("Upstash key (bring your own)", () => {
  it("verifyUpstashKey accepts a working key and rejects 401 without echoing anything", async () => {
    await expect(verifyUpstashKey({ apiKey: "k", fetch: async () => json([]) })).resolves.toBeUndefined();
    await expect(verifyUpstashKey({ apiKey: "k", fetch: async () => json({ error: "secret-echo" }, 401) })).rejects.toThrow("rejected this API key");
    await expect(verifyUpstashKey({ apiKey: "k", fetch: async () => { throw new Error("boom"); } })).rejects.toThrow("could not reach Upstash");
  });

  it("setUpstashKey checks the key, stores it encrypted, and onboarding only shows a boolean", async () => {
    const t = convexTest(schema, modules);
    const u1 = t.withIdentity({ subject: "u1" });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => json((init.headers as Record<string, string>)["X-Box-Api-Key"] === "good-key" ? [] : {}, (init.headers as Record<string, string>)["X-Box-Api-Key"] === "good-key" ? 200 : 401));
    expect(await rejects(u1.action(api.settings.setUpstashKey, { key: "bad-key" }))).toBe("invalid");
    expect(await rejects(u1.action(api.settings.setUpstashKey, { key: "  " }))).toBe("invalid");
    await u1.action(api.settings.setUpstashKey, { key: " good-key " });
    const row = await t.run((ctx) => ctx.db.query("userSettings").first());
    expect(row?.upstashKeyEnc).toMatch(/^v1:/);
    expect(row?.upstashKeyEnc).not.toContain("good-key");
    const o = await u1.query(api.settings.onboarding, {});
    expect(o.upstashKey).toBe(true);
    expect(JSON.stringify(o)).not.toContain("good-key");
    // another user cannot read it back
    expect(await t.query(internal.settings.upstashKeyEnc, { userId: "u2" })).toBeNull();
  });

  it("a different key forgets the image (it lives in the old account); the same key keeps it", async () => {
    const t = convexTest(schema, modules);
    const u1 = t.withIdentity({ subject: "u1" });
    vi.stubGlobal("fetch", async () => json([]));
    await u1.action(api.settings.setUpstashKey, { key: "key-a" });
    await t.run(async (ctx) => {
      const r = (await ctx.db.query("userSettings").first())!;
      await ctx.db.patch(r._id, { workstationSnapshotId: "snap-a", workstationStatus: "ready" });
    });
    await u1.action(api.settings.setUpstashKey, { key: "key-a" });
    expect((await t.run((ctx) => ctx.db.query("userSettings").first()))?.workstationSnapshotId).toBe("snap-a");
    await u1.action(api.settings.setUpstashKey, { key: "key-b" });
    const after = await t.run((ctx) => ctx.db.query("userSettings").first());
    expect(after?.workstationSnapshotId).toBeUndefined();
    expect(after?.workstationStatus).toBeUndefined();
  });
});

describe("dorks.create with BOX_PROVIDER=upstash", () => {
  const ready = async (over: Record<string, unknown>) => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, claudeTokenEnc: "enc", githubInstallationId: 1, ...over }));
    return t.withIdentity({ subject: "u1" });
  };
  it("needs the user's key and a built image; the platform BASE_SNAPSHOT_ID is never used", async () => {
    process.env.BOX_PROVIDER = "upstash";
    process.env.BASE_SNAPSHOT_ID = "platform-snap";
    expect(await rejects((await ready({})).mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("onboarding_incomplete");
    expect(await rejects((await ready({ upstashKeyEnc: "x" })).mutation(api.dorks.create, { repo: "o/r", message: "hi" }))).toBe("onboarding_incomplete");
    const ok = await ready({ upstashKeyEnc: "x", workstationSnapshotId: "snap-u1" });
    expect(await ok.mutation(api.dorks.create, { repo: "o/r", message: "hi" })).toBeTruthy();
  });
  it("does not gate on the key for the sim provider", async () => {
    process.env.BOX_PROVIDER = "sim";
    expect(await (await ready({})).mutation(api.dorks.create, { repo: "o/r", message: "hi" })).toBeTruthy();
  });
});

describe("boxInfo snapshot", () => {
  it("upstash uses only the user's own image; other providers fall back to BASE_SNAPSHOT_ID", async () => {
    const t = convexTest(schema, modules);
    process.env.BASE_SNAPSHOT_ID = "platform-snap";
    const id = await t.run(async (ctx) => {
      await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
      return ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "b", state: "idle", archived: false, lastActivityAt: 1 });
    });
    process.env.BOX_PROVIDER = "upstash";
    expect((await t.query(internal.lifecycle.boxInfo, { dorkId: id }))?.snapshotId).toBe("");
    process.env.BOX_PROVIDER = "sim";
    expect((await t.query(internal.lifecycle.boxInfo, { dorkId: id }))?.snapshotId).toBe("platform-snap");
  });
});

describe("buildBaseSnapshot", () => {
  const script = (calls: string[], over: { execExit?: number } = {}) =>
    (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const m = init.method ?? "GET";
      calls.push(`${m} ${path}`);
      if (m === "POST" && path === "/v2/box") return json({ id: "b1", status: "creating" });
      if (m === "GET" && path === "/v2/box/b1") return json({ id: "b1", status: "idle" });
      if (path.endsWith("/files/upload")) return json({});
      if (path.endsWith("/exec")) return json({ exit_code: over.execExit ?? 0, output: "" });
      if (m === "POST" && path.endsWith("/snapshots")) return json({ id: "snap-1", status: "creating" });
      if (m === "GET" && path.endsWith("/snapshots")) return json({ snapshots: [{ id: "snap-1", status: "ready" }] });
      if (m === "DELETE") return json({});
      return json({}, 404);
    }) as unknown as typeof fetch;
  const opts = (f: typeof fetch) => ({ apiKey: "k", bundle: new Blob(["x"]), snapshotName: "dorks-base-1", fetch: f, sleep: async () => {} });

  it("runs the steps in order, returns the snapshot id and deletes the build box", async () => {
    const calls: string[] = [];
    expect(await buildBaseSnapshot(opts(script(calls)))).toBe("snap-1");
    expect(calls[0]).toBe("POST /v2/box");
    expect(calls.filter((c) => c.endsWith("/exec"))).toHaveLength(3);
    expect(calls.at(-1)).toBe("DELETE /v2/box/b1");
  });
  it("a failing step still deletes the build box and does not leak output into the error", async () => {
    const calls: string[] = [];
    await expect(buildBaseSnapshot(opts(script(calls, { execExit: 3 })))).rejects.toThrow("command failed (exit 3)");
    expect(calls.at(-1)).toBe("DELETE /v2/box/b1");
  });
});
