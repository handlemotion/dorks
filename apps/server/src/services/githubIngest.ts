import { CI_FIX_MAX_ATTEMPTS, DEFAULT_COMMENT_POLICY, type CommentPolicy, type NotifyKind } from "@dorks/shared";
import type { App } from "../app";
import { append, setTimer } from "../lifecycle/dispatch";
import { MAX_SUMMARY_CHARS } from "../lib/notifyRender";
import { enqueueNotification } from "./notify";
import { endSubscription, getSub, resetCiAttempts, updateSubscription, type Subscription } from "./subscriptions";

// What a change observed on a subscribed PR does to the subscription (docs/autonomy.md). The poller (services/poller.ts) turns
// GitHub responses into these events; this runs inside one transaction per event, so each is applied atomically.

export interface Actor {
  login: string;
  bot: boolean;
}

export type PrEvent =
  | { kind: "pr_closed"; merged: boolean; sender: Actor }
  | { kind: "pr_synchronize"; headSha: string; headRef: string }
  | { kind: "pr_base_changed"; baseRef: string; from: string; sender: Actor }
  /** `at`: when GitHub says it was written (epoch ms), to tell the agent's comments from the token owner's own (see `byAgent`). */
  | { kind: "review"; state: "approved" | "changes_requested" | "commented"; body: string; url: string; sender: Actor; at?: number }
  | { kind: "comment"; body: string; url: string; path?: string; sender: Actor; at?: number }
  | { kind: "check_suite"; suiteId: number; headSha: string; outcome: "pass" | "fail" }
  /** Every check suite of the head has completed and none failed. */
  | { kind: "ci_green"; headSha: string }
  /** A definite mergeability answer for the PR against the base at `baseSha`. */
  | { kind: "mergeable"; baseSha: string; mergeable: boolean };

export interface IngestEnv {
  /** Login of the token the agent runs as: events it caused are its own and never wake it. */
  ownLogin?: string;
  policy: CommentPolicy;
}

/**
 * How long after a turn ends a comment by the token's login still counts as the agent's: GitHub stamps it when the request lands,
 * which is before the turn ends, give or take clock skew between GitHub and this machine.
 */
export const AGENT_COMMENT_GRACE_MS = 15_000;
const MAX_TRACKED_SUITES = 20; // failing check suites remembered per head: a pathological repo must not grow the row
const short = (sha: string) => sha.slice(0, 7);
const quote = (text: string) => (text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text);
const checksUrl = (repo: string, sha: string, suiteId: number) => `https://github.com/${repo}/commit/${sha}/checks?check_suite_id=${suiteId}`;

/**
 * Whether a comment by `login` may wake the dork under the policy. The token's owner always may: whether a comment of theirs was
 * really the agent's is `byAgent`'s call. Logins compare case-insensitively.
 */
export function commentAllowed(policy: CommentPolicy, login: string, ownLogin?: string): boolean {
  const who = login.toLowerCase();
  if (ownLogin && who === ownLogin.toLowerCase()) return true;
  return policy.mode === "all" || policy.logins.some((l) => l.toLowerCase() === who);
}

/** Whether `dorkId` was running a turn at `at` (or finished one less than AGENT_COMMENT_GRACE_MS before), from its status events. */
function turnAt(app: App, dorkId: string, at: number): boolean {
  const rows = app.db.all<{ ts: number; state: string }>(
    `SELECT ts, json_extract(body, '$.state') AS state FROM events
     WHERE dork_id = ? AND ts <= ? AND json_extract(body, '$.type') = 'status' ORDER BY seq DESC LIMIT 2`,
    dorkId, at,
  );
  const [last, prev] = rows;
  if (!last) return false;
  if (last.state === "working") return true;
  return !!prev && prev.state === "working" && at - last.ts <= AGENT_COMMENT_GRACE_MS;
}

/**
 * The dork acts on GitHub as the token's owner, who is usually also the person reviewing its PRs, so the login alone cannot tell
 * the agent's own comments from the owner's. A comment or review by that login is the agent's when a dork subscribed to the PR
 * was mid-turn when GitHub stamped it; written while every such dork was idle or asleep, it is the owner's and wakes the dork.
 * Without a timestamp it is treated as the agent's (never wake on what may be our own words).
 */
export function byAgent(app: App, sub: Subscription, sender: Actor, at: number | undefined, ownLogin: string | undefined): boolean {
  if (!ownLogin || sender.login.toLowerCase() !== ownLogin.toLowerCase()) return false;
  if (at === undefined) return true;
  const dorks = app.db.all<{ dork_id: string }>("SELECT DISTINCT dork_id FROM pr_subscriptions WHERE repo = ? AND number = ? AND status != 'ended'", sub.repo, sub.number);
  return [sub.dorkId, ...dorks.map((d) => d.dork_id)].some((id) => turnAt(app, id, at));
}

export const ingestEnv = (app: App, ownLogin: string | undefined, policy: CommentPolicy | undefined): IngestEnv => ({ ownLogin, policy: policy ?? DEFAULT_COMMENT_POLICY });

/** Applies one observed event to a subscription. A no-op once the subscription has ended. */
export function ingestEvent(app: App, subId: number, event: PrEvent, env: IngestEnv): void {
  const sub = getSub(app, subId);
  if (!sub || sub.status === "ended") return;
  const own = (a: Actor) => !!env.ownLogin && a.login.toLowerCase() === env.ownLogin.toLowerCase();
  const notify = (kind: NotifyKind, summary: string) => enqueueNotification(app, sub.dorkId, sub.id, kind, summary);

  switch (event.kind) {
    case "pr_closed": {
      const how = event.merged ? "merged" : "closed";
      updateSubscription(app, sub.id, { state: how });
      if (event.merged) append(app, sub.dorkId, { type: "pr_merged", url: sub.url, number: sub.number });
      endSubscription(app, getSub(app, sub.id)!, how);
      if (!own(event.sender)) notify("closed", `${event.merged ? "Merged" : "Closed"} by ${event.sender.login}.`);
      return;
    }

    case "pr_synchronize": {
      if (sub.headSha === event.headSha) return; // hydration already saw this head
      // A failure still waiting out the debounce never reached the agent and is about the old head now: drop it. One that was
      // handed over and answered by this push is a fix attempt (a stalled subscription is past counting).
      const unsent = app.db.all<{ id: number }>("SELECT id FROM inbox WHERE dork_id = ? AND subscription_id = ? AND delivered = 0 AND kind = 'ci_failed'", sub.dorkId, sub.id);
      for (const row of unsent) app.db.run("DELETE FROM inbox WHERE id = ?", row.id);
      const attempt = sub.status === "active" && sub.ciNotified === true && !unsent.length;
      updateSubscription(app, sub.id, {
        headSha: event.headSha, headRef: event.headRef, ci: "pending", ciFailing: [], ciNotified: false, mergeable: null,
        ciFixAttempts: sub.ciFixAttempts + (attempt ? 1 : 0),
      });
      return;
    }

    case "pr_base_changed":
      if (sub.baseRef === event.baseRef) return;
      updateSubscription(app, sub.id, { baseRef: event.baseRef, mergeable: null, conflictSha: undefined });
      if (!own(event.sender)) notify("base_changed", `${event.sender.login} changed the base branch from ${event.from} to ${event.baseRef}.`);
      return;

    case "review": {
      if (byAgent(app, sub, event.sender, event.at, env.ownLogin) || !commentAllowed(env.policy, event.sender.login, env.ownLogin)) return;
      // A comment-only review never downgrades an approval or a change request.
      const review = event.state === "commented" ? (sub.review === "none" ? "commented" : sub.review) : event.state;
      updateSubscription(app, sub.id, { review });
      const bare = !event.body.trim() && event.state !== "changes_requested"; // its inline comments arrive as their own events
      if (!bare) {
        const verb = { approved: "approved", changes_requested: "requested changes", commented: "reviewed" }[event.state];
        notify("review", `${event.sender.login} ${verb}${event.body.trim() ? `: ${quote(event.body.trim())}` : ""} (${event.url})`);
      }
      maybeReady(app, sub.id);
      return;
    }

    case "comment":
      if (byAgent(app, sub, event.sender, event.at, env.ownLogin) || !commentAllowed(env.policy, event.sender.login, env.ownLogin)) return;
      if (!event.sender.bot) resetCiAttempts(app, sub, "resumed by a comment"); // a person is looking at it: CI gets a fresh budget
      notify("comment", `${event.sender.login} commented${event.path ? ` on ${event.path}` : ""}: ${quote(event.body.trim())} (${event.url})`);
      return;

    case "check_suite":
      // Head SHAs are unique across forks; ignore suites for any other commit than the PR's current head.
      if (sub.headSha !== event.headSha) return;
      return onCheckSuite(app, sub, event);

    case "ci_green":
      return applyGreen(app, sub, event.headSha);

    case "mergeable":
      updateSubscription(app, sub.id, { mergeable: event.mergeable });
      if (event.mergeable || sub.conflictSha === event.baseSha) return; // one conflict notice per base commit
      updateSubscription(app, sub.id, { conflictSha: event.baseSha });
      notify("conflict", `The PR no longer merges cleanly into ${sub.baseRef ?? "its base"} (now at ${short(event.baseSha)}).`);
      return;
  }
}

function onCheckSuite(app: App, sub: Subscription, event: Extract<PrEvent, { kind: "check_suite" }>) {
  const others = (sub.ciFailing ?? []).filter((id) => id !== event.suiteId);

  if (event.outcome === "pass") {
    // One green suite proves nothing: another workflow of this head may still be running or red. Only `ci_green`, derived from
    // every suite of the head, may apply the green transition.
    updateSubscription(app, sub.id, { ciFailing: others, ...(!others.length && sub.ci === "failing" ? { ci: "pending" } : {}) });
    return;
  }

  const failing = [...others, event.suiteId].slice(-MAX_TRACKED_SUITES);
  if (sub.status === "stalled") return void updateSubscription(app, sub.id, { ci: "failing", ciFailing: failing }); // nothing about CI reaches the agent until a human acts
  if (sub.ciFixAttempts >= CI_FIX_MAX_ATTEMPTS) {
    const reason = `CI is still failing after ${CI_FIX_MAX_ATTEMPTS} fix attempts; a human is needed`;
    updateSubscription(app, sub.id, { ci: "failing", ciFailing: failing, status: "stalled" });
    append(app, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "stalled", reason });
    setTimer(app, sub.dorkId, `stall:${sub.id}`, 0, { subscriptionId: sub.id, runUrl: checksUrl(sub.repo, event.headSha, event.suiteId) });
    return;
  }
  updateSubscription(app, sub.id, { ci: "failing", ciFailing: failing, ciNotified: true });
  enqueueNotification(app, sub.dorkId, sub.id, "ci_failed", `Checks failed on ${short(event.headSha)}: ${checksUrl(sub.repo, event.headSha, event.suiteId)}`);
}

/**
 * `ready` once per head: CI is green and the PR is approved. Whether the repo requires reviews is not knowable without admin
 * permissions, so a PR nobody reviewed is never "ready" (the agent would post a standby note on every green push).
 */
function maybeReady(app: App, subId: number) {
  const sub = getSub(app, subId)!;
  if (sub.status !== "active" || sub.ci !== "passing" || sub.review !== "approved" || !sub.headSha || sub.readySha === sub.headSha) return;
  updateSubscription(app, sub.id, { readySha: sub.headSha });
  enqueueNotification(app, sub.dorkId, sub.id, "ready", `CI passed on ${short(sub.headSha)} and the PR is approved.`);
}

/**
 * Every check suite of the head is completed and none failed: CI is green. Resets the attempt budget, un-stalls, and delivers
 * `ready` if the PR is approved. Idempotent per head SHA; a head that moved on meanwhile is ignored.
 */
function applyGreen(app: App, sub: Subscription, headSha: string) {
  if (sub.status === "ended" || sub.headSha !== headSha || sub.ciFailing?.length) return; // stale, or a red suite was reported meanwhile
  if (sub.ci === "passing") return maybeReady(app, sub.id);
  const stalled = sub.status === "stalled";
  updateSubscription(app, sub.id, { ci: "passing", ciFailing: [], ciNotified: false, ciFixAttempts: 0, status: stalled ? "active" : sub.status });
  if (stalled) append(app, sub.dorkId, { type: "subscription", repo: sub.repo, number: sub.number, status: "active", reason: "CI passed" });
  maybeReady(app, sub.id);
}
