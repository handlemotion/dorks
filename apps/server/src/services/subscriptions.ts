import type { SubscriptionView } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import type { DorkRow } from "../data";
import { bool, insert, json, update, type Row } from "../db";
import { append, patchDork, setTimer } from "../lifecycle/dispatch";
import { normalizeRepo, prUrl, validRepo } from "../lib/repo";

export const MAX_SUBSCRIPTIONS_PER_DORK = 50; // the bridge is driven by an untrusted agent: bound what it can make us store and poll

/** The poller's per-PR bookkeeping: ETags, comment cursors, the base commit last seen. Not part of `SubscriptionView`. */
export interface PollState {
  /** Request path (with query) -> ETag, for conditional requests. Only paths used on the last tick are kept. */
  etags?: Record<string, string>;
  /** The first full read (reviews and comments) is a baseline: nothing in it is replayed to the agent. */
  baselined?: boolean;
  /** ISO time: comment lists are read from here, so each request stays small and cacheable. */
  since?: string;
  lastReviewId?: number;
  lastCommentId?: number;
  lastReviewCommentId?: number;
  /** Base commit the last mergeability answer was for. */
  baseSha?: string;
  /** Head the `seen` suites belong to. */
  checksSha?: string;
  /** Check suite id -> the outcome already reported for it. */
  seen?: Record<string, "pass" | "fail">;
}

export interface Subscription {
  id: number;
  dorkId: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
  headRef?: string;
  baseRef?: string;
  headSha?: string;
  source: "auto" | "agent" | "user";
  status: "active" | "stalled" | "ended";
  ci: "unknown" | "pending" | "passing" | "failing";
  review: "none" | "commented" | "changes_requested" | "approved";
  mergeable: boolean | null;
  ciFixAttempts: number;
  state: "open" | "closed" | "merged";
  lastEventAt: number;
  /** Check suites of the current head that failed and have not passed since. */
  ciFailing?: number[];
  /** A `ci_failed` for the current head was queued: the next push counts as a fix attempt. */
  ciNotified?: boolean;
  /** Head SHA a `ready` was already queued for. */
  readySha?: string;
  /** Base SHA a `conflict` was already queued for. */
  conflictSha?: string;
  poll?: PollState;
}

const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const subOf = (r: Row): Subscription => ({
  id: r.id as number, dorkId: r.dork_id as string, repo: r.repo as string, number: r.number as number, url: r.url as string,
  title: u(r.title as string | null), headRef: u(r.head_ref as string | null), baseRef: u(r.base_ref as string | null), headSha: u(r.head_sha as string | null),
  source: r.source as Subscription["source"], status: r.status as Subscription["status"], ci: r.ci as Subscription["ci"], review: r.review as Subscription["review"],
  mergeable: r.mergeable === null ? null : bool(r.mergeable), ciFixAttempts: r.ci_fix_attempts as number, state: r.state as Subscription["state"],
  lastEventAt: r.last_event_at as number, ciFailing: json(r.ci_failing), ciNotified: r.ci_notified === null ? undefined : bool(r.ci_notified),
  readySha: u(r.ready_sha as string | null), conflictSha: u(r.conflict_sha as string | null), poll: json(r.poll),
});

/** The wire shape of a subscription (`bridge subscriptions push`, `GET /api/dorks/:id/subscriptions`). */
export const toView = (s: Subscription): SubscriptionView => ({
  repo: s.repo, number: s.number, url: s.url, title: s.title, headRef: s.headRef, baseRef: s.baseRef, headSha: s.headSha,
  source: s.source, status: s.status, ci: s.ci, review: s.review, mergeable: s.mergeable, ciFixAttempts: s.ciFixAttempts, state: s.state,
});

// ---------------------------------------------------------------- lookups
export const getSub = (app: App, id: number): Subscription | undefined => {
  const r = app.db.get("SELECT * FROM pr_subscriptions WHERE id = ?", id);
  return r ? subOf(r) : undefined;
};

export const subscriptionsOfDork = (app: App, dorkId: string): Subscription[] =>
  app.db.all("SELECT * FROM pr_subscriptions WHERE dork_id = ? ORDER BY id", dorkId).map(subOf);

export const liveSubscriptionViews = (app: App, dorkId: string): SubscriptionView[] => subscriptionsOfDork(app, dorkId).filter((s) => s.status !== "ended").map(toView);

/** Subscriptions the poller must look at: not ended, still open, and the dork is neither archived nor being deleted. */
export const pollable = (app: App): Subscription[] =>
  app.db.all(
    `SELECT s.* FROM pr_subscriptions s JOIN dorks d ON d.id = s.dork_id
     WHERE s.status != 'ended' AND s.state = 'open' AND d.deleting = 0 AND d.archived = 0 ORDER BY s.id`,
  ).map(subOf);

const find = (app: App, dorkId: string, repo: string, number: number): Subscription | undefined => {
  const r = app.db.get("SELECT * FROM pr_subscriptions WHERE dork_id = ? AND repo = ? AND number = ?", dorkId, normalizeRepo(repo), number);
  return r ? subOf(r) : undefined;
};

/** Stamps `lastEventAt`: every change the poller (or a user) makes to a subscription goes through here. */
export function updateSubscription(app: App, id: number, patch: Partial<Omit<Subscription, "id" | "dorkId" | "repo" | "number">>) {
  update(app.db, "pr_subscriptions", { id }, { ...patch, lastEventAt: app.now() });
  const dorkId = app.db.get<{ dork_id: string }>("SELECT dork_id FROM pr_subscriptions WHERE id = ?", id)?.dork_id;
  if (dorkId) touch(app, { t: "subscriptions", dorkId });
}

/** Bookkeeping that is not a subscription change: no `lastEventAt`, no notification to listeners. */
export const savePollState = (app: App, id: number, poll: PollState) => update(app.db, "pr_subscriptions", { id }, { poll });

const pollSoon = (app: App) => setTimer(app, "", "poll", 0);

// ---------------------------------------------------------------- lifecycle of a subscription
export function checkPr(repo: string, number: number) {
  if (typeof repo !== "string" || !validRepo(repo)) fail("invalid", "repo must be owner/name");
  if (!Number.isSafeInteger(number) || number <= 0) fail("invalid", "bad PR number");
}

/**
 * Idempotent. A new subscription starts empty and is filled in by the poller. An ended one is revived; the CI attempt budget
 * survives that unless a human asked (`user`), so unsubscribing and subscribing again is not a way for the agent to buy more
 * attempts. An existing active/stalled one is left alone, except that a human resubscribing resets the budget and un-stalls it.
 */
export function subscribe(app: App, dork: DorkRow, repo: string, number: number, source: Subscription["source"]): Subscription {
  checkPr(repo, number);
  const existing = find(app, dork.id, repo, number);
  if (existing) {
    const revive = existing.status === "ended";
    if (!revive && source !== "user") return existing;
    updateSubscription(app, existing.id, { status: "active", ...(revive ? { source } : {}), ...(source === "user" ? { ciFixAttempts: 0 } : {}) });
    if (revive) pollSoon(app); // the PR may have moved on meanwhile
    if (revive || existing.status === "stalled") {
      append(app, dork.id, { type: "subscription", repo: existing.repo, number, status: "active", reason: revive ? `subscribed (${source})` : "resumed" });
    }
    return getSub(app, existing.id)!;
  }
  if (subscriptionsOfDork(app, dork.id).filter((s) => s.status !== "ended").length >= MAX_SUBSCRIPTIONS_PER_DORK) {
    fail("limit", `at most ${MAX_SUBSCRIPTIONS_PER_DORK} PR subscriptions per dork`);
  }
  const name = normalizeRepo(repo);
  insert(app.db, "pr_subscriptions", {
    dorkId: dork.id, repo: name, number, url: prUrl(name, number), source, status: "active", ci: "unknown", review: "none", mergeable: null,
    ciFixAttempts: 0, state: "open", lastEventAt: app.now(),
  });
  const id = app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  pollSoon(app);
  // The gh shim saw this dork create the PR: that is the "PR opened" moment, and the dork's headline link.
  if (source === "auto") {
    append(app, dork.id, { type: "pr_opened", url: prUrl(name, number), number });
    patchDork(app, dork.id, { prUrl: prUrl(name, number), lastActivityAt: app.now() });
  }
  append(app, dork.id, { type: "subscription", repo: name, number, status: "active", reason: `subscribed (${source})` });
  touch(app, { t: "subscriptions", dorkId: dork.id });
  return getSub(app, id)!;
}

/** Ends a subscription (no-op if already ended) and tells the transcript why. */
export function endSubscription(app: App, sub: Subscription, reason: string) {
  if (sub.status === "ended") return;
  updateSubscription(app, sub.id, { status: "ended" });
  append(app, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "ended", reason });
}

/** A dork stops watching a PR: also drops what was buffered for it, so nothing about it reaches the agent afterwards. */
export function unsubscribe(app: App, dorkId: string, repo: string, number: number) {
  checkPr(repo, number);
  const sub = find(app, dorkId, repo, number);
  if (!sub) return;
  endSubscription(app, sub, "unsubscribed");
  app.db.run("UPDATE inbox SET delivered = 1 WHERE dork_id = ? AND subscription_id = ? AND delivered = 0", dorkId, sub.id);
}

/** Human action: un-stalls and resets the CI attempt budget. */
export function resume(app: App, dork: DorkRow, repo: string, number: number) {
  checkPr(repo, number);
  const sub = find(app, dork.id, repo, number);
  if (!sub || sub.status === "ended") return fail("not_found", "not subscribed to that PR");
  const wasStalled = sub.status === "stalled";
  updateSubscription(app, sub.id, { status: "active", ciFixAttempts: 0 });
  if (wasStalled) append(app, dork.id, { type: "subscription", repo: sub.repo, number, status: "active", reason: "resumed" });
}

/** A human is involved (comment, message): the CI attempt budget starts over and a stalled subscription resumes. */
export function resetCiAttempts(app: App, sub: Subscription, reason: string) {
  const stalled = sub.status === "stalled";
  if (!stalled && sub.ciFixAttempts === 0) return;
  updateSubscription(app, sub.id, { ciFixAttempts: 0, status: stalled ? "active" : sub.status });
  if (stalled) append(app, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "active", reason });
}

/** Deleting a dork stops its subscriptions at once (the purge removes the rows). No transcript event: the transcript goes too. */
export function endDorkSubscriptions(app: App, dorkId: string) {
  for (const s of subscriptionsOfDork(app, dorkId)) if (s.status !== "ended") updateSubscription(app, s.id, { status: "ended" });
}
