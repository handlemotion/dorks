/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// H3: resume fails because the provider no longer has the box. The stale boxId must be cleared so the next message recreates it.
const provider = vi.hoisted(() => ({ resumeError: undefined as unknown, duringResume: undefined as undefined | (() => Promise<unknown>), created: [] as string[] }));
vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(_s: string, o: { name: string }) {
      provider.created.push(o.name);
      return { id: `new-box-${provider.created.length}` };
    },
    async resume() {
      await provider.duringResume?.();
      if (provider.resumeError) throw provider.resumeError;
    },
    async pause() {},
    async delete() {},
  }),
}));

type T = ReturnType<typeof convexTest>;
const modules = import.meta.glob("../convex/**/*.*s");

async function seed(t: T, state: "sleeping" | "waking" = "waking") {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state, archived: false, boxId: "box-old", claudeSessionId: "sess-old", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
    return dorkId;
  });
}
// The generation a box action is dispatched with (see dorkRuntime.opGen); a missing field means 0.
const opGen = (t: T, id: any) => t.run(async (ctx) => ((await (ctx.db as any).query("dorkRuntime").withIndex("by_dork", (q: any) => q.eq("dorkId", id)).unique())?.opGen ?? 0) as number);
const row = (t: T, id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<{ boxId?: string; claudeSessionId?: string; state: string } | null>;
const errors = (t: T, id: any) => t.run(async (ctx) => (await (ctx.db as any).query("events").withIndex("by_dork_seq", (q: any) => q.eq("dorkId", id)).collect() as { body: any }[]).map((e) => e.body).filter((b: any) => b.type === "error"));

beforeEach(() => {
  provider.resumeError = undefined;
  provider.duringResume = undefined;
  provider.created = [];
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
});

describe("resume when the box no longer exists", () => {
  for (const [label, err] of [
    ["BoxNotFoundError from the provider", Object.assign(new Error("boat resume: box not found (HTTP 404)"), { name: "BoxNotFoundError" })],
    ["a plain 'not found' error", new Error("Box not found")],
  ] as const) {
    it(`${label}: clears boxId, reports an error, and the next message creates a new box`, async () => {
      const t = convexTest(schema, modules);
      const dorkId = await seed(t);
      provider.resumeError = err;
      await t.action(internal.boxes.resume, { dorkId, gen: await opGen(t, dorkId) });

      const after = await row(t, dorkId);
      expect(after?.boxId).toBeUndefined();
      expect(after?.claudeSessionId).toBeUndefined(); // that session lived on the lost box's disk
      expect(after?.state).toBe("error");
      expect(await errors(t, dorkId)).toEqual([{ type: "error", message: expect.stringContaining("no longer exists"), error: { code: "failed", message: expect.stringContaining("no longer exists") } }]);

      // Same path the user's next message takes (machine: error + !hasBox -> create_box).
      await t.action(internal.boxes.create, { dorkId, gen: await opGen(t, dorkId) });
      expect((await row(t, dorkId))?.boxId).toBe("new-box-1");
      expect(provider.created).toEqual([dorkId]);
    });
  }

  it("any other failure keeps the box id (a transient error must not orphan a live box)", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.resumeError = new Error("boat resume: HTTP 503");
    await t.action(internal.boxes.resume, { dorkId, gen: await opGen(t, dorkId) });
    const after = await row(t, dorkId);
    expect(after?.boxId).toBe("box-old");
    expect(after?.state).toBe("error");
  });

  it("an auth error keeps the box id", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.resumeError = new Error("boat resume: unauthorized (HTTP 401); check BOAT_API_KEY");
    await t.action(internal.boxes.resume, { dorkId, gen: await opGen(t, dorkId) });
    expect((await row(t, dorkId))?.boxId).toBe("box-old");
  });

  it("a stale resume cannot clear a newer box: boxGone for a different boxId is a complete no-op", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.mutation(internal.lifecycle.boxGone, { dorkId, boxId: "box-older", message: "x" });
    const after = await row(t, dorkId);
    expect(after).toMatchObject({ boxId: "box-old", claudeSessionId: "sess-old", state: "waking" });
    expect(await errors(t, dorkId)).toEqual([]);
  });

  it("clearing the box, the error event and the state change happen in one mutation", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.mutation(internal.lifecycle.boxGone, { dorkId, boxId: "box-old", message: "gone" });
    const after = await row(t, dorkId);
    expect(after?.state).toBe("error");
    expect(after?.boxId).toBeUndefined();
    expect(after?.claudeSessionId).toBeUndefined();
    expect(await errors(t, dorkId)).toHaveLength(1);
    await t.mutation(internal.lifecycle.boxGone, { dorkId, boxId: "box-old", message: "gone" }); // replay: boxId already cleared
    expect(await errors(t, dorkId)).toHaveLength(1);
  });

  it("boxGone on a deleting or purged dork is a no-op", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.run((ctx) => ctx.db.patch(dorkId, { deleting: true }));
    await t.mutation(internal.lifecycle.boxGone, { dorkId, boxId: "box-old", message: "x" });
    expect((await row(t, dorkId))?.boxId).toBe("box-old");
    await t.run((ctx) => ctx.db.delete(dorkId));
    await t.mutation(internal.lifecycle.boxGone, { dorkId, boxId: "box-old", message: "x" });
  });

  it("the resume action passes the box it resumed, so a dork re-pointed mid-flight keeps its new box", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.resumeError = new Error("boat resume: box not found (HTTP 404)");
    provider.duringResume = () => t.run((ctx) => ctx.db.patch(dorkId, { boxId: "box-newer" }));
    await t.action(internal.boxes.resume, { dorkId, gen: await opGen(t, dorkId) });
    expect((await row(t, dorkId))?.boxId).toBe("box-newer");
  });
});
