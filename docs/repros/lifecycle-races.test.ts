/// <reference types="vite/client" />
// @vitest-environment edge-runtime
// Repros for docs/next-steps.md H1/H2. They assert the CURRENT (buggy) behaviour. To run: copy into apps/convex/test/ and
// `pnpm --filter @dorks/convex test`. When fixing P0-4, flip the BUG assertions and keep them as regression tests.
import { convexTest } from "convex-test";
import { beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { dispatch, enqueue } from "../convex/lib/dispatch";
import { bridgeSecret } from "../convex/lib/bridgeAuth";

vi.mock("../convex/lib/box", () => ({ getBox: () => ({ async createFromSnapshot() { return { id: "b" }; }, async delete() {}, async resume() {}, async pause() {} }) }));
const modules = import.meta.glob("../convex/**/*.*s");
beforeEach(() => { process.env.BRIDGE_SECRET_KEY = "k"; process.env.BASE_SNAPSHOT_ID = "s"; });

async function seed(t: ReturnType<typeof convexTest>, state: "working" | "idle", bridgeSeenAt: number) {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state, archived: false, boxId: "b", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt, bridgeLost: false, timers: {} });
    return dorkId;
  });
}
const rt = (t: any, dorkId: any) => t.run((ctx: any) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q: any) => q.eq("dorkId", dorkId)).unique());
const dork = (t: any, dorkId: any) => t.run((ctx: any) => ctx.db.get(dorkId));

it("REPRO bridge blip recovered by push (not heartbeat) leaves the watchdog armed -> error", async () => {
  const t = convexTest(schema, modules);
  const dorkId = await seed(t, "working", Date.now() - 200_000);
  await t.mutation(internal.lifecycle.timer, { dorkId, name: "bridge_watch" });
  expect((await rt(t, dorkId)).bridgeLost).toBe(true);
  expect((await rt(t, dorkId)).timers.watchdog).toBeDefined();
  const secret = await bridgeSecret(dorkId);
  await t.mutation(api.bridge.push, { dorkId, secret, frames: [] }); // bridge is back: its first call is a push
  await t.mutation(api.bridge.heartbeat, { dorkId, secret });
  expect((await rt(t, dorkId)).bridgeLost).toBe(false);
  expect((await rt(t, dorkId)).timers.watchdog).toBeDefined(); // BUG: never cancelled
  await t.mutation(internal.lifecycle.timer, { dorkId, name: "watchdog" });
  expect((await dork(t, dorkId)).state).toBe("error"); // healthy, connected dork killed
});

it("REPRO message arriving while a sleep-pause is in flight: dork ends up sleeping mid-turn", async () => {
  const t = convexTest(schema, modules);
  const dorkId = await seed(t, "idle", Date.now());
  await t.mutation(internal.lifecycle.timer, { dorkId, name: "sleep" }); // sleep_due -> flush requested, still idle
  await t.run(async (ctx) => { await enqueue(ctx, dorkId, "user_message", "hi"); await dispatch(ctx, dorkId, { t: "user_message" }); });
  expect((await dork(t, dorkId)).state).toBe("working");
  vi.useFakeTimers();
  try {
    await t.mutation(api.bridge.push, { dorkId, secret: await bridgeSecret(dorkId), frames: [{ t: "flushed" }] }); // bridge answers the flush
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally { vi.useRealTimers(); }
  expect((await dork(t, dorkId)).state).toBe("sleeping"); // BUG: box paused under a working turn
});
