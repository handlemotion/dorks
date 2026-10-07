import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { append, BRIDGE_STALE_MS, dispatch, enqueue, enqueueConfigure, finishPause, GH_REFRESH_MS, HEARTBEAT_MS, isAwake, queued, runtimeOf, setTimer } from "./lib/dispatch";

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
        await finishPause(ctx, dorkId); // flush timeout (a no-op if the pause was cancelled meanwhile)
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

const opGenArg = v.number(); // the box action's operation generation (see dorkRuntime.opGen)

/**
 * An effect (box call, secret resolution) failed. The message must already be safe to show.
 * `gen` ties the failure to the box operation that produced it: a failure from a superseded operation is ignored.
 */
export const opFailed = internalMutation({
  args: { dorkId: v.id("dorks"), message: v.string(), gen: v.optional(opGenArg) },
  handler: async (ctx, { dorkId, message, gen }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return; // deleted while the effect ran: nothing left to fail
    if (gen !== undefined) {
      const rt = await runtimeOf(ctx, dorkId);
      if (gen !== (rt.opGen ?? 0)) return void console.error("ignoring failure of a superseded box operation", dorkId); // consumed or replaced
      // The failed op is now settled: the next one gets a fresh generation, and a failed pause is no longer pending.
      const cancelled = rt.pause?.gen === gen && rt.pause.phase === "cancelled";
      await ctx.db.patch(rt._id, { opGen: gen + 1, ...(rt.pause?.gen === gen ? { pause: undefined } : {}) });
      if (cancelled) return; // a message already took the pause back: the box is still up, so the dork stays as it is
    }
    await append(ctx, dorkId, { type: "error", message });
    await dispatch(ctx, dorkId, { t: "op_failed" });
  },
});

/**
 * Records the freshly created box. Returns "orphaned" if the dork was deleted (or already purged) while `createFromSnapshot`
 * was in flight, or if a newer create attempt already recorded a different box: nothing tracks this one, so the caller must delete it.
 * A superseded attempt that is the first to finish still records its box: it is real, and the provider names it by dork.
 */
export const boxCreated = internalMutation({
  args: { dorkId: v.id("dorks"), boxId: v.string(), sleepMinutes: v.number(), gen: opGenArg },
  handler: async (ctx, { dorkId, boxId, sleepMinutes, gen }): Promise<"ok" | "orphaned"> => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return "orphaned";
    if (dork.boxId && dork.boxId !== boxId) return "orphaned";
    const rt = await runtimeOf(ctx, dorkId);
    if (gen !== (rt.opGen ?? 0)) console.error("recording the box of a superseded create", dorkId);
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

/**
 * The box is paused. Ignored if a newer box operation superseded this pause. If a message took the pause back while the box
 * call was in flight (`cancelled`) or queued work remains, the box is down under a dork that wants to run, so it wakes again.
 */
export const boxPaused = internalMutation({
  args: { dorkId: v.id("dorks"), gen: opGenArg },
  handler: async (ctx, { dorkId, gen }) => {
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.deleting) return;
    const rt = await runtimeOf(ctx, dorkId);
    if (gen !== (rt.opGen ?? 0)) return void console.error("ignoring pause of a superseded box operation", dorkId);
    const cancelled = rt.pause?.phase === "cancelled";
    await ctx.db.patch(rt._id, { opGen: gen + 1, pause: undefined });
    await dispatch(ctx, dorkId, { t: "paused" });
    const after = await ctx.db.get(dorkId);
    if (after && !after.archived && after.state === "sleeping" && (cancelled || (await queued(ctx, dorkId)))) await dispatch(ctx, dorkId, { t: "user_message" });
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
