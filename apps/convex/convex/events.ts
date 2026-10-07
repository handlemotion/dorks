import { paginationOptsValidator } from "convex/server";
import type { ClientEvent } from "@dorks/shared";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUserId } from "./auth";

/**
 * Reactive + paginated transcript, newest first (page 1 is the live tail; `loadMore` walks back in time).
 * This one query replaces the WebSocket ticket, `after=` replay, gap detection and reconnect code.
 */
export const list = query({
  args: { dorkId: v.id("dorks"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { dorkId, paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.userId !== userId) return { page: [] as ClientEvent[], isDone: true, continueCursor: "" };
    const r = await ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).order("desc").paginate(paginationOpts);
    return { ...r, page: r.page.map((e) => ({ ...e.body, seq: e.seq, dorkId: e.dorkId, ts: e.ts }) as ClientEvent) };
  },
});
