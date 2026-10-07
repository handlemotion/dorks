import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUserId } from "./auth";
import { append, dispatch, enqueue, fail, MAX_MESSAGE_CHARS, runtimeOf } from "./lib/dispatch";

const REPO = /^[\w.-]+\/[\w.-]+$/;

async function owned(ctx: MutationCtx, dorkId: Id<"dorks">): Promise<Doc<"dorks">> {
  const userId = await requireUserId(ctx);
  const dork = await ctx.db.get(dorkId);
  if (!dork || dork.userId !== userId || dork.deleting) return fail("not_found", "not found");
  return dork;
}

function checkText(text: string) {
  const t = text.trim();
  if (!t) fail("invalid", "message is empty");
  if (t.length > MAX_MESSAGE_CHARS) fail("invalid", "message too long");
  return t;
}

/** Durable outbox row + the event clients see. A thrown error rolls both back (e.g. archived dork). */
async function persistMessage(ctx: MutationCtx, dork: Doc<"dorks">, text: string) {
  await enqueue(ctx, dork._id, "user_message", text);
  await append(ctx, dork._id, { type: "user_message", text });
  await ctx.db.patch(dork._id, { preview: text.slice(0, 140), lastActivityAt: Date.now() });
}

export const list = query({
  args: { archived: v.optional(v.boolean()) },
  handler: async (ctx, { archived }) => {
    const userId = await requireUserId(ctx);
    return ctx.db.query("dorks").withIndex("by_user_archived_activity", (q) => q.eq("userId", userId).eq("archived", !!archived)).order("desc").take(200);
  },
});

export const get = query({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const userId = await requireUserId(ctx);
    const dork = await ctx.db.get(dorkId);
    return dork && dork.userId === userId && !dork.deleting ? dork : null;
  },
});

export const create = mutation({
  args: { repo: v.string(), message: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, { repo, message, title }) => {
    const userId = await requireUserId(ctx);
    if (!REPO.test(repo)) fail("invalid", "repo must be owner/name");
    const text = checkText(message);
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!s?.claudeTokenEnc || !s.githubInstallationId) fail("onboarding_incomplete", "finish onboarding first");
    const dorkId = await ctx.db.insert("dorks", {
      userId, title: (title?.trim() || text).slice(0, 120), repo, branch: `agent/${crypto.randomUUID().slice(0, 8)}`,
      state: "creating", archived: false, lastActivityAt: Date.now(),
    });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: s!.sleepMinutes, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
    await persistMessage(ctx, (await ctx.db.get(dorkId))!, text);
    await dispatch(ctx, dorkId, { t: "start" }); // box failures land in `error` via boxes.create; the row exists either way
    return dorkId;
  },
});

export const sendMessage = mutation({
  args: { dorkId: v.id("dorks"), text: v.string() },
  handler: async (ctx, { dorkId, text }) => {
    const dork = await owned(ctx, dorkId);
    await persistMessage(ctx, dork, checkText(text));
    const r = await dispatch(ctx, dorkId, { t: "user_message" });
    if (r?.rejected) fail("archived", "dork is archived"); // rolls back the persisted message
  },
});

export const interrupt = mutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    await owned(ctx, dorkId);
    await dispatch(ctx, dorkId, { t: "interrupt" });
  },
});

export const setArchived = mutation({
  args: { dorkId: v.id("dorks"), archived: v.boolean() },
  handler: async (ctx, { dorkId, archived }) => {
    await owned(ctx, dorkId);
    await dispatch(ctx, dorkId, { t: archived ? "archive" : "unarchive" });
  },
});

export const rename = mutation({
  args: { dorkId: v.id("dorks"), title: v.string() },
  handler: async (ctx, { dorkId, title }) => {
    await owned(ctx, dorkId);
    const t = title.trim();
    if (!t || t.length > 120) fail("invalid", "bad title");
    await ctx.db.patch(dorkId, { title: t });
  },
});

export const remove = mutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    await owned(ctx, dorkId);
    await ctx.db.patch(dorkId, { deleting: true });
    await ctx.scheduler.runAfter(0, internal.boxes.destroy, { dorkId });
  },
});

export const unmarkDeleting = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    await ctx.db.patch(dorkId, { deleting: false });
  },
});

/** Wipes a dork in batches (a transaction can only touch so many rows). */
export const purge = internalMutation({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const rt = await ctx.db.query("dorkRuntime").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).unique();
    if (rt) for (const id of Object.values(rt.timers)) await ctx.scheduler.cancel(id);
    const events = await ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).take(500);
    for (const e of events) await ctx.db.delete(e._id);
    if (events.length === 500) return void (await ctx.scheduler.runAfter(0, internal.dorks.purge, { dorkId }));
    for (const c of await ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId)).collect()) await ctx.db.delete(c._id);
    if (rt) await ctx.db.delete(rt._id);
    await ctx.db.delete(dorkId);
  },
});

export const reportPr = internalMutation({
  args: { dorkId: v.id("dorks"), kind: v.union(v.literal("pr_opened"), v.literal("pr_merged")), url: v.string(), number: v.number() },
  handler: async (ctx, { dorkId, kind, url, number }) => {
    await runtimeOf(ctx, dorkId);
    await append(ctx, dorkId, { type: kind, url, number });
    await ctx.db.patch(dorkId, { prUrl: url, lastActivityAt: Date.now() });
  },
});
