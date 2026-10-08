/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { dispatch, enqueue } from "../convex/lib/dispatch";
import { enqueueNotification, NOTIFY_DEBOUNCE_MS } from "../convex/lib/notify";
import schema from "../convex/schema";

// Autonomy notifications through the lifecycle (docs/autonomy.md): debounce + coalesce, then delivery rules per state.

const box = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(_s: string, o: { name: string }) {
      box.calls.push("create");
      return { id: `box-${o.name}` };
    },
    async resume() {
      box.calls.push("resume");
    },
    async pause() {
      box.calls.push("pause");
    },
    async delete() {},
  }),
}));

const modules = import.meta.glob("../convex/**/*.*s");
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
const NOW = 1_700_000_000_000;

async function seed(t: T, state: "creating" | "working" | "idle" | "sleeping" | "waking" | "error", o: { archived?: boolean; bridgeSeenAt?: number } = {}) {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5 });
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "agent/x", state, archived: o.archived ?? false, boxId: "box-1", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: o.bridgeSeenAt ?? Date.now(), bridgeLost: false, timers: {} });
    return dorkId;
  });
}
const subscribeTo = (t: T, dorkId: Id<"dorks">, number = 12, over: { ciFixAttempts?: number } = {}) =>
  t.run((ctx) =>
    ctx.db.insert("prSubscriptions", {
      dorkId, userId: "u1", repo: "octo/hello", number, url: `https://github.com/octo/hello/pull/${number}`, title: "Add thing", headRef: "agent/x", baseRef: "main",
      source: "agent", status: "active", ci: "unknown", review: "none", mergeable: null, ciFixAttempts: over.ciFixAttempts ?? 0, state: "open", lastEventAt: 1,
    }),
  );

const dorkOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.get(id));
const stateOf = async (t: T, id: Id<"dorks">) => (await dorkOf(t, id))!.state;
const rtOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", id)).unique().then((r) => r!));
const cmds = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", id)).collect());
const eventsOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", id)).collect().then((r) => r.map((e) => e.body)));
const inboxOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("inbox").withIndex("by_dork_delivered", (q) => q.eq("dorkId", id)).collect());
const notify = (t: T, dorkId: Id<"dorks">, subId: Id<"prSubscriptions">, kind: Parameters<typeof enqueueNotification>[3], summary: string, deliveryId?: string) =>
  t.run((ctx) => enqueueNotification(ctx, dorkId, subId, kind, summary, deliveryId));
const fire = (t: T, dorkId: Id<"dorks">) => t.mutation(internal.lifecycle.timer, { dorkId, name: "notify" });
const creds = async (dorkId: Id<"dorks">) => ({ dorkId, secret: await bridgeSecret(dorkId) });
const push = async (t: T, dorkId: Id<"dorks">, frames: unknown[]) => t.mutation(api.bridge.push, { ...(await creds(dorkId)), frames });
const emitted = async (t: T, id: Id<"dorks">) => (await t.query(api.bridge.commands, await creds(id))).map((c) => c.frame.t);
const notifyRow = async (t: T, id: Id<"dorks">) => (await cmds(t, id)).filter((c) => c.kind === "notify");
const sendMessage = (t: T, id: Id<"dorks">, text = "hi") =>
  t.run(async (ctx) => {
    await enqueue(ctx, id, "user_message", text);
    await dispatch(ctx, id, { t: "user_message" });
  });
let bseq = 0;
const turnIdle = (t: T, id: Id<"dorks">) => push(t, id, [{ t: "event", bseq: ++bseq, raw: { type: "system", subtype: "session_state_changed", state: "idle" } }]);
const ack = (t: T, id: Id<"dorks">, cid: string) => push(t, id, [{ t: "ack", id: cid }]);
const settle = (t: T) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  bseq = 0;
  box.calls = [];
  process.env.BASE_SNAPSHOT_ID = "snap-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
});
afterEach(() => vi.useRealTimers());

describe("debounce and coalesce", () => {
  it("buffers events and arms one ~45s timer per dork; nothing is delivered until it fires", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const sub = await subscribeTo(t, id);
    await notify(t, id, sub, "comment", "alice: rename it", "d1");
    await notify(t, id, sub, "ci_failed", "test failed", "d2");
    const rt = await rtOf(t, id);
    const job = await t.run((ctx) => ctx.db.system.get(rt.timers.notify as Id<"_scheduled_functions">));
    expect(job!.scheduledTime - NOW).toBe(NOTIFY_DEBOUNCE_MS);
    expect(NOTIFY_DEBOUNCE_MS).toBe(45_000);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect().then((r) => r.filter((j) => j.name === "lifecycle:timer").length))).toBe(1);
    expect((await inboxOf(t, id)).map((r) => [r.kind, r.deliveryId, r.delivered])).toEqual([["comment", "d1", false], ["ci_failed", "d2", false]]);
    expect(await notifyRow(t, id)).toEqual([]);
  });

  it("the window does not slide: a later event does not postpone the notification", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const sub = await subscribeTo(t, id);
    await notify(t, id, sub, "comment", "a");
    const first = (await rtOf(t, id)).timers.notify;
    vi.advanceTimersByTime(30_000);
    await notify(t, id, sub, "comment", "b");
    expect((await rtOf(t, id)).timers.notify).toBe(first);
  });

  it("folds everything pending into ONE notify command, one transcript card, and marks the rows delivered", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const a = await subscribeTo(t, id, 12);
    const b = await subscribeTo(t, id, 13);
    await notify(t, id, a, "comment", "alice: rename it");
    await notify(t, id, b, "conflict", "no longer mergeable");
    await notify(t, id, a, "ci_failed", "test failed");
    await fire(t, id);

    const rows = await notifyRow(t, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('<dorks-event source="github" kinds="ci_failed,comment,conflict" prs="octo/hello#12,octo/hello#13">');
    expect(rows[0].text).toContain("gh run view --log-failed");
    expect(rows[0].meta).toEqual({ kinds: ["ci_failed", "comment", "conflict"], prs: [{ repo: "octo/hello", number: 12 }, { repo: "octo/hello", number: 13 }] });
    const cards = (await eventsOf(t, id)).filter((e: any) => e.type === "notify");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kinds: ["ci_failed", "comment", "conflict"], text: expect.stringContaining("## octo/hello#12: Add thing") });
    expect((cards[0] as any).text).not.toContain("dorks-event");
    expect((await inboxOf(t, id)).every((r) => r.delivered)).toBe(true);
    expect((await rtOf(t, id)).timers.notify).toBeUndefined();
    // a new window starts with the next event
    await notify(t, id, a, "review", "approved");
    expect((await rtOf(t, id)).timers.notify).toBeDefined();
  });

  it("the second CI failure asks for attempt 2 of 2", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const sub = await subscribeTo(t, id, 12, { ciFixAttempts: 1 });
    await notify(t, id, sub, "ci_failed", "test failed");
    await fire(t, id);
    expect((await notifyRow(t, id))[0].text).toContain("ci_failed (attempt 2 of 2)");
  });

  it("an event for a PR that was unsubscribed meanwhile is dropped", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const a = await subscribeTo(t, id, 12);
    const b = await subscribeTo(t, id, 13);
    await notify(t, id, a, "comment", "for a");
    await notify(t, id, b, "comment", "for b");
    await t.mutation(api.bridge.unsubscribe, { ...(await creds(id)), repo: "octo/hello", number: 12 });
    await fire(t, id);
    const text = (await notifyRow(t, id))[0].text!;
    expect(text).toContain("octo/hello#13");
    expect(text).not.toContain("for a");
  });

  it("archived and deleting dorks hear nothing", async () => {
    const t = makeT();
    const archived = await seed(t, "sleeping", { archived: true });
    await notify(t, archived, await subscribeTo(t, archived), "comment", "x");
    expect(await inboxOf(t, archived)).toEqual([]);

    const closing = await seed(t, "idle");
    const sub = await subscribeTo(t, closing);
    await notify(t, closing, sub, "comment", "x");
    await t.run((ctx) => ctx.db.patch(closing, { archived: true })); // archived while the window was open
    await fire(t, closing);
    expect(await notifyRow(t, closing)).toEqual([]);
    expect((await inboxOf(t, closing)).every((r) => r.delivered)).toBe(true);
    expect(await stateOf(t, closing)).toBe("idle");
  });
});

describe("delivery by state", () => {
  it("idle: delivers now and the dork starts working; acked like a user message", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    await notify(t, id, await subscribeTo(t, id), "comment", "alice: hi");
    await fire(t, id);
    expect(await stateOf(t, id)).toBe("working");
    const [row] = await notifyRow(t, id);
    const frames = await t.query(api.bridge.commands, await creds(id));
    expect(frames).toEqual([{ cid: row.cid, frame: { t: "notify", id: row.cid, text: row.text, kinds: ["comment"], prs: [{ repo: "octo/hello", number: 12 }] } }]);
    await ack(t, id, row.cid);
    expect(await emitted(t, id)).toEqual([]);
    expect((await notifyRow(t, id))[0].acked).toBe(true); // kept (not deleted) like an acked user message
    await turnIdle(t, id);
    expect(await stateOf(t, id)).toBe("idle");
  });

  it("sleeping: wakes the box; the notify survives the resume and goes out once the agent is ready", async () => {
    const t = makeT();
    const id = await seed(t, "sleeping");
    await notify(t, id, await subscribeTo(t, id), "ci_failed", "test failed");
    await fire(t, id);
    expect(await stateOf(t, id)).toBe("waking");
    await settle(t);
    expect(box.calls).toEqual(["resume"]);
    expect(await notifyRow(t, id)).toHaveLength(1); // clearControlRows must not eat it
    await t.mutation(api.bridge.connect, await creds(id));
    expect(await emitted(t, id)).toEqual(["fetch_configure"]); // waking: not before ready
    await push(t, id, [{ t: "ready" }]);
    expect(await stateOf(t, id)).toBe("working");
    expect(await emitted(t, id)).toEqual(["notify", "fetch_configure"]);
  });

  it("error: wakes the dork like a message", async () => {
    const t = makeT();
    const id = await seed(t, "error");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    expect(await stateOf(t, id)).toBe("waking");
  });

  it("creating/waking: delivered on ready", async () => {
    const t = makeT();
    const id = await seed(t, "waking");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    expect(await stateOf(t, id)).toBe("waking");
    expect(await emitted(t, id)).toEqual([]);
    await push(t, id, [{ t: "ready" }]);
    expect(await stateOf(t, id)).toBe("working");
    expect(await emitted(t, id)).toEqual(["notify"]);
  });

  it("working: held, never emitted mid-turn, then delivered at turn_idle", async () => {
    const t = makeT();
    const id = await seed(t, "working");
    await notify(t, id, await subscribeTo(t, id), "comment", "alice: hi");
    await fire(t, id);
    const [row] = await notifyRow(t, id);
    expect(row.released).toBe(false);
    expect(await stateOf(t, id)).toBe("working");
    expect(await emitted(t, id)).toEqual([]);
    await push(t, id, []); // heartbeats/pushes mid-turn don't release it either
    expect(await emitted(t, id)).toEqual([]);

    await turnIdle(t, id); // the turn boundary
    expect(await stateOf(t, id)).toBe("working"); // the notify starts the next turn: no idle (and no sleep timer) in between
    expect((await rtOf(t, id)).timers.sleep).toBeUndefined();
    expect(await emitted(t, id)).toEqual(["notify"]);
    await ack(t, id, row.cid);
    await turnIdle(t, id); // the notify's own turn ends
    expect(await stateOf(t, id)).toBe("idle");
    expect(await emitted(t, id)).toEqual([]);
  });

  it("an unreleased notify is withheld while working even if it is the only thing queued (safe default)", async () => {
    const t = makeT();
    const id = await seed(t, "working");
    await t.run((ctx) => ctx.db.insert("commands", { dorkId: id, kind: "notify", cid: "n1", text: "x", meta: { kinds: ["comment"], prs: [] }, acked: false }));
    expect(await emitted(t, id)).toEqual([]);
  });

  it("two notifies in a row: the second waits for the first one's turn", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    const sub = await subscribeTo(t, id);
    await notify(t, id, sub, "comment", "first");
    await fire(t, id);
    expect(await emitted(t, id)).toEqual(["notify"]); // working on the first
    await notify(t, id, sub, "comment", "second");
    await fire(t, id);
    const [first, second] = await notifyRow(t, id);
    expect(second.released).toBe(false);
    expect(await emitted(t, id)).toEqual(["notify"]); // only the first
    await ack(t, id, first.cid);
    expect(await emitted(t, id)).toEqual([]); // still mid-turn
    await turnIdle(t, id);
    expect(await emitted(t, id)).toEqual(["notify"]);
    expect((await t.query(api.bridge.commands, await creds(id)))[0].cid).toBe(second.cid);
  });
});

describe("user messages always go first", () => {
  it("a user message that arrives behind a ready notify goes out first; the notify follows once that turn ends", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id); // idle -> working, notify released
    await sendMessage(t, id, "also this"); // arrives before the bridge took the notify
    expect(await emitted(t, id)).toEqual(["user_message"]); // the notify is withheld behind it
    const [msg] = (await cmds(t, id)).filter((c) => c.kind === "user_message");
    await ack(t, id, msg.cid);
    expect(await emitted(t, id)).toEqual([]); // the message's turn is running: the notify waits for its boundary
    await turnIdle(t, id);
    expect(await emitted(t, id)).toEqual(["notify"]);
  });

  it("a message that arrives while the dork sleeps goes out before the notify that woke it", async () => {
    const t = makeT();
    const id = await seed(t, "sleeping");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id); // wakes
    await sendMessage(t, id, "me first");
    await t.mutation(api.bridge.connect, await creds(id));
    await push(t, id, [{ t: "ready" }]);
    expect(await stateOf(t, id)).toBe("working");
    expect(await emitted(t, id)).toEqual(["user_message", "fetch_configure"]);
    const [msg] = (await cmds(t, id)).filter((c) => c.kind === "user_message");
    await ack(t, id, msg.cid);
    // The message's turn is running: the notify (queued behind it) is held until that turn ends.
    expect(await emitted(t, id)).toEqual(["fetch_configure"]);
    await turnIdle(t, id);
    expect(await emitted(t, id)).toEqual(["notify", "fetch_configure"]);
  });

  it("a notify folded while a user message is unacked is held even though the dork is idle-or-waking", async () => {
    const t = makeT();
    const id = await seed(t, "waking");
    await sendMessage(t, id, "first");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    expect((await notifyRow(t, id))[0].released).toBe(false);
  });

  it("a user message sent mid-turn does not release a held notify", async () => {
    const t = makeT();
    const id = await seed(t, "working");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    await sendMessage(t, id, "steer");
    expect(await emitted(t, id)).toEqual(["user_message"]);
    expect((await notifyRow(t, id))[0].released).toBe(false);
  });
});

describe("pause and flush interactions", () => {
  it("notify during a sleep flush cancels the pause and delivers (idle -> working)", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    await t.mutation(internal.lifecycle.timer, { dorkId: id, name: "sleep" });
    expect((await cmds(t, id)).map((c) => c.kind)).toEqual(["flush"]);
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    expect(await stateOf(t, id)).toBe("working");
    expect((await cmds(t, id)).map((c) => c.kind).sort()).toEqual(["notify"]); // flush row deleted
    expect((await rtOf(t, id)).pause).toBeUndefined();
    await push(t, id, [{ t: "flushed" }]);
    await settle(t);
    expect(await stateOf(t, id)).toBe("working");
    expect(box.calls).toEqual([]);
  });

  it("notify after the pause's box call is in flight: withheld, the pause lands, the dork wakes and then delivers", async () => {
    const t = makeT();
    const id = await seed(t, "idle");
    await t.mutation(internal.lifecycle.timer, { dorkId: id, name: "sleep" });
    await push(t, id, [{ t: "flushed" }]); // boxes.pause scheduled
    await notify(t, id, await subscribeTo(t, id), "ci_failed", "x");
    await fire(t, id);
    expect((await rtOf(t, id)).pause?.phase).toBe("cancelled");
    expect(await emitted(t, id)).toEqual([]); // would be lost with the box
    await settle(t);
    expect(box.calls).toEqual(["pause", "resume"]);
    expect(await stateOf(t, id)).toBe("waking");
    expect(await notifyRow(t, id)).toHaveLength(1);
    await t.mutation(api.bridge.connect, await creds(id));
    await push(t, id, [{ t: "ready" }]);
    expect(await emitted(t, id)).toContain("notify");
  });

  it("an unacked notify survives the pause and wakes the dork again when the pause lands (like a queued message)", async () => {
    const t = makeT();
    const id = await seed(t, "idle", { bridgeSeenAt: 0 }); // silent bridge: paused directly
    await t.mutation(internal.lifecycle.timer, { dorkId: id, name: "sleep" });
    await t.run((ctx) => ctx.db.insert("commands", { dorkId: id, kind: "notify", cid: "n1", text: "x", meta: { kinds: ["comment"], prs: [] }, released: true, acked: false }));
    await settle(t);
    expect(box.calls).toEqual(["pause", "resume"]);
    expect(await stateOf(t, id)).toBe("waking");
  });

  it("a held notify is released by a fresh agent, not stranded across a restart", async () => {
    const t = makeT();
    const id = await seed(t, "working");
    await notify(t, id, await subscribeTo(t, id), "comment", "x");
    await fire(t, id);
    await push(t, id, [{ t: "agent_exited", code: 1, stderrTail: "" }]);
    expect(await stateOf(t, id)).toBe("error");
    await settle(t);
    await sendMessage(t, id, "wake up"); // error/sleeping -> waking
    await t.mutation(api.bridge.connect, await creds(id));
    await push(t, id, [{ t: "ready" }]);
    const [msg] = (await cmds(t, id)).filter((c) => c.kind === "user_message");
    await ack(t, id, msg.cid);
    await turnIdle(t, id);
    expect(await emitted(t, id)).toContain("notify");
  });
});
