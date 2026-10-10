// Dev-only stand-in for the box host's API. infra/bridge-sim/host.mjs subscribes to `simbox.all` and starts/kills sim bridges.
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";

export const create = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const existing = await ctx.db.query("simBoxes").withIndex("by_name", (q) => q.eq("name", name)).unique(); // idempotent on name
    if (existing) return existing._id;
    return ctx.db.insert("simBoxes", { name, running: true, gen: 1 });
  },
});

export const setRunning = internalMutation({
  args: { id: v.string(), running: v.boolean() },
  handler: async (ctx, { id, running }) => {
    const box = await ctx.db.get(ctx.db.normalizeId("simBoxes", id) ?? ("" as never));
    if (!box) throw new Error("sim box not found");
    if (box.running !== running) await ctx.db.patch(box._id, { running, gen: box.gen + 1 });
  },
});

/** Dev/e2e: what a sim box has "cost" so far, in micro-USD. Settable with `setCost` so metering can be exercised without a real provider. */
export const usage = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const nid = ctx.db.normalizeId("simBoxes", id);
    const box = nid ? await ctx.db.get(nid) : null;
    return box ? { costMicro: box.costMicro ?? 0 } : null;
  },
});

export const setCost = internalMutation({
  args: { id: v.string(), costMicro: v.number() },
  handler: async (ctx, { id, costMicro }) => {
    const nid = ctx.db.normalizeId("simBoxes", id);
    if (nid) await ctx.db.patch(nid, { costMicro });
  },
});

export const remove = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const nid = ctx.db.normalizeId("simBoxes", id);
    if (nid) await ctx.db.delete(nid);
  },
});

/** Host-side feed for the sim host process; gated by a shared dev key. */
export const all = query({
  args: { hostKey: v.string() },
  handler: async (ctx, { hostKey }) => {
    if (process.env.BOX_PROVIDER !== "sim" || hostKey !== process.env.SIM_HOST_KEY) return [];
    return ctx.db.query("simBoxes").collect();
  },
});
