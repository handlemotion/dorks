/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { dispatch, enqueue } from "../convex/lib/dispatch";
import schema from "../convex/schema";

const box = vi.hoisted(() => ({ calls: [] as string[], failResumes: 0, failPauses: 0 }));
vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(_s: string, o: { name: string }) {
      box.calls.push("create");
      return { id: `box-${o.name}` };
    },
    async resume() {
      box.calls.push("resume");
      if (box.failResumes-- > 0) throw new Error("resume down");
    },
    async pause() {
      box.calls.push("pause");
      if (box.failPauses-- > 0) throw new Error("pause down");
    },
    async delete() {},
  }),
}));

const modules = import.meta.glob("../convex/**/*.*s");
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
const NOW = 1_700_000_000_000;

async function seed(t: T, state: "creating" | "working" | "idle" | "sleeping" | "waking" | "error", o: { boxId?: string | null; archived?: boolean; bridgeSeenAt?: number; bridgeLost?: boolean; bridgeSeq?: number; opGen?: number } = {}) {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
    const boxId = o.boxId === undefined ? "box-1" : (o.boxId ?? undefined);
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state, archived: o.archived ?? false, boxId, lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: o.bridgeSeq ?? 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: o.bridgeSeenAt ?? Date.now(), bridgeLost: o.bridgeLost ?? false, timers: {}, opGen: o.opGen });
    return dorkId;
  });
}

const dorkOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.get(id));
const stateOf = async (t: T, id: Id<"dorks">) => (await dorkOf(t, id))!.state;
const rtOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", id)).unique().then((r) => r!));
const openCmds = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", id).eq("acked", false)).collect());
const kinds = async (t: T, id: Id<"dorks">) => (await openCmds(t, id)).map((c) => c.kind).sort();
const eventsOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", id)).collect());
const input = (t: T, id: Id<"dorks">, i: Parameters<typeof dispatch>[2]) => t.run((ctx) => dispatch(ctx, id, i));
const sendMessage = (t: T, id: Id<"dorks">, text = "hi") =>
  t.run(async (ctx) => {
    await enqueue(ctx, id, "user_message", text);
    await dispatch(ctx, id, { t: "user_message" });
  });
const timer = (t: T, dorkId: Id<"dorks">, name: string) => t.mutation(internal.lifecycle.timer, { dorkId, name });
const creds = async (dorkId: Id<"dorks">) => ({ dorkId, secret: await bridgeSecret(dorkId) });
const push = async (t: T, dorkId: Id<"dorks">, frames: unknown[]) => t.mutation(api.bridge.push, { ...(await creds(dorkId)), frames });
const ev = (bseq: number) => ({ t: "event", bseq, raw: { type: "assistant", message: { id: `m${bseq}`, content: [{ type: "text", text: `t${bseq}` }] } } });
// Advance 1ms per round: runs the 0-delay box actions without jumping over the 30s `bridge_watch` re-arm loop.
const settle = (t: T) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(box, { calls: [], failResumes: 0, failPauses: 0 });
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
});
afterEach(() => vi.useRealTimers());

describe("H1: a bridge blip must not kill a healthy dork", () => {
  const seen: Record<string, (t: T, id: Id<"dorks">) => Promise<unknown>> = {
    push: async (t, id) => push(t, id, []),
    heartbeat: async (t, id) => t.mutation(api.bridge.heartbeat, await creds(id)),
    connect: async (t, id) => t.mutation(api.bridge.connect, await creds(id)),
  };
  for (const state of ["working", "idle"] as const)
    for (const [name, call] of Object.entries(seen))
      it(`${name} after bridge_watch lost it cancels the watchdog (${state})`, async () => {
        const t = convexTest(schema, modules);
        const id = await seed(t, state, { bridgeSeenAt: Date.now() - 200_000 });
        await timer(t, id, "bridge_watch");
        let rt = await rtOf(t, id);
        expect(rt.bridgeLost).toBe(true);
        expect(rt.timers.watchdog).toBeDefined(); // armed by bridge_lost
        await call(t, id);
        rt = await rtOf(t, id);
        expect(rt.bridgeLost).toBe(false);
        expect(rt.timers.watchdog).toBeUndefined();
        await settle(t);
        expect(await stateOf(t, id)).toBe(state);
      });

  it("a bridge that never went missing leaves the watchdog alone (no spurious agent_ready)", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "waking");
    await input(t, id, { t: "bridge_lost" }); // arms the watchdog; waking is not working/idle
    await push(t, id, []);
    expect((await rtOf(t, id)).timers.watchdog).toBeDefined(); // only the `ready` frame ends the wait in waking
  });
});

describe("H2: a message during a sleep pause must not pause the box under a live turn", () => {
  const frames = async (t: T, id: Id<"dorks">) => (await t.query(api.bridge.commands, await creds(id))).filter((c) => c.frame.t === "user_message").map((c) => c.frame.t);
  const sleepFlush = async (t: T) => {
    const id = await seed(t, "idle");
    await timer(t, id, "sleep");
    expect(await stateOf(t, id)).toBe("idle");
    expect(await kinds(t, id)).toEqual(["flush"]); // the flush is enqueued, the state stays idle
    return id;
  };

  it("`flushed` after a message does not pause", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await sendMessage(t, id);
    expect(await stateOf(t, id)).toBe("working");
    expect(await kinds(t, id)).toEqual(["user_message"]); // pending flush deleted
    expect((await rtOf(t, id)).timers.flush).toBeUndefined();
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(await stateOf(t, id)).toBe("working");
    expect(box.calls).toEqual([]);
  });

  it("the flush timeout after a message does not pause", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await sendMessage(t, id);
    vi.advanceTimersByTime(20_000); // well past FLUSH_TIMEOUT_MS
    await settle(t);
    await timer(t, id, "flush"); // even if a stale timer run did slip through
    await settle(t);
    expect(await stateOf(t, id)).toBe("working");
    expect(box.calls).toEqual([]);
  });

  it("an uninterrupted sleep still pauses (control)", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(box.calls).toEqual(["pause"]);
    expect(await stateOf(t, id)).toBe("sleeping");
  });

  it("a message after `flushed` but before the box call lands: the pause lands, then the dork wakes with the message queued", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await push(t, id, [{ t: "flushed" }]); // boxes.pause is now scheduled
    await sendMessage(t, id);
    expect((await rtOf(t, id)).pause?.phase).toBe("cancelled");
    // The box is about to go down: the bridge must not be handed (and ack) the message now, or the turn dies with the box.
    expect(await frames(t, id)).toEqual([]);
    await settle(t);
    expect(box.calls).toEqual(["pause", "resume"]);
    expect(await stateOf(t, id)).toBe("waking");
    expect(await kinds(t, id)).toContain("user_message");
    await t.mutation(api.bridge.connect, await creds(id));
    await push(t, id, [{ t: "ready" }]); // the fresh bridge comes up: now it gets the message
    expect(await stateOf(t, id)).toBe("working");
    expect(await frames(t, id)).toContain("user_message");
  });

  it("messages are held back while the pause's box call is in flight (not only after a cancel)", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await t.run((ctx) => enqueue(ctx, id, "user_message", "unacked")); // sent before the pause, never delivered
    await push(t, id, [{ t: "flushed" }]);
    expect((await rtOf(t, id)).pause?.phase).toBe("pausing");
    expect(await frames(t, id)).toEqual([]);
  });

  it("queued work found when a pause lands wakes the dork again", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle", { bridgeSeenAt: 0 }); // silent bridge: paused directly
    await timer(t, id, "sleep");
    await t.run((ctx) => enqueue(ctx, id, "user_message", "late")); // persisted but never dispatched
    await settle(t);
    expect(box.calls).toEqual(["pause", "resume"]);
    expect(await stateOf(t, id)).toBe("waking");
  });

  it("archiving during a sleep flush still pauses exactly once", async () => {
    const t = convexTest(schema, modules);
    const id = await sleepFlush(t);
    await input(t, id, { t: "archive" });
    expect(await kinds(t, id)).toEqual(["flush"]);
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(box.calls).toEqual(["pause"]);
    const d = await dorkOf(t, id);
    expect([d!.state, d!.archived]).toEqual(["sleeping", true]);
  });

  it("a message to an archived dork is rejected and does not cancel the archive pause", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle");
    await input(t, id, { t: "archive" });
    expect((await input(t, id, { t: "user_message" }))?.rejected).toBe("archived");
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(await stateOf(t, id)).toBe("sleeping");
  });
});

describe("R1: error pauses the box", () => {
  it("watchdog -> error -> box paused -> sleeping; the next message wakes it", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working", { bridgeSeenAt: 0 });
    await timer(t, id, "watchdog");
    expect(await stateOf(t, id)).toBe("error");
    await settle(t);
    expect(box.calls).toEqual(["pause"]);
    expect(await stateOf(t, id)).toBe("sleeping");
    await sendMessage(t, id);
    await settle(t);
    expect(box.calls).toEqual(["pause", "resume"]);
    expect(await stateOf(t, id)).toBe("waking");
  });

  it("agent_exited with a live bridge flushes, then pauses", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working");
    await push(t, id, [{ t: "agent_exited", code: 1, stderrTail: "" }]);
    expect(await stateOf(t, id)).toBe("error");
    expect(await kinds(t, id)).toEqual(["flush"]);
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(box.calls).toEqual(["pause"]);
    expect(await stateOf(t, id)).toBe("sleeping");
  });

  it("a failed create (no box yet) has nothing to pause", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "creating", { boxId: null });
    await t.mutation(internal.lifecycle.opFailed, { dorkId: id, message: "x" });
    await settle(t);
    expect(await stateOf(t, id)).toBe("error");
    expect(box.calls).toEqual([]);
  });

  it("a failing pause from error does not loop", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working", { bridgeSeenAt: 0 });
    box.failPauses = 5;
    await timer(t, id, "watchdog");
    await settle(t);
    expect(box.calls).toEqual(["pause"]);
    expect(await stateOf(t, id)).toBe("error");
  });
});

describe("R2: stale control rows do not replay into the next wake", () => {
  const frames = async (t: T, id: Id<"dorks">) => (await t.query(api.bridge.commands, await creds(id))).map((c) => c.frame.t);

  it("a flush row that survived a flush timeout is not re-emitted while waking", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle");
    await timer(t, id, "sleep");
    await timer(t, id, "flush"); // the bridge never answered: timeout pauses the box
    await settle(t);
    expect(await stateOf(t, id)).toBe("sleeping");
    expect(await kinds(t, id)).toEqual([]);
    await sendMessage(t, id);
    expect(await stateOf(t, id)).toBe("waking");
    await t.mutation(api.bridge.connect, await creds(id)); // new bridge dials in
    expect(await frames(t, id)).toEqual(["fetch_configure"]);
    await push(t, id, [{ t: "ready" }]);
    expect(await stateOf(t, id)).toBe("working");
    expect(await frames(t, id)).toEqual(["user_message", "fetch_configure"]);
  });

  it("leftover interrupt rows do not hit the first turn after a wake", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle", { bridgeSeenAt: 0 });
    await t.run((ctx) => enqueue(ctx, id, "interrupt"));
    await timer(t, id, "sleep");
    await settle(t);
    expect(await stateOf(t, id)).toBe("sleeping");
    expect(await kinds(t, id)).toEqual([]);
  });

  it("rows left in `sleeping` by any path are cleared when the wake starts; messages are kept", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "sleeping");
    await t.run(async (ctx) => {
      await enqueue(ctx, id, "interrupt");
      await enqueue(ctx, id, "flush");
      await enqueue(ctx, id, "gh_token");
    });
    await sendMessage(t, id, "keep me");
    expect(await kinds(t, id)).toEqual(["user_message"]);
  });

  it("an unacked message survives the pause", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle", { bridgeSeenAt: 0 });
    await t.run((ctx) => enqueue(ctx, id, "user_message", "pending"));
    await t.run((ctx) => enqueue(ctx, id, "flush"));
    await input(t, id, { t: "paused" });
    expect(await kinds(t, id)).toEqual(["user_message"]);
  });
});

describe("R4: strict bseq", () => {
  const stored = async (t: T, id: Id<"dorks">) => (await eventsOf(t, id)).filter((e) => e.body.type === "assistant_message").length;

  it("in order frames are accepted", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working");
    expect(await push(t, id, [ev(1), ev(2), ev(3)])).toEqual({ ok: true });
    expect((await rtOf(t, id)).bridgeSeq).toBe(3);
    expect(await stored(t, id)).toBe(3);
  });

  it("a call containing a gap applies nothing; the bridge resends from expectedBseq and nothing is lost or doubled", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working");
    expect(await push(t, id, [ev(1), ev(2), ev(5), ev(6), { t: "ready" }])).toEqual({ ok: false, expectedBseq: 1 });
    expect((await rtOf(t, id)).bridgeSeq).toBe(0);
    expect(await stored(t, id)).toBe(0);
    expect(await push(t, id, [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)])).toEqual({ ok: true });
    expect(await stored(t, id)).toBe(6);
    expect((await eventsOf(t, id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a gap after already-stored events reports bridgeSeq + 1, and control frames before the gap are not applied twice", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working", { bridgeSeq: 2 });
    const exited = { t: "agent_exited", code: 1, stderrTail: "" };
    expect(await push(t, id, [exited, ev(2), ev(3), ev(5)])).toEqual({ ok: false, expectedBseq: 3 });
    expect((await eventsOf(t, id)).filter((e) => e.body.type === "agent_exited")).toHaveLength(0);
    expect(await stateOf(t, id)).toBe("working");
    expect(await push(t, id, [exited, ev(3), ev(4), ev(5)])).toEqual({ ok: true }); // the bridge resends the whole tail
    expect((await eventsOf(t, id)).filter((e) => e.body.type === "agent_exited")).toHaveLength(1);
  });

  it("a truncation stub in place of an oversized event keeps the numbering moving", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working");
    expect(await push(t, id, [ev(1), { t: "event", bseq: 2, raw: { type: "truncated", truncated: true, was: "user" } }, ev(3)])).toEqual({ ok: true });
    expect((await rtOf(t, id)).bridgeSeq).toBe(3);
    expect(await stored(t, id)).toBe(2);
  });

  it("a hostile bseq cannot mute the dork", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working");
    expect(await push(t, id, [ev(2 ** 53 - 1)])).toEqual({ ok: false, expectedBseq: 1 });
    expect((await rtOf(t, id)).bridgeSeq).toBe(0);
    expect(await push(t, id, [ev(1)])).toEqual({ ok: true });
    expect(await stored(t, id)).toBe(1);
  });

  it("replayed frames (<= bridgeSeq) are ignored without error", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "working", { bridgeSeq: 4 });
    expect(await push(t, id, [ev(3), ev(4), ev(5)])).toEqual({ ok: true });
    expect(await stored(t, id)).toBe(1);
    expect((await rtOf(t, id)).bridgeSeq).toBe(5);
  });

  describe("H9: size caps", () => {
    const code = (e: unknown) => (e as { data?: { code?: string } })?.data?.code;

    it("rejects more than 500 frames per push, accepts 500", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "working");
      const many = Array.from({ length: 501 }, (_, i) => ev(i + 1));
      expect(code(await push(t, id, many).then(() => null, (e) => e))).toBe("too_many_frames");
      expect((await rtOf(t, id)).bridgeSeq).toBe(0);
      expect(await push(t, id, many.slice(0, 500))).toEqual({ ok: true });
      expect((await rtOf(t, id)).bridgeSeq).toBe(500);
    });

    it("rejects an event over 256KB and stores nothing from that call", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "working");
      const big = { t: "event", bseq: 2, raw: { type: "assistant", message: { id: "m", content: [{ type: "text", text: "x".repeat(256 * 1024) }] } } };
      expect(code(await push(t, id, [ev(1), big]).then(() => null, (e) => e))).toBe("event_too_large");
      expect(await stored(t, id)).toBe(0);
      const ok = { t: "event", bseq: 1, raw: { type: "assistant", message: { id: "m", content: [{ type: "text", text: "x".repeat(200 * 1024) }] } } };
      expect(await push(t, id, [ok])).toEqual({ ok: true });
    });
  });
});

describe("R5: box results are tied to the operation that produced them", () => {
  it("a failure from a superseded resume does not flip the newer attempt to error", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "sleeping", { opGen: 0 });
    box.failResumes = 1; // the first resume attempt fails, slowly
    await sendMessage(t, id); // waking, resume gen 1 scheduled
    expect((await rtOf(t, id)).opGen).toBe(1);
    // before it runs: the attempt is abandoned and retried (watchdog -> error -> message -> waking), so gen 1 is superseded
    await input(t, id, { t: "watchdog" });
    await sendMessage(t, id, "again");
    expect((await rtOf(t, id)).opGen).toBe(3);
    await settle(t); // resume#1 fails -> stale opFailed; pause#2 lands stale; resume#3 succeeds
    expect(await stateOf(t, id)).toBe("waking");
    expect((await eventsOf(t, id)).filter((e) => e.body.type === "error").map((e) => e.body.message)).not.toContain("resume_box failed");
  });

  it("the current attempt's failure still moves the dork to error", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "sleeping");
    box.failResumes = 1;
    await sendMessage(t, id);
    await settle(t);
    expect(await stateOf(t, id)).toBe("error");
  });

  it("opFailed / boxPaused with a stale generation are no-ops", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "waking", { opGen: 7 });
    await t.mutation(internal.lifecycle.opFailed, { dorkId: id, message: "x", gen: 6 });
    await t.mutation(internal.lifecycle.boxPaused, { dorkId: id, gen: 6 });
    expect(await stateOf(t, id)).toBe("waking");
    await t.mutation(internal.lifecycle.opFailed, { dorkId: id, message: "x", gen: 7 });
    expect(await stateOf(t, id)).toBe("error");
  });

  it("a duplicate result for the same operation is ignored once it has been consumed", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "idle", { bridgeSeenAt: 0 });
    await timer(t, id, "sleep");
    const gen = (await rtOf(t, id)).opGen!;
    await settle(t);
    expect(await stateOf(t, id)).toBe("sleeping");
    await sendMessage(t, id);
    expect(await stateOf(t, id)).toBe("waking");
    const before = await rtOf(t, id);
    await t.mutation(internal.lifecycle.boxPaused, { dorkId: id, gen }); // late duplicate of the old pause
    expect(await rtOf(t, id)).toEqual(before);
    expect(await stateOf(t, id)).toBe("waking");
    expect(box.calls).toEqual(["pause"]); // and it did not trigger a second wake
  });

  it("a stale create that finishes after a newer one recorded a different box is orphaned", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, "creating", { boxId: "box-new", opGen: 2 });
    expect(await t.mutation(internal.lifecycle.boxCreated, { dorkId: id, boxId: "box-old", sleepMinutes: 5, gen: 1 })).toBe("orphaned");
    expect((await dorkOf(t, id))!.boxId).toBe("box-new");
    expect(await t.mutation(internal.lifecycle.boxCreated, { dorkId: id, boxId: "box-new", sleepMinutes: 5, gen: 2 })).toBe("ok");
  });
});

describe("review fixes", () => {
  const errors = async (t: T, id: Id<"dorks">) => (await eventsOf(t, id)).filter((e) => e.body.type === "error");
  const advance = async (t: T, ms: number) => {
    vi.advanceTimersByTime(ms);
    await settle(t);
  };

  describe("error with a queued message does not loop resume/pause", () => {
    it("a wake that never produces a bridge ends in sleeping, once", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "sleeping");
      await sendMessage(t, id); // waking, the message stays queued (the bridge never comes up)
      await settle(t);
      await timer(t, id, "watchdog"); // -> error -> flush (nobody answers) -> pause -> sleeping, message still queued
      await advance(t, 11_000);
      expect(await stateOf(t, id)).toBe("sleeping");
      await advance(t, 600_000);
      expect(box.calls).toEqual(["resume", "pause"]); // not resume, pause, resume, pause, ...
      expect(await errors(t, id)).toHaveLength(1);
      expect(await kinds(t, id)).toEqual(["user_message"]); // still there for the next wake
      await sendMessage(t, id, "again");
      expect(await stateOf(t, id)).toBe("waking"); // the next message wakes it
    });
  });

  describe("a lost pause does not block later ones", () => {
    it("a `pausing` intent older than the stuck window is replaced", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "idle");
      await t.run(async (ctx) => {
        const rt = await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", id)).unique();
        await ctx.db.patch(rt!._id, { opGen: 3, pause: { gen: 3, phase: "pausing", since: Date.now() } }); // boxes.pause died silently
      });
      await timer(t, id, "sleep");
      await settle(t);
      expect(box.calls).toEqual([]); // still within the window: trusted
      vi.setSystemTime(NOW + 121_000);
      await timer(t, id, "sleep");
      await settle(t);
      expect(box.calls).toEqual(["pause"]);
      expect(await stateOf(t, id)).toBe("sleeping");
    });
  });

  describe("a failed pause from error is retried with backoff, capped", () => {
    it("retries until the box pauses", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "working", { bridgeSeenAt: 0 });
      box.failPauses = 3;
      await timer(t, id, "watchdog");
      await settle(t);
      expect(box.calls).toEqual(["pause"]);
      expect((await rtOf(t, id)).timers.pause_retry).toBeDefined();
      for (const wait of [15_000, 30_000, 60_000]) await advance(t, wait);
      expect(box.calls).toEqual(["pause", "pause", "pause", "pause"]);
      expect(await stateOf(t, id)).toBe("sleeping");
      expect((await rtOf(t, id)).timers.pause_retry).toBeUndefined();
    });

    it("gives up after the cap and leaves error visible", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "working", { bridgeSeenAt: 0 });
      box.failPauses = 1000;
      await timer(t, id, "watchdog");
      await settle(t);
      for (let i = 0; i < 12; i++) await advance(t, 15 * 60_000);
      expect(box.calls).toHaveLength(1 + 6); // the first attempt + MAX_PAUSE_RETRIES
      expect(await stateOf(t, id)).toBe("error");
    });

    it("a message cancels the pending retry (it starts a wake instead)", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "working", { bridgeSeenAt: 0 });
      box.failPauses = 1;
      await timer(t, id, "watchdog");
      await settle(t);
      expect((await rtOf(t, id)).timers.pause_retry).toBeDefined();
      await sendMessage(t, id);
      expect(await stateOf(t, id)).toBe("waking");
      expect((await rtOf(t, id)).timers.pause_retry).toBeUndefined();
    });
  });

  describe("a box that lands after the dork gave up is paused", () => {
    it("a create that finishes after the watchdog (error, no box yet)", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "creating", { boxId: null, opGen: 1, bridgeSeenAt: 0 });
      await timer(t, id, "watchdog");
      expect(await stateOf(t, id)).toBe("error");
      expect(await t.mutation(internal.lifecycle.boxCreated, { dorkId: id, boxId: "box-late", sleepMinutes: 5, gen: 1 })).toBe("ok");
      await settle(t);
      expect(box.calls).toEqual(["pause"]);
      expect((await dorkOf(t, id))!.boxId).toBe("box-late");
      expect(await stateOf(t, id)).toBe("sleeping");
    });

    it("a resume that finishes after the dork went to error, even after its pause already landed", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "waking", { opGen: 1, bridgeSeenAt: 0 });
      await timer(t, id, "watchdog"); // error + pause (gen 2)
      await settle(t);
      expect(await stateOf(t, id)).toBe("sleeping"); // the pause beat the slow resume
      await t.mutation(internal.lifecycle.boxResumed, { dorkId: id }); // now the resume lands: the box is running again
      await settle(t);
      expect(box.calls).toEqual(["pause", "pause"]);
      expect(await stateOf(t, id)).toBe("sleeping");
    });

    it("a resume that lands while the dork's own pause is still in flight pauses again (the old one may finish first)", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "waking", { opGen: 1, bridgeSeenAt: 0 });
      await timer(t, id, "watchdog"); // error + pause (gen 2), box action scheduled but not run yet
      expect((await rtOf(t, id)).pause?.phase).toBe("pausing");
      await t.mutation(internal.lifecycle.boxResumed, { dorkId: id });
      await settle(t);
      expect(box.calls).toEqual(["pause", "pause"]); // one issued after the resume landed, so it is ordered after it
      expect(await stateOf(t, id)).toBe("sleeping");
    });

    it("a resume the dork is still waiting for just queues configure", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "waking");
      await t.mutation(internal.lifecycle.boxResumed, { dorkId: id });
      await settle(t);
      expect(box.calls).toEqual([]);
      expect(await kinds(t, id)).toEqual(["configure"]);
    });
  });

  describe("`flushed` names the flush it answers", () => {
    it("a straggler from a cancelled flush cannot end the next one early", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "idle");
      await timer(t, id, "sleep");
      const first = (await openCmds(t, id)).find((c) => c.kind === "flush")!.cid;
      await sendMessage(t, id); // cancels
      await input(t, id, { t: "archive" }); // a new pause, a new flush
      const second = (await openCmds(t, id)).find((c) => c.kind === "flush")!.cid;
      expect(second).not.toBe(first);
      await push(t, id, [{ t: "flushed", cid: first }]);
      await settle(t);
      expect(box.calls).toEqual([]);
      expect((await rtOf(t, id)).pause?.phase).toBe("flushing");
      await push(t, id, [{ t: "flushed", cid: second }]);
      await settle(t);
      expect(box.calls).toEqual(["pause"]);
    });

    it("a `flushed` without a cid (older bridge) still answers the current flush", async () => {
      const t = convexTest(schema, modules);
      const id = await seed(t, "idle");
      await timer(t, id, "sleep");
      await push(t, id, [{ t: "flushed" }]);
      await settle(t);
      expect(box.calls).toEqual(["pause"]);
    });
  });
});
