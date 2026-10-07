import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * Fixed-window counters in a table. Better-auth's own limiter keeps counts in per-isolate memory, which does nothing on Convex.
 * `hit` is all-or-nothing: if any key is over its limit nothing is counted, so a blocked flood does not write and a request
 * refused on one key does not burn the budget of the others.
 */
export const hit = internalMutation({
  args: { checks: v.array(v.object({ key: v.string(), limit: v.number(), windowMs: v.number() })) },
  handler: async (ctx, { checks }): Promise<{ ok: true } | { ok: false; key: string; retryAfterMs: number }> => {
    const now = Date.now();
    const rows = [];
    for (const c of checks) {
      const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", c.key)).unique();
      const live = !!row && now < row.windowStart + c.windowMs;
      if (row && live && row.count >= c.limit) return { ok: false, key: c.key, retryAfterMs: row.windowStart + c.windowMs - now };
      rows.push({ row, live });
    }
    for (const [i, c] of checks.entries()) {
      const { row, live } = rows[i];
      if (row && live) await ctx.db.patch(row._id, { count: row.count + 1 });
      else if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
      else await ctx.db.insert("rateLimits", { key: c.key, windowStart: now, count: 1 });
    }
    return { ok: true };
  },
});

/** Counters only matter inside their window; keys are caller-chosen (emails, IPs) so the table must not grow forever. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db.query("rateLimits").withIndex("by_window_start", (q) => q.lt("windowStart", Date.now() - 24 * 3_600_000)).take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    if (stale.length === 500) await ctx.scheduler.runAfter(0, internal.rateLimit.sweep, {});
  },
});
