import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { append, BRIDGE_STALE_MS, dispatch, enqueue, enqueueConfigure, finishPause, GH_REFRESH_MS, HEARTBEAT_MS, isAwake, runtimeOf, setTimer } from "./lib/dispatch";

/** Fired by the scheduler (see lib/dispatch.ts setTimer). Replaces Dork.runTimer + the alarm multiplexer. */
export const timer = internalMutation({
  args: { dorkId: v.id("dorks"), name: v.string() },
  handler: async (ctx, { dorkId, name }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return;
    const rt = await runtimeOf(ctx, dorkId);
    const { [name]: _fired, ...timers } = rt.timers;
    await ctx.db.patch(rt._id, { timers });

    switch (name) {
      case "sleep":
        await dispatch(ctx, dorkId, { t: "sleep_due" });
        break;
      case "watchdog":
        if (isAwake(dork.state)) await append(ctx, dorkId, { type: "error", message: "timed out waiting for the sandbox" });
        await dispatch(ctx, dorkId, { t: "watchdog" });
        break;
      case "gh_token":
        if (dork.state !== "working" && dork.state !== "idle") break;
        await enqueue(ctx, dorkId, "gh_token"); // marker only: the bridge calls bridge.ghToken to fetch the token
        await setTimer(ctx, dorkId, "gh_token", GH_REFRESH_MS);
        break;
      case "flush":
        await finishPause(ctx, dorkId); // flush timeout
        break;
      case "bridge_watch": {
        // Convex has no socket-close signal, so liveness is "heartbeat seen recently".
        if (!isAwake(dork.state)) break;
        if (!rt.bridgeLost && Date.now() - rt.bridgeSeenAt > BRIDGE_STALE_MS) {
          await ctx.db.patch(rt._id, { bridgeLost: true });
          await dispatch(ctx, dorkId, { t: "bridge_lost" });
        }
        await setTimer(ctx, dorkId, "bridge_watch", HEARTBEAT_MS);
        break;
      }
    }
  },
});

/** An effect (box call, secret resolution) failed. The message must already be safe to show. */
export const opFailed = internalMutation({
  args: { dorkId: v.id("dorks"), message: v.string() },
  handler: async (ctx, { dorkId, message }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return; // deleted while the effect ran: nothing left to fail
    await append(ctx, dorkId, { type: "error", message });
    await dispatch(ctx, dorkId, { t: "op_failed" });
  },
});

/**
 * The provider says `boxId` no longer exists. Forget it (and the Claude session that lived on its disk, which a recreated box does
 * not have) and fail the op, atomically, so the machine's `error` + !hasBox path recreates the box on the next message.
 * No-op if the dork now points at a different box: a stale resume must not clobber a newer one.
 */
export const boxGone = internalMutation({
  args: { dorkId: v.id("dorks"), boxId: v.string(), message: v.string() },
  handler: async (ctx, { dorkId, boxId, message }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting || dork.boxId !== boxId) return;
    await ctx.db.patch(dorkId, { boxId: undefined, claudeSessionId: undefined });
    await append(ctx, dorkId, { type: "error", message });
    await dispatch(ctx, dorkId, { t: "op_failed" });
  },
});

/**
 * Records the freshly created box. Returns "orphaned" if the dork was deleted (or already purged) while `createFromSnapshot`
 * was in flight: nothing can track that box any more, so the caller must delete it.
 */
export const boxCreated = internalMutation({
  args: { dorkId: v.id("dorks"), boxId: v.string(), sleepMinutes: v.number() },
  handler: async (ctx, { dorkId, boxId, sleepMinutes }): Promise<"ok" | "orphaned"> => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return "orphaned";
    const rt = await runtimeOf(ctx, dorkId);
    await ctx.db.patch(rt._id, { sleepMinutes });
    await ctx.db.patch(dorkId, { boxId });
    return "ok";
  },
});

/** Box resumed. If the bridge never lost its connection (agent crashed, box stayed up) no new connect will trigger `configure`. */
export const boxResumed = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    await enqueueConfigure(ctx, dorkId); // idempotent on the bridge side
  },
});

export const boxPaused = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    await dispatch(ctx, dorkId, { t: "paused" });
  },
});

/** Non-secret facts the box actions need. */
export const boxInfo = internalQuery({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork) return null;
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", dork.userId)).unique();
    return { boxId: dork.boxId ?? null, deleting: !!dork.deleting, userId: dork.userId, snapshotId: s?.workstationSnapshotId ?? process.env.BASE_SNAPSHOT_ID ?? "", sleepMinutes: s?.sleepMinutes ?? 5 };
  },
});
