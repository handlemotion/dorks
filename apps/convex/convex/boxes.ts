import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { getBox } from "./lib/box";
import { bridgeSecret } from "./lib/bridgeAuth";

// Box calls live in actions (at-most-once, no automatic retry). All provider calls are idempotent (see BoxProvider), and a
// failure becomes `op_failed` -> `error`; the user's next message retries. Only generic text reaches the event log.
const safe = (e: unknown, what: string) => {
  console.error(`${what} failed`, e instanceof Error ? e.message.slice(0, 200) : "unknown");
  return `${what} failed`;
};

const MAX_ORPHAN_ATTEMPTS = 6;

export const create = internalAction({
  args: { dorkId: v.id("dorks"), gen: v.number() }, // gen: the operation generation, echoed back so stale results are ignored
  handler: async (ctx, { dorkId, gen }) => {
    try {
      const info = await ctx.runQuery(internal.lifecycle.boxInfo, { dorkId });
      if (!info || info.deleting) return; // deleted before we started: do not create a box nobody will clean up
      if (!info.snapshotId) return void (await ctx.runMutation(internal.lifecycle.opFailed, { dorkId, gen, message: "No base snapshot configured" }));
      // Only bridge connection details go in the create-time env (it is frozen into snapshots); secrets arrive via bridge.configure.
      const box = await getBox(ctx).createFromSnapshot(info.snapshotId, {
        name: dorkId,
        initCommand: "dorks-bridge",
        env: { DORK_ID: dorkId, BRIDGE_URL: process.env.CONVEX_CLOUD_URL!, BRIDGE_SECRET: await bridgeSecret(dorkId) },
      });
      const recorded = await ctx.runMutation(internal.lifecycle.boxCreated, { dorkId, gen, boxId: box.id, sleepMinutes: info.sleepMinutes });
      // The dork was deleted while the box was being created, so `destroy` saw no boxId. Delete what we just made.
      if (recorded === "orphaned") await ctx.runAction(internal.boxes.deleteOrphan, { boxId: box.id, attempt: 0 });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.opFailed, { dorkId, gen, message: safe(e, "create_box") });
    }
  },
});

/** Deletes a box that no dork row points at. Provider deletes are idempotent; failures retry with backoff so it cannot leak silently. */
export const deleteOrphan = internalAction({
  args: { boxId: v.string(), attempt: v.number() },
  handler: async (ctx, { boxId, attempt }) => {
    try {
      await getBox(ctx).delete(boxId);
    } catch (e) {
      safe(e, "delete_orphan_box");
      if (attempt < MAX_ORPHAN_ATTEMPTS) await ctx.scheduler.runAfter(15_000 * 2 ** attempt, internal.boxes.deleteOrphan, { boxId, attempt: attempt + 1 });
      else console.error("orphan box could not be deleted; remove it manually", boxId);
    }
  },
});

export const resume = internalAction({
  args: { dorkId: v.id("dorks"), gen: v.number() }, // gen: the operation generation, echoed back so stale results are ignored
  handler: async (ctx, { dorkId, gen }) => {
    try {
      const info = await ctx.runQuery(internal.lifecycle.boxInfo, { dorkId });
      if (!info?.boxId) throw new Error("no box");
      await getBox(ctx).resume(info.boxId);
      await ctx.runMutation(internal.lifecycle.boxResumed, { dorkId });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.opFailed, { dorkId, gen, message: safe(e, "resume_box") });
    }
  },
});

export const pause = internalAction({
  args: { dorkId: v.id("dorks"), gen: v.number() }, // gen: the operation generation, echoed back so stale results are ignored
  handler: async (ctx, { dorkId, gen }) => {
    try {
      const info = await ctx.runQuery(internal.lifecycle.boxInfo, { dorkId });
      if (info?.boxId) await getBox(ctx).pause(info.boxId);
      await ctx.runMutation(internal.lifecycle.boxPaused, { dorkId, gen });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.opFailed, { dorkId, gen, message: safe(e, "pause_box") });
    }
  },
});

export const destroy = internalAction({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const info = await ctx.runQuery(internal.lifecycle.boxInfo, { dorkId });
    if (!info) return;
    // Delete the box first; wipe rows only if that worked, so a failed delete can be retried by calling remove again.
    try {
      if (info.boxId) await getBox(ctx).delete(info.boxId);
    } catch (e) {
      safe(e, "delete_box");
      return void (await ctx.runMutation(internal.dorks.unmarkDeleting, { dorkId }));
    }
    await ctx.runMutation(internal.dorks.purge, { dorkId });
  },
});
