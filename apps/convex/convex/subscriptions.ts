import { v } from "convex/values";
import { createInstallationToken, getPullRequest, GithubHttpError } from "../../api/src/lib/github";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./auth";
import { isTransientGithubError } from "./bridge";
import { owned } from "./dorks";
import * as subs from "./lib/subscriptions";
import { normalizeRepo } from "./lib/repo";

// User-facing subscription functions (no UI yet), plus the action that fills a new subscription in from GitHub.
// The bridge-facing ones (same operations, authed with the per-dork secret) are in bridge.ts.

export const list = query({
  args: { dorkId: v.id("dorks") },
  handler: async (ctx, { dorkId }) => {
    const userId = await requireUserId(ctx);
    const dork = await ctx.db.get(dorkId);
    if (!dork || dork.userId !== userId || dork.deleting) return [];
    return (await subs.subscriptionsOfDork(ctx, dorkId)).filter((s) => s.status !== "ended").map(subs.toView);
  },
});

/** Subscribes the dork to any PR. Subscribing again un-stalls it and resets the CI attempt budget, like `resume`. */
export const subscribe = mutation({
  args: { dorkId: v.id("dorks"), repo: v.string(), number: v.number() },
  handler: async (ctx, { dorkId, repo, number }) => {
    await subs.subscribe(ctx, await owned(ctx, dorkId), repo, number, "user");
  },
});

export const unsubscribe = mutation({
  args: { dorkId: v.id("dorks"), repo: v.string(), number: v.number() },
  handler: async (ctx, { dorkId, repo, number }) => {
    await owned(ctx, dorkId);
    await subs.unsubscribe(ctx, dorkId, repo, number);
  },
});

/** Un-stalls a subscription and resets `ciFixAttempts`. */
export const resume = mutation({
  args: { dorkId: v.id("dorks"), repo: v.string(), number: v.number() },
  handler: async (ctx, { dorkId, repo, number }) => {
    await subs.resume(ctx, await owned(ctx, dorkId), repo, number);
  },
});

// ---------------------------------------------------------------- hydration
// A new subscription knows only repo + number. This fills in the rest from GitHub with an installation token of the dork's
// owner. It is also the access check: an installation that cannot see the PR gets 404, and the subscription ends.

const HYDRATE_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000]; // transient GitHub failures, then give up (webhooks fill the gaps)

export const hydrationInfo = internalQuery({
  args: { subscriptionId: v.id("prSubscriptions") },
  handler: async (ctx, { subscriptionId }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (!sub || sub.status === "ended") return null;
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", sub.userId)).unique();
    return { repo: sub.repo, number: sub.number, installationId: s?.githubInstallationId ?? null };
  },
});

export const applyHydration = internalMutation({
  args: {
    subscriptionId: v.id("prSubscriptions"),
    pr: v.object({
      title: v.string(), headRef: v.string(), headSha: v.string(), baseRef: v.string(), repo: v.string(),
      state: v.union(v.literal("open"), v.literal("closed"), v.literal("merged")), mergeable: v.union(v.boolean(), v.null()),
    }),
  },
  handler: async (ctx, { subscriptionId, pr }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (!sub || sub.status === "ended") return; // unsubscribed (or ended by a webhook) while GitHub was answering
    if (normalizeRepo(pr.repo) !== sub.repo) return void console.error("hydration answered for another repo", subscriptionId); // renamed/transferred: keep what the agent gave
    await subs.updateSubscription(ctx, subscriptionId, { title: pr.title, headRef: pr.headRef, headSha: pr.headSha, baseRef: pr.baseRef, state: pr.state, mergeable: pr.mergeable });
    if (pr.state !== "open") await subs.endSubscription(ctx, (await ctx.db.get(subscriptionId))!, pr.state);
  },
});

export const hydrationFailed = internalMutation({
  args: { subscriptionId: v.id("prSubscriptions"), reason: v.string() },
  handler: async (ctx, { subscriptionId, reason }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (sub) await subs.endSubscription(ctx, sub, reason);
  },
});

export const hydrate = internalAction({
  args: { subscriptionId: v.id("prSubscriptions"), attempt: v.optional(v.number()) },
  handler: async (ctx, { subscriptionId, attempt = 0 }) => {
    if (process.env.BOX_PROVIDER === "sim") return; // local dev: no real GitHub App
    const info = await ctx.runQuery(internal.subscriptions.hydrationInfo, { subscriptionId });
    if (!info) return;
    if (!info.installationId) return void (await ctx.runMutation(internal.subscriptions.hydrationFailed, { subscriptionId, reason: "GitHub App not installed" }));
    try {
      const env = { GITHUB_APP_ID: process.env.GITHUB_APP_ID!, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY! };
      const { token } = await createInstallationToken(env, info.installationId, fetch, { permissions: { pull_requests: "read" } });
      await ctx.runMutation(internal.subscriptions.applyHydration, { subscriptionId, pr: await getPullRequest(token, info.repo, info.number) });
    } catch (e) {
      console.error("pr hydration failed", subscriptionId, e instanceof GithubHttpError ? e.status : "unexpected");
      if (isTransientGithubError(e)) {
        if (attempt < HYDRATE_RETRY_MS.length) await ctx.scheduler.runAfter(HYDRATE_RETRY_MS[attempt], internal.subscriptions.hydrate, { subscriptionId, attempt: attempt + 1 });
      } else if (e instanceof GithubHttpError) {
        await ctx.runMutation(internal.subscriptions.hydrationFailed, { subscriptionId, reason: "PR not found or not accessible to your GitHub App installation" });
      } // anything else is our own misconfiguration: the subscription stays, unhydrated
    }
  },
});

// ---------------------------------------------------------------- retention
export const DELIVERY_RETENTION_MS = 7 * 24 * 3_600_000; // GitHub redelivers within hours; a week is generous
export const INBOX_RETENTION_MS = 24 * 3_600_000; // delivered rows only matter for debugging
const SWEEP_BATCH = 500;

/** Prunes webhook delivery ids and delivered inbox rows; reschedules itself while there is more (a transaction only touches so many rows). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db.query("githubDeliveries").withIndex("by_received", (q) => q.lt("receivedAt", now - DELIVERY_RETENTION_MS)).take(SWEEP_BATCH);
    for (const d of old) await ctx.db.delete(d._id);
    const done = await ctx.db.query("inbox").withIndex("by_delivered_created", (q) => q.eq("delivered", true).lt("createdAt", now - INBOX_RETENTION_MS)).take(SWEEP_BATCH);
    for (const r of done) await ctx.db.delete(r._id);
    if (old.length === SWEEP_BATCH || done.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.subscriptions.sweep, {});
  },
});
