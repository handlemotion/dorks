import { CI_FIX_MAX_ATTEMPTS, DEFAULT_COMMENT_POLICY } from "@dorks/shared";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { append } from "./dispatch";
import { appBotLogin, sentByApp, type GithubEvent } from "./githubEvents";
import { enqueueNotification } from "./notify";
import { MAX_SUMMARY_CHARS } from "./notifyRender";
import {
  commentAllowed, endSubscription, resetCiAttempts, subscriptionsForBase, subscriptionsForHead, subscriptionsForPr, updateSubscription, type Subscription,
} from "./subscriptions";

// What a verified GitHub delivery does to PR subscriptions (docs/autonomy.md, "Webhook"). The parsing is lib/githubEvents.ts; this
// runs inside one mutation (convex/github.ts ingest), so a delivery is applied atomically or not at all, and a retry is safe.

/** Mergeability is computed lazily by GitHub after a push: the action polls at these delays (the first one is the wait before the first look). */
export const MERGEABLE_POLL_DELAYS_MS = [5_000, 15_000, 45_000, 2 * 60_000, 5 * 60_000];
const MAX_TRACKED_SUITES = 20; // failing check suites remembered per head: a pathological repo must not grow the row

const short = (sha: string) => sha.slice(0, 7);
const quote = (text: string) => (text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text);
const checksUrl = (repo: string, sha: string, suiteId: number) => `https://github.com/${repo}/commit/${sha}/checks?check_suite_id=${suiteId}`;

interface Routed {
  sub: Subscription;
  /** The owner's settings: their comment policy and GitHub login. */
  owner: Doc<"userSettings"> | null;
}

/**
 * Keeps the subscriptions whose owner linked the installation that sent the event. A subscription only says what a dork *asked* for:
 * without this check anyone who can name a repo could feed events to a stranger's dork from their own installation.
 */
async function routeTo(ctx: MutationCtx, subs: Subscription[], installationId: number): Promise<Routed[]> {
  const owners = new Map<string, Doc<"userSettings"> | null>();
  const routed: Routed[] = [];
  for (const sub of subs) {
    if (!owners.has(sub.userId)) owners.set(sub.userId, await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", sub.userId)).unique());
    const owner = owners.get(sub.userId)!;
    if (owner?.githubInstallationId === installationId) routed.push({ sub, owner });
  }
  return routed;
}

/** The owner's own login always wakes their dorks; everyone else goes through the owner's comment policy. */
function mayComment(owner: Doc<"userSettings"> | null, login: string, slug: string): boolean {
  if (owner?.githubLogin?.toLowerCase() === login.toLowerCase()) return true;
  return commentAllowed(owner?.commentPolicy ?? DEFAULT_COMMENT_POLICY, login, appBotLogin(slug));
}

/**
 * Applies one verified, parsed delivery. Returns false for a delivery id seen before (GitHub retries, and anyone can redeliver).
 * Events from the App's own bot user never wake the dork, but still keep the subscription's state right (a push moves the head, a
 * close ends it); the exceptions are CI results and pushes to a base branch, which are about the code, not about who sent them.
 */
export async function ingestEvent(ctx: MutationCtx, deliveryId: string, event: GithubEvent, appSlug: string): Promise<boolean> {
  if (await ctx.db.query("githubDeliveries").withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId)).first()) return false;
  await ctx.db.insert("githubDeliveries", { deliveryId, receivedAt: Date.now() });

  const own = sentByApp(event.sender, appSlug);
  const login = event.sender.login;
  const notify = (sub: Subscription, kind: Parameters<typeof enqueueNotification>[3], summary: string) =>
    enqueueNotification(ctx, sub.dorkId, sub._id, kind, summary, deliveryId);

  switch (event.kind) {
    case "pr_closed":
      for (const { sub } of await routeTo(ctx, await subscriptionsForPr(ctx, event.repo, event.number), event.installationId)) {
        const how = event.merged ? "merged" : "closed";
        await updateSubscription(ctx, sub._id, { state: how });
        await endSubscription(ctx, sub, how);
        if (!own) await notify(sub, "closed", `${event.merged ? "Merged" : "Closed"} by ${login}.`);
      }
      return true;

    case "pr_synchronize":
      for (const { sub } of await routeTo(ctx, await subscriptionsForPr(ctx, event.repo, event.number), event.installationId)) {
        if (sub.headSha === event.headSha) continue; // hydration already saw this head
        // A failure still waiting out the debounce never reached the agent and is about the old head now: drop it. One that was
        // handed over and answered by this push is a fix attempt (a stalled subscription is past counting).
        const unsent = (await ctx.db.query("inbox").withIndex("by_dork_delivered", (q) => q.eq("dorkId", sub.dorkId).eq("delivered", false)).collect())
          .filter((r) => r.subscriptionId === sub._id && r.kind === "ci_failed");
        for (const row of unsent) await ctx.db.delete(row._id);
        const attempt = sub.status === "active" && sub.ciNotified === true && !unsent.length;
        await updateSubscription(ctx, sub._id, {
          headSha: event.headSha, headRef: event.headRef, ci: "pending", ciFailing: [], ciNotified: false, mergeable: null,
          ciFixAttempts: sub.ciFixAttempts + (attempt ? 1 : 0),
        });
      }
      return true;

    case "pr_base_changed":
      for (const { sub } of await routeTo(ctx, await subscriptionsForPr(ctx, event.repo, event.number), event.installationId)) {
        if (sub.baseRef === event.baseRef) continue;
        await updateSubscription(ctx, sub._id, { baseRef: event.baseRef, mergeable: null, conflictSha: undefined });
        if (!own) await notify(sub, "base_changed", `${login} changed the base branch from ${event.from} to ${event.baseRef}.`);
      }
      return true;

    case "review":
      if (own) return true;
      for (const { sub, owner } of await routeTo(ctx, await subscriptionsForPr(ctx, event.repo, event.number), event.installationId)) {
        if (!mayComment(owner, login, appSlug)) continue;
        // A comment-only review never downgrades an approval or a change request.
        const review = event.state === "commented" ? (sub.review === "none" ? "commented" : sub.review) : event.state;
        await updateSubscription(ctx, sub._id, { review });
        const bare = !event.body.trim() && event.state !== "changes_requested"; // its inline comments arrive as their own events
        if (!bare) {
          const verb = { approved: "approved", changes_requested: "requested changes", commented: "reviewed" }[event.state];
          await notify(sub, "review", `${login} ${verb}${event.body.trim() ? `: ${quote(event.body.trim())}` : ""} (${event.url})`);
        }
        await maybeReady(ctx, sub._id, deliveryId);
      }
      return true;

    case "comment":
      if (own) return true;
      for (const { sub, owner } of await routeTo(ctx, await subscriptionsForPr(ctx, event.repo, event.number), event.installationId)) {
        if (!mayComment(owner, login, appSlug)) continue;
        if (!event.sender.bot) await resetCiAttempts(ctx, sub, "resumed by a comment"); // a person is looking at it: CI gets a fresh budget
        await notify(sub, "comment", `${login} commented${event.path ? ` on ${event.path}` : ""}: ${quote(event.body.trim())} (${event.url})`);
      }
      return true;

    case "check_suite": {
      if (!event.headBranch) return true;
      // Head branches are not unique across forks (a fork PR's branch may share a name with one in this repo), the SHA is: ignore
      // suites for any other commit than the PR's current head.
      const current = (await subscriptionsForHead(ctx, event.repo, event.headBranch)).filter((s) => s.headSha === event.headSha);
      for (const { sub } of await routeTo(ctx, current, event.installationId)) await onCheckSuite(ctx, sub, event, deliveryId);
      return true;
    }

    case "push": {
      const targets = (await routeTo(ctx, await subscriptionsForBase(ctx, event.repo, event.branch), event.installationId)).filter((r) => r.sub.state === "open");
      if (targets.length) {
        await ctx.scheduler.runAfter(MERGEABLE_POLL_DELAYS_MS[0], internal.github.checkMergeable, {
          installationId: event.installationId, repo: event.repo, baseSha: event.sha, prs: targets.map((r) => ({ subscriptionId: r.sub._id, number: r.sub.number })), attempt: 0,
        });
      }
      return true;
    }
  }
}

async function onCheckSuite(ctx: MutationCtx, sub: Subscription, event: Extract<GithubEvent, { kind: "check_suite" }>, deliveryId: string) {
  const others = (sub.ciFailing ?? []).filter((id) => id !== event.suiteId);

  if (event.outcome === "pass") {
    // One green suite proves nothing: another workflow of this head may still be running or red. Only the action below, which reads
    // every suite of the head, may apply the green transition.
    await updateSubscription(ctx, sub._id, { ciFailing: others, ...(!others.length && sub.ci === "failing" ? { ci: "pending" } : {}) });
    if (!others.length && sub.headSha) {
      await ctx.scheduler.runAfter(0, internal.github.confirmGreen, { subscriptionId: sub._id, headSha: sub.headSha, installationId: event.installationId, repo: event.repo, attempt: 0 });
    }
    return;
  }

  const failing = [...others, event.suiteId].slice(-MAX_TRACKED_SUITES);
  if (sub.status === "stalled") return void (await updateSubscription(ctx, sub._id, { ci: "failing", ciFailing: failing })); // nothing about CI reaches the agent until a human acts
  if (sub.ciFixAttempts >= CI_FIX_MAX_ATTEMPTS) {
    const reason = `CI is still failing after ${CI_FIX_MAX_ATTEMPTS} fix attempts; a human is needed`;
    await updateSubscription(ctx, sub._id, { ci: "failing", ciFailing: failing, status: "stalled" });
    await append(ctx, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "stalled", reason });
    await ctx.scheduler.runAfter(0, internal.github.postStallComment, { subscriptionId: sub._id, runUrl: checksUrl(event.repo, event.headSha, event.suiteId) });
    return;
  }
  await updateSubscription(ctx, sub._id, { ci: "failing", ciFailing: failing, ciNotified: true });
  await enqueueNotification(ctx, sub.dorkId, sub._id, "ci_failed", `Checks failed on ${short(event.headSha)}: ${checksUrl(event.repo, event.headSha, event.suiteId)}`, deliveryId);
}

/**
 * `ready` once per head: CI is green and the PR is approved. Whether the repo requires reviews is not knowable without admin
 * permissions, so a PR nobody reviewed is never "ready" (the agent would post a standby note on every green push).
 */
async function maybeReady(ctx: MutationCtx, subscriptionId: Subscription["_id"], deliveryId?: string) {
  const sub = (await ctx.db.get(subscriptionId))!;
  if (sub.status !== "active" || sub.ci !== "passing" || sub.review !== "approved" || !sub.headSha || sub.readySha === sub.headSha) return;
  await updateSubscription(ctx, sub._id, { readySha: sub.headSha });
  await enqueueNotification(ctx, sub.dorkId, sub._id, "ready", `CI passed on ${short(sub.headSha)} and the PR is approved.`, deliveryId);
}

/**
 * Every check suite of the head is completed and none failed (confirmed by `github.confirmGreen`): CI is green. Resets the attempt budget,
 * un-stalls, and delivers `ready` if the PR is approved. Idempotent per head SHA; a head that moved on meanwhile is ignored.
 */
export async function applyGreen(ctx: MutationCtx, sub: Subscription, headSha: string) {
  if (sub.status === "ended" || sub.headSha !== headSha || sub.ciFailing?.length) return; // stale, or a red suite was reported while the action ran
  const stalled = sub.status === "stalled";
  await updateSubscription(ctx, sub._id, { ci: "passing", ciFailing: [], ciNotified: false, ciFixAttempts: 0, status: stalled ? "active" : sub.status });
  if (stalled) await append(ctx, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "active", reason: "CI passed" });
  await maybeReady(ctx, sub._id);
}

/** The mergeability poll found a definite answer for a PR whose base moved to `baseSha`. */
export async function applyMergeable(ctx: MutationCtx, sub: Subscription, baseSha: string, mergeable: boolean) {
  await updateSubscription(ctx, sub._id, { mergeable });
  if (mergeable || sub.conflictSha === baseSha) return; // one conflict notice per base commit
  await updateSubscription(ctx, sub._id, { conflictSha: baseSha });
  await enqueueNotification(ctx, sub.dorkId, sub._id, "conflict", `The PR no longer merges cleanly into ${sub.baseRef ?? "its base"} (now at ${short(baseSha)}).`);
}
