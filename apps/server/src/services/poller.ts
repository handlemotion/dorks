import type { App } from "../app";
import { GithubHttpError, getCached, suiteOutcome } from "../lib/github";
import { githubToken, readSettings } from "./settings";
import { update } from "../db";
import { ingestEnv, ingestEvent, type Actor, type PrEvent } from "./githubIngest";
import { endSubscription, getSub, pollable, savePollState, updateSubscription, type PollState, type Subscription } from "./subscriptions";

// PR autonomy without webhooks: read each subscribed PR with conditional requests (a 304 is free against the rate limit), turn
// what changed into the PR events services/githubIngest.ts applies. Everything async happens here; the writes are one
// transaction per subscription.

export const POLL_MS = 30_000;
export const POLL_AUTH_FAILED_MS = 5 * 60_000;
const NOT_VISIBLE = "PR not found or not accessible to your GitHub token";

interface GhUser { login: string; type?: string }
interface GhPr {
  title: string; state: "open" | "closed"; merged?: boolean; mergeable: boolean | null; merged_by?: GhUser | null;
  head: { ref: string; sha: string }; base: { ref: string; sha: string; repo?: { full_name: string } };
}
interface GhReview { id: number; state: string; body: string | null; html_url: string; user: GhUser | null }
interface GhComment { id: number; body: string; html_url: string; path?: string; user: GhUser | null; created_at: string }
interface GhSuites { check_suites: { id: number; status: string; conclusion: string | null; latest_check_runs_count: number }[] }

const actor = (u: GhUser | null | undefined): Actor => ({ login: u?.login ?? "ghost", bot: u?.type === "Bot" });

export interface Observation {
  events: PrEvent[];
  /** Applied before the events: first-time hydration and the review baseline. */
  baseline?: Partial<Omit<Subscription, "id" | "dorkId" | "repo" | "number">>;
  /** Why the subscription must end (the PR is not visible, or already closed). */
  end?: string;
  poll: PollState;
}

/** Reads GitHub for one subscription. Throws GithubHttpError for failures other than a missing PR. */
export async function observe(app: App, token: string, sub: Subscription): Promise<Observation> {
  const old = sub.poll ?? {};
  const etags: Record<string, string> = {};
  const poll: PollState = { ...old, etags };
  const events: PrEvent[] = [];
  const baseline: NonNullable<Observation["baseline"]> = {};

  const get = async <T>(path: string) => {
    const r = await getCached<T>(app.fetch, token, path, old.etags?.[path], app.now());
    if (r.status === 200 && r.etag) etags[path] = r.etag;
    else if (r.status === 304 && old.etags?.[path]) etags[path] = old.etags[path];
    return r;
  };
  const base = `/repos/${sub.repo}`;
  const prPath = `${base}/pulls/${sub.number}`;

  // ---- the PR itself
  let head = sub.headSha;
  try {
    const r = await get<GhPr>(prPath);
    if (r.status === 200) {
      const pr = r.json;
      const state = pr.merged ? "merged" : pr.state;
      head = pr.head.sha;
      if (!sub.title) {
        // First look: fill the subscription in. Not an event.
        Object.assign(baseline, { title: pr.title, headRef: pr.head.ref, headSha: pr.head.sha, baseRef: pr.base.ref, state, mergeable: pr.mergeable });
        poll.baseSha = pr.base.sha;
        if (state !== "open") return { events, baseline, end: state, poll };
      } else if (state !== "open") {
        events.push({ kind: "pr_closed", merged: state === "merged", sender: actor(pr.merged_by) });
        return { events, baseline, poll };
      } else {
        if (pr.head.sha !== sub.headSha) events.push({ kind: "pr_synchronize", headSha: pr.head.sha, headRef: pr.head.ref });
        if (pr.base.ref !== sub.baseRef) events.push({ kind: "pr_base_changed", baseRef: pr.base.ref, from: sub.baseRef ?? "", sender: { login: "someone", bot: false } });
        if (pr.mergeable !== null && (pr.mergeable !== sub.mergeable || pr.base.sha !== old.baseSha)) events.push({ kind: "mergeable", baseSha: pr.base.sha, mergeable: pr.mergeable });
        if (pr.mergeable !== null) poll.baseSha = pr.base.sha;
      }
      if (pr.mergeable === null) delete etags[prPath]; // GitHub computes it lazily: ask again next tick
    }
  } catch (e) {
    if (e instanceof GithubHttpError && e.status === 404) return { events: [], end: NOT_VISIBLE, poll: old };
    throw e;
  }

  // ---- reviews and comments (a baseline the first time: history is not replayed to the agent)
  const first = !old.baselined;
  const reviews = await get<GhReview[]>(`${base}/pulls/${sub.number}/reviews?per_page=100`);
  if (reviews.status === 200) {
    const list = reviews.json;
    if (first) {
      let review: Subscription["review"] = "none";
      for (const x of list) {
        const st = x.state.toLowerCase();
        if (st === "approved" || st === "changes_requested") review = st;
        else if (st === "commented" && review === "none") review = "commented";
      }
      baseline.review = review;
      poll.lastReviewId = Math.max(0, ...list.map((x) => x.id));
    } else {
      for (const x of list) {
        if (x.id <= (old.lastReviewId ?? 0)) continue;
        const st = x.state.toLowerCase();
        if (st === "approved" || st === "changes_requested" || st === "commented") events.push({ kind: "review", state: st, body: x.body ?? "", url: x.html_url, sender: actor(x.user) });
      }
      poll.lastReviewId = Math.max(old.lastReviewId ?? 0, ...list.map((x) => x.id));
    }
  }

  const since = first ? undefined : old.since;
  const q = `per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const issueComments = await get<GhComment[]>(`${base}/issues/${sub.number}/comments?${q}`);
  const reviewComments = await get<GhComment[]>(`${base}/pulls/${sub.number}/comments?${q}`);
  let newest = old.since;
  for (const [res, key, inline] of [[issueComments, "lastCommentId", false], [reviewComments, "lastReviewCommentId", true]] as const) {
    if (res.status !== 200) continue; // 304: nothing new in this list
    const last = old[key] ?? 0;
    if (!first) {
      for (const c of res.json) {
        if (c.id <= last) continue;
        events.push({ kind: "comment", body: c.body, url: c.html_url, ...(inline && c.path ? { path: c.path } : {}), sender: actor(c.user) });
        if (!newest || c.created_at > newest) newest = c.created_at;
      }
    }
    poll[key] = Math.max(last, ...res.json.map((c) => c.id));
  }
  if (first) {
    // Baselined only when the whole first read worked; otherwise the next tick starts it again.
    if (reviews.status === 200 && issueComments.status === 200 && reviewComments.status === 200) {
      poll.baselined = true;
      poll.since = new Date(app.now()).toISOString();
    }
  } else poll.since = newest;

  // ---- CI: every check suite of the current head
  if (head) {
    const suites = await get<GhSuites>(`${base}/commits/${head}/check-suites?per_page=100`);
    if (suites.status === 200) {
      const seen: Record<string, "pass" | "fail"> = old.checksSha === head ? { ...old.seen } : {};
      const real = suites.json.check_suites.filter((s) => s.latest_check_runs_count > 0); // a suite without runs has nothing to wait for
      for (const s of real) {
        if (s.status !== "completed") continue;
        const outcome = suiteOutcome(s.conclusion);
        if (outcome && seen[s.id] !== outcome) {
          events.push({ kind: "check_suite", suiteId: s.id, headSha: head, outcome });
          seen[s.id] = outcome;
        }
      }
      if (real.length && real.every((s) => s.status === "completed" && suiteOutcome(s.conclusion) !== "fail")) events.push({ kind: "ci_green", headSha: head });
      poll.checksSha = head;
      poll.seen = seen;
    } else if (old.checksSha !== head) {
      poll.checksSha = head;
      poll.seen = {};
    } else {
      poll.checksSha = old.checksSha;
      poll.seen = old.seen;
    }
  }
  return { events, baseline: Object.keys(baseline).length ? baseline : undefined, poll };
}

/** Applies what `observe` found in one transaction: baseline, end, events, poll state. */
export function applyObservation(app: App, subId: number, obs: Observation) {
  const settings = readSettings(app);
  const env = ingestEnv(app, settings.githubLogin, settings.commentPolicy);
  app.db.tx(() => {
    const sub = getSub(app, subId);
    if (!sub || sub.status === "ended") return;
    if (obs.baseline) updateSubscription(app, subId, obs.baseline);
    if (obs.end) return endSubscription(app, getSub(app, subId)!, obs.end);
    for (const e of obs.events) ingestEvent(app, subId, e, env);
    savePollState(app, subId, obs.poll);
  });
}

/** Learns whose token this is when settings could not at the time (GitHub was unreachable). */
async function ensureLogin(app: App, token: string) {
  if (readSettings(app).githubLogin) return;
  try {
    const r = await getCached<{ login?: string }>(app.fetch, token, "/user", undefined, app.now());
    if (r.status === 200 && typeof r.json.login === "string") update(app.db, "settings", { id: 1 }, { githubLogin: r.json.login });
  } catch {
    /* the next tick tries again */
  }
}

/** One pass over every subscription that needs watching. Returns when to look again, or null when nothing needs polling. */
export async function pollOnce(app: App): Promise<number | null> {
  const subs = pollable(app);
  if (!subs.length) return null;
  const token = await githubToken(app);
  if (!token) return POLL_MS * 2; // subscriptions wait for a token to be set
  await ensureLogin(app, token);
  for (const s of subs) {
    const sub = getSub(app, s.id);
    if (!sub || sub.status === "ended") continue;
    try {
      applyObservation(app, sub.id, await observe(app, token, sub));
    } catch (e) {
      if (e instanceof GithubHttpError) {
        if (e.retryAt !== undefined) return Math.max(e.retryAt - app.now(), 1_000); // rate limited: stop until it lifts
        if (e.status === 401) return POLL_AUTH_FAILED_MS; // the token is bad: nothing else will work either
      }
      console.error("poll failed", sub.repo, sub.number, e instanceof GithubHttpError ? e.status : "unexpected");
    }
  }
  return POLL_MS;
}
