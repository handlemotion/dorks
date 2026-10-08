import type { CommentPolicy, SubscriptionView } from "@dorks/shared";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { append, fail } from "./dispatch";
import { normalizeRepo, prUrl, validRepo } from "./repo";

export const MAX_SUBSCRIPTIONS_PER_DORK = 50; // the bridge is driven by an untrusted agent: bound what it can make us store and hydrate

export type Subscription = Doc<"prSubscriptions">;
type Source = Subscription["source"];

/** The wire shape of a subscription (`bridge.subscriptions`, `subscriptions.list`). */
export const toView = (s: Subscription): SubscriptionView => ({
  repo: s.repo, number: s.number, url: s.url, title: s.title, headRef: s.headRef, baseRef: s.baseRef, headSha: s.headSha,
  source: s.source, status: s.status, ci: s.ci, review: s.review, mergeable: s.mergeable, ciFixAttempts: s.ciFixAttempts, state: s.state,
});

// ---------------------------------------------------------------- lookups (the webhook ingress routes through these)
// Several dorks (of one or many users) may subscribe to the same PR, so every lookup returns a list. Ended subscriptions are
// never returned: an event for them is dropped. NOTE for the ingress: a subscription only proves what a dork *asked* for. Hydration
// ends subscriptions the owner's installation cannot see, but an event must also come from the installation the owner linked
// (`payload.installation.id === userSettings.githubInstallationId`) before it is delivered to that owner's dorks.

export async function subscriptionsForPr(ctx: QueryCtx, repo: string, number: number): Promise<Subscription[]> {
  const rows = await ctx.db.query("prSubscriptions").withIndex("by_repo_number", (q) => q.eq("repo", normalizeRepo(repo)).eq("number", number)).collect();
  return rows.filter((s) => s.status !== "ended");
}

/** For events that name a branch, not a PR (check suites, pushes). The head repo is not stored: callers must ignore fork heads themselves. */
export async function subscriptionsForHead(ctx: QueryCtx, repo: string, headRef: string): Promise<Subscription[]> {
  const rows = await ctx.db.query("prSubscriptions").withIndex("by_repo_head", (q) => q.eq("repo", normalizeRepo(repo)).eq("headRef", headRef)).collect();
  return rows.filter((s) => s.status !== "ended");
}

export async function subscriptionsOfDork(ctx: QueryCtx, dorkId: Id<"dorks">): Promise<Subscription[]> {
  return ctx.db.query("prSubscriptions").withIndex("by_dork", (q) => q.eq("dorkId", dorkId)).collect();
}

const find = (ctx: QueryCtx, dorkId: Id<"dorks">, repo: string, number: number) =>
  ctx.db.query("prSubscriptions").withIndex("by_dork", (q) => q.eq("dorkId", dorkId).eq("repo", normalizeRepo(repo)).eq("number", number)).unique();

/** Stamps `lastEventAt`: every change a webhook (or a user) makes to a subscription goes through here. */
export async function updateSubscription(ctx: MutationCtx, id: Id<"prSubscriptions">, patch: Partial<Omit<Subscription, "_id" | "_creationTime" | "dorkId" | "userId" | "repo" | "number">>) {
  await ctx.db.patch(id, { ...patch, lastEventAt: Date.now() });
}

// ---------------------------------------------------------------- lifecycle of a subscription
export function checkPr(repo: string, number: number) {
  if (!validRepo(repo)) fail("invalid", "repo must be owner/name");
  if (!Number.isSafeInteger(number) || number <= 0) fail("invalid", "bad PR number");
}

/**
 * Idempotent. A new subscription starts empty and is filled in by `subscriptions.hydrate` (an action: it calls GitHub).
 * An ended one is revived; the CI attempt budget survives that unless a human asked (`user`), so unsubscribing and subscribing again
 * is not a way for the agent to buy more attempts. An existing active/stalled one is left alone, except that a human resubscribing
 * resets the budget and un-stalls it.
 */
export async function subscribe(ctx: MutationCtx, dork: Doc<"dorks">, repo: string, number: number, source: Source): Promise<Subscription> {
  checkPr(repo, number);
  const existing = await find(ctx, dork._id, repo, number);
  if (existing) {
    const revive = existing.status === "ended";
    if (!revive && source !== "user") return existing;
    await updateSubscription(ctx, existing._id, { status: "active", ...(revive ? { source } : {}), ...(source === "user" ? { ciFixAttempts: 0 } : {}) });
    if (revive) await ctx.scheduler.runAfter(0, internal.subscriptions.hydrate, { subscriptionId: existing._id }); // the PR may have moved on meanwhile
    if (revive || existing.status === "stalled") {
      await append(ctx, dork._id, { type: "subscription", repo: existing.repo, number, status: "active", reason: revive ? `subscribed (${source})` : "resumed" });
    }
    return (await ctx.db.get(existing._id))!;
  }
  const live = (await subscriptionsOfDork(ctx, dork._id)).filter((s) => s.status !== "ended");
  if (live.length >= MAX_SUBSCRIPTIONS_PER_DORK) fail("limit", `at most ${MAX_SUBSCRIPTIONS_PER_DORK} PR subscriptions per dork`);
  const name = normalizeRepo(repo);
  const id = await ctx.db.insert("prSubscriptions", {
    dorkId: dork._id, userId: dork.userId, repo: name, number, url: prUrl(name, number), source, status: "active",
    ci: "unknown", review: "none", mergeable: null, ciFixAttempts: 0, state: "open", lastEventAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.subscriptions.hydrate, { subscriptionId: id });
  await append(ctx, dork._id, { type: "subscription", repo: name, number, status: "active", reason: `subscribed (${source})` });
  return (await ctx.db.get(id))!;
}

/** Ends a subscription (no-op if already ended) and tells the transcript why. */
export async function endSubscription(ctx: MutationCtx, sub: Subscription, reason: string) {
  if (sub.status === "ended") return;
  await updateSubscription(ctx, sub._id, { status: "ended" });
  await append(ctx, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "ended", reason });
}

/** A dork stops watching a PR: also drops what was buffered for it, so nothing about it reaches the agent afterwards. */
export async function unsubscribe(ctx: MutationCtx, dorkId: Id<"dorks">, repo: string, number: number) {
  checkPr(repo, number);
  const sub = await find(ctx, dorkId, repo, number);
  if (!sub) return;
  await endSubscription(ctx, sub, "unsubscribed");
  const pending = await ctx.db.query("inbox").withIndex("by_dork_delivered", (q) => q.eq("dorkId", dorkId).eq("delivered", false)).collect();
  for (const row of pending) if (row.subscriptionId === sub._id) await ctx.db.patch(row._id, { delivered: true });
}

/** Human action: un-stalls and resets the CI attempt budget. */
export async function resume(ctx: MutationCtx, dork: Doc<"dorks">, repo: string, number: number) {
  checkPr(repo, number);
  const sub = await find(ctx, dork._id, repo, number);
  if (!sub || sub.status === "ended") return fail("not_found", "not subscribed to that PR");
  const wasStalled = sub.status === "stalled";
  await updateSubscription(ctx, sub._id, { status: "active", ciFixAttempts: 0 });
  if (wasStalled) await append(ctx, dork._id, { type: "subscription", repo: sub.repo, number, status: "active", reason: "resumed" });
}

/** Deleting a dork stops its subscriptions at once (the purge that follows removes the rows). No transcript event: the transcript goes too. */
export async function endDorkSubscriptions(ctx: MutationCtx, dorkId: Id<"dorks">) {
  for (const s of await subscriptionsOfDork(ctx, dorkId)) if (s.status !== "ended") await updateSubscription(ctx, s._id, { status: "ended" });
}

// ---------------------------------------------------------------- comment policy
/** Whether a comment by `login` may wake a dork whose owner has `policy`. The App's own comments are never allowed. Logins compare case-insensitively. */
export function commentAllowed(policy: CommentPolicy, login: string, appBotLogin: string): boolean {
  const who = login.toLowerCase();
  if (who === appBotLogin.toLowerCase()) return false;
  return policy.mode === "all" || policy.logins.some((l) => l.toLowerCase() === who);
}
