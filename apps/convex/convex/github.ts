import { v } from "convex/values";
import { createInstallationToken, createIssueComment, getPullRequest, GithubHttpError } from "../../api/src/lib/github";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { isTransientGithubError } from "./bridge";
import { githubEvent } from "./lib/githubEvents";
import { applyMergeable, ingestEvent, MERGEABLE_POLL_DELAYS_MS } from "./lib/githubIngest";

// GitHub webhook ingress (the route is in http.ts): routing a delivery to subscriptions, and the actions it schedules.

/** One verified, parsed delivery. Mutations run serially per document, so the routing never races another delivery for the same PR. */
export const ingest = internalMutation({
  args: { deliveryId: v.string(), event: githubEvent },
  handler: async (ctx, { deliveryId, event }) => {
    await ingestEvent(ctx, deliveryId, event, process.env.GITHUB_APP_SLUG!); // http.ts refuses deliveries while the slug is unset
  },
});

// ---------------------------------------------------------------- merge conflicts
const appEnv = () => ({ GITHUB_APP_ID: process.env.GITHUB_APP_ID!, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY! });

export const setMergeable = internalMutation({
  args: { subscriptionId: v.id("prSubscriptions"), baseSha: v.string(), mergeable: v.boolean() },
  handler: async (ctx, { subscriptionId, baseSha, mergeable }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (sub && sub.status !== "ended" && sub.state === "open") await applyMergeable(ctx, sub, baseSha, mergeable);
  },
});

/**
 * A base branch moved: re-read whether the subscribed PRs that target it still merge. GitHub computes `mergeable` lazily
 * (null until it has), so a PR without an answer is asked again later with backoff, a few times.
 */
export const checkMergeable = internalAction({
  args: {
    installationId: v.number(), repo: v.string(), baseSha: v.string(), attempt: v.number(),
    prs: v.array(v.object({ subscriptionId: v.id("prSubscriptions"), number: v.number() })),
  },
  handler: async (ctx, { installationId, repo, baseSha, prs, attempt }) => {
    if (process.env.BOX_PROVIDER === "sim") return; // local dev: no real GitHub App
    let again: typeof prs = [];
    try {
      const { token } = await createInstallationToken(appEnv(), installationId, fetch, { permissions: { pull_requests: "read" } });
      for (const pr of prs) {
        const info = await getPullRequest(token, repo, pr.number);
        if (info.state !== "open") continue;
        if (info.mergeable === null) again.push(pr);
        else await ctx.runMutation(internal.github.setMergeable, { subscriptionId: pr.subscriptionId, baseSha, mergeable: info.mergeable });
      }
    } catch (e) {
      console.error("mergeability check failed", repo, e instanceof GithubHttpError ? e.status : "unexpected");
      if (isTransientGithubError(e)) again = prs; // setMergeable is idempotent, so redoing the ones that already answered is harmless
    }
    const delay = MERGEABLE_POLL_DELAYS_MS[attempt + 1];
    if (again.length && delay !== undefined) await ctx.scheduler.runAfter(delay, internal.github.checkMergeable, { installationId, repo, baseSha, prs: again, attempt: attempt + 1 });
  },
});

// ---------------------------------------------------------------- stalled CI
const STALL_RETRY_MS = [60_000, 5 * 60_000];

export const stallInfo = internalQuery({
  args: { subscriptionId: v.id("prSubscriptions") },
  handler: async (ctx, { subscriptionId }) => {
    const sub = await ctx.db.get(subscriptionId);
    if (!sub || sub.status !== "stalled") return null; // a human resumed it, or it ended, before the comment went out
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", sub.userId)).unique();
    return s?.githubInstallationId ? { repo: sub.repo, number: sub.number, installationId: s.githubInstallationId } : null;
  },
});

/** The one comment a stalled PR gets, posted as the App: CI keeps failing, a person has to look. */
export const postStallComment = internalAction({
  args: { subscriptionId: v.id("prSubscriptions"), runUrl: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { subscriptionId, runUrl, attempt = 0 }) => {
    if (process.env.BOX_PROVIDER === "sim") return;
    const info = await ctx.runQuery(internal.github.stallInfo, { subscriptionId });
    if (!info) return;
    try {
      const { token } = await createInstallationToken(appEnv(), info.installationId, fetch, { permissions: { issues: "write" } });
      await createIssueComment(token, info.repo, info.number, `CI is still failing after the agent's automatic fix attempts, so it has stopped. A human needs to take a look.\n\nFailing run: ${runUrl}`);
    } catch (e) {
      console.error("stall comment failed", subscriptionId, e instanceof GithubHttpError ? e.status : "unexpected");
      if (isTransientGithubError(e) && attempt < STALL_RETRY_MS.length) await ctx.scheduler.runAfter(STALL_RETRY_MS[attempt], internal.github.postStallComment, { subscriptionId, runUrl, attempt: attempt + 1 });
    }
  },
});
