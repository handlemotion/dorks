/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Swap the provider so the test can inject "the user deletes the dork while createFromSnapshot is in flight".
const provider = vi.hoisted(() => ({
  created: [] as string[],
  deleted: [] as string[],
  failDeletes: 0,
  duringCreate: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(_s: string, o: { name: string }) {
      provider.created.push(o.name);
      await provider.duringCreate?.();
      return { id: `box-${o.name}` };
    },
    async delete(id: string) {
      if (provider.failDeletes > 0) {
        provider.failDeletes--;
        throw new Error("provider down");
      }
      provider.deleted.push(id);
    },
    async resume() {},
    async pause() {},
  }),
}));

const modules = import.meta.glob("../convex/**/*.*s");

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state: "creating", archived: false, lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
    return dorkId;
  });
}

beforeEach(() => {
  Object.assign(provider, { created: [], deleted: [], failDeletes: 0, duringCreate: undefined });
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
});

describe("delete vs create race", () => {
  it("normal create records the box", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.action(internal.boxes.create, { dorkId, gen: 0 });
    expect(await t.run((ctx) => ctx.db.get(dorkId).then((d) => d?.boxId))).toBe(`box-${dorkId}`);
    expect(provider.deleted).toEqual([]);
  });

  it("deleting during createFromSnapshot: the new box is deleted, not leaked", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    // The user hits delete while the provider call is awaiting: destroy sees no boxId and purges the rows.
    provider.duringCreate = async () => {
      await t.run((ctx) => ctx.db.patch(dorkId, { deleting: true }));
      await t.action(internal.boxes.destroy, { dorkId });
    };
    await t.action(internal.boxes.create, { dorkId, gen: 0 });
    expect(await t.run((ctx) => ctx.db.get(dorkId))).toBeNull(); // purged
    expect(provider.created).toEqual([dorkId]);
    expect(provider.deleted).toEqual([`box-${dorkId}`]); // the orphan was cleaned up
  });

  it("deleting but not yet purged is also treated as orphaned", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.duringCreate = async () => {
      await t.run((ctx) => ctx.db.patch(dorkId, { deleting: true }));
    };
    await t.action(internal.boxes.create, { dorkId, gen: 0 });
    expect(provider.deleted).toEqual([`box-${dorkId}`]);
    expect(await t.run((ctx) => ctx.db.get(dorkId).then((d) => d?.boxId))).toBeFalsy(); // never recorded
  });

  it("a dork already being deleted never gets a box", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.run((ctx) => ctx.db.patch(dorkId, { deleting: true }));
    await t.action(internal.boxes.create, { dorkId, gen: 0 });
    expect(provider.created).toEqual([]);
  });

  it("orphan delete failure is retried with backoff instead of leaking", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      provider.failDeletes = 2;
      await t.action(internal.boxes.deleteOrphan, { boxId: "box-x", attempt: 0 });
      expect(provider.deleted).toEqual([]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(provider.deleted).toEqual(["box-x"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opFailed on a deleted dork is a no-op", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.run((ctx) => ctx.db.delete(dorkId));
    await t.mutation(internal.lifecycle.opFailed, { dorkId, message: "x" }); // must not throw
  });
});
