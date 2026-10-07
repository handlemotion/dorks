/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// H3: resume fails because the provider no longer has the box. The stale boxId must be cleared so the next message recreates it.
const provider = vi.hoisted(() => ({ resumeError: undefined as unknown, created: [] as string[] }));
vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(_s: string, o: { name: string }) {
      provider.created.push(o.name);
      return { id: `new-box-${provider.created.length}` };
    },
    async resume() {
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
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state, archived: false, boxId: "box-old", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
    return dorkId;
  });
}
const row = (t: T, id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<{ boxId?: string; state: string } | null>;
const errors = (t: T, id: any) => t.run(async (ctx) => (await (ctx.db as any).query("events").withIndex("by_dork_seq", (q: any) => q.eq("dorkId", id)).collect() as { body: any }[]).map((e) => e.body).filter((b: any) => b.type === "error"));

beforeEach(() => {
  provider.resumeError = undefined;
  provider.created = [];
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
});

describe("resume when the box no longer exists", () => {
  for (const [label, err] of [
    ["BoxNotFoundError from the provider", Object.assign(new Error("upstash resume: box not found (HTTP 404)"), { name: "BoxNotFoundError" })],
    ["a plain 'not found' error", new Error("Box not found")],
  ] as const) {
    it(`${label}: clears boxId, reports an error, and the next message creates a new box`, async () => {
      const t = convexTest(schema, modules);
      const dorkId = await seed(t);
      provider.resumeError = err;
      await t.action(internal.boxes.resume, { dorkId });

      const after = await row(t, dorkId);
      expect(after?.boxId).toBeUndefined();
      expect(after?.state).toBe("error");
      expect(await errors(t, dorkId)).toEqual([{ type: "error", message: expect.stringContaining("no longer exists") }]);

      // Same path the user's next message takes (machine: error + !hasBox -> create_box).
      await t.action(internal.boxes.create, { dorkId });
      expect((await row(t, dorkId))?.boxId).toBe("new-box-1");
      expect(provider.created).toEqual([dorkId]);
    });
  }

  it("any other failure keeps the box id (a transient error must not orphan a live box)", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.resumeError = new Error("upstash resume: HTTP 503");
    await t.action(internal.boxes.resume, { dorkId });
    const after = await row(t, dorkId);
    expect(after?.boxId).toBe("box-old");
    expect(after?.state).toBe("error");
  });

  it("an auth error keeps the box id", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    provider.resumeError = new Error("upstash resume: unauthorized (HTTP 401); check UPSTASH_BOX_API_KEY");
    await t.action(internal.boxes.resume, { dorkId });
    expect((await row(t, dorkId))?.boxId).toBe("box-old");
  });

  it("forgetBox on a dork without a box, or a deleted dork, is a no-op", async () => {
    const t = convexTest(schema, modules);
    const dorkId = await seed(t);
    await t.mutation(internal.boxes.forgetBox, { dorkId });
    await t.mutation(internal.boxes.forgetBox, { dorkId });
    await t.run((ctx) => ctx.db.delete(dorkId));
    await t.mutation(internal.boxes.forgetBox, { dorkId });
  });
});
