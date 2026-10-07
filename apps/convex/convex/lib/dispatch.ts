import type { ClientEventBody } from "@dorks/shared";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { reduce, type Effect, type Input, type Result } from "../../../api/src/lifecycle/machine";

export const WATCHDOG_MS = 3 * 60_000; // creating/waking must reach `ready` (or a lost bridge must return) within this
export const GH_REFRESH_MS = 45 * 60_000; // installation tokens last 1h
export const FLUSH_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 30_000;
export const BRIDGE_STALE_MS = 90_000;
export const MAX_MESSAGE_CHARS = 50_000;

export type ErrorCode = "archived" | "invalid" | "deleting" | "conflict" | "failed" | "not_found" | "onboarding_incomplete";
export const fail = (code: ErrorCode, message: string): never => {
  throw new ConvexError({ code, message });
};

const AWAKE = ["creating", "working", "idle", "waking"];
export const isAwake = (s: string) => AWAKE.includes(s);

export async function runtimeOf(ctx: MutationCtx, dorkId: Id<"dorks">): Promise<Doc<"dorkRuntime">> {
  const rt = await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique();
  if (!rt) throw new Error("dork runtime missing");
  return rt;
}

// ---------------------------------------------------------------- event log
/** Dense per-dork seq: next = last + 1. Concurrent appenders conflict on the tail read and Convex retries them. */
export async function append(ctx: MutationCtx, dorkId: Id<"dorks">, ...bodies: ClientEventBody[]) {
  let tail = await ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).order("desc").first();
  let seq = tail?.seq ?? 0;
  const ts = Date.now();
  for (const body of bodies) {
    // Streaming text for one message grows a single row instead of adding a row per delta: pages stay small
    // and every re-run of the subscribed query reads fewer documents. Clients re-fold the loaded page, so this is invisible to them.
    if (tail && body.type === "assistant_delta" && tail.body.type === "assistant_delta" && tail.body.messageId === body.messageId) {
      tail = { ...tail, body: { ...tail.body, text: tail.body.text + body.text } };
      await ctx.db.patch(tail._id, { body: tail.body, ts });
      continue;
    }
    const id = await ctx.db.insert("events", { dorkId, seq: ++seq, ts, body });
    tail = (await ctx.db.get(id))!;
  }
}

// ---------------------------------------------------------------- timers (replace lib/timers.ts + DO alarm)
export async function setTimer(ctx: MutationCtx, dorkId: Id<"dorks">, name: string, ms: number) {
  const rt = await runtimeOf(ctx, dorkId);
  const timers = { ...rt.timers };
  if (timers[name]) await ctx.scheduler.cancel(timers[name]);
  timers[name] = await ctx.scheduler.runAfter(ms, internal.lifecycle.timer, { dorkId, name });
  await ctx.db.patch(rt._id, { timers });
}

export async function cancelTimer(ctx: MutationCtx, dorkId: Id<"dorks">, name: string) {
  const rt = await runtimeOf(ctx, dorkId);
  if (!rt.timers[name]) return;
  const { [name]: id, ...timers } = rt.timers;
  await ctx.scheduler.cancel(id);
  await ctx.db.patch(rt._id, { timers });
}

// ---------------------------------------------------------------- machine driver
export async function machineCtx(ctx: MutationCtx, dork: Doc<"dorks">) {
  return { state: dork.state, archived: dork.archived, hasBox: !!dork.boxId, queued: await queued(ctx, dork._id) };
}

export async function queued(ctx: MutationCtx, dorkId: Id<"dorks">) {
  const open = await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId).eq("acked", false)).collect();
  return open.some((c) => c.kind === "user_message");
}

export async function enqueue(ctx: MutationCtx, dorkId: Id<"dorks">, kind: Doc<"commands">["kind"], text?: string) {
  const cid = crypto.randomUUID();
  await ctx.db.insert("commands", { dorkId, kind, cid, text, acked: false });
  return cid;
}

/** At most one pending `configure`; the bridge handles it idempotently. */
export async function enqueueConfigure(ctx: MutationCtx, dorkId: Id<"dorks">) {
  const open = await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId).eq("acked", false)).collect();
  if (!open.some((c) => c.kind === "configure")) await enqueue(ctx, dorkId, "configure");
}

/** Apply an input: persist the new state, then run effects. Effects are DB writes + scheduled actions, all in this transaction. */
export async function dispatch(ctx: MutationCtx, dorkId: Id<"dorks">, input: Input): Promise<Result | null> {
  const dork = await ctx.db.get(dorkId);
  if (!dork || dork.deleting) return null;
  const before = await machineCtx(ctx, dork);
  const r = reduce(before, input);
  if (r.rejected) return r;
  if (r.state !== before.state || r.archived !== before.archived) {
    await ctx.db.patch(dorkId, { state: r.state, archived: r.archived, lastActivityAt: Date.now() });
  }
  if (r.state !== before.state) await append(ctx, dorkId, { type: "status", state: r.state });
  for (const effect of r.effects) await runEffect(ctx, dorkId, effect);
  return r;
}

async function runEffect(ctx: MutationCtx, dorkId: Id<"dorks">, effect: Effect) {
  switch (effect) {
    case "create_box":
    case "resume_box": {
      const rt = await runtimeOf(ctx, dorkId);
      await ctx.db.patch(rt._id, { bridgeSeenAt: Date.now(), bridgeLost: false }); // grace period for the new bridge to dial in
      await setTimer(ctx, dorkId, "bridge_watch", HEARTBEAT_MS);
      await ctx.scheduler.runAfter(0, effect === "create_box" ? internal.boxes.create : internal.boxes.resume, { dorkId });
      return;
    }
    case "pause_box":
      return beginPause(ctx, dorkId);
    case "deliver_outbox":
      return; // declarative: bridge.commands re-emits every unacked message while the dork is working/idle
    case "interrupt_agent":
      await enqueue(ctx, dorkId, "interrupt");
      return;
    case "arm_sleep": {
      const rt = await runtimeOf(ctx, dorkId);
      return setTimer(ctx, dorkId, "sleep", rt.sleepMinutes * 60_000);
    }
    case "cancel_sleep":
      return cancelTimer(ctx, dorkId, "sleep");
    case "arm_watchdog":
      return setTimer(ctx, dorkId, "watchdog", WATCHDOG_MS);
    case "cancel_watchdog":
      return cancelTimer(ctx, dorkId, "watchdog");
    case "arm_gh_refresh":
      return setTimer(ctx, dorkId, "gh_token", GH_REFRESH_MS);
    case "cancel_gh_refresh":
      return cancelTimer(ctx, dorkId, "gh_token");
  }
}

/** Ask a live bridge to flush, then pause the box on `flushed` (or after a timeout). A silent bridge is paused directly. */
async function beginPause(ctx: MutationCtx, dorkId: Id<"dorks">) {
  const rt = await runtimeOf(ctx, dorkId);
  const live = !rt.bridgeLost && Date.now() - rt.bridgeSeenAt < BRIDGE_STALE_MS;
  if (live) {
    if (rt.timers.flush) return; // already flushing
    await enqueue(ctx, dorkId, "flush");
    await setTimer(ctx, dorkId, "flush", FLUSH_TIMEOUT_MS);
  } else {
    await ctx.scheduler.runAfter(0, internal.boxes.pause, { dorkId });
  }
}

export async function finishPause(ctx: MutationCtx, dorkId: Id<"dorks">) {
  await cancelTimer(ctx, dorkId, "flush");
  await ctx.scheduler.runAfter(0, internal.boxes.pause, { dorkId });
}
