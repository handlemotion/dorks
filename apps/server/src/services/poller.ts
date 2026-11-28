import { Effect } from "effect";
import type { App } from "../app";
import {
  getCached,
  GhBranch,
  GhComments,
  GhCompare,
  GhIssue,
  GhIssueEvents,
  GhPr,
  GhPrList,
  GhReviews,
  GhSuites,
  GhViewer,
  GithubError,
  suiteOutcome,
  type Cached,
  type GhComment,
  type GhReview,
  type GhUser,
  type GithubClient,
} from "../lib/github";
import { githubToken, readSettings } from "./settings";
import { update } from "../db";
import { ingestEnv, ingestEvent, type Actor, type PrEvent } from "./githubIngest";
import { applyShip, getShip, observeShip, openShips, shipDue, type Ship } from "./ships";
import { enqueueNotification } from "./notify";
import { endedOpen, endSubscription, getSub, mergedBranches, pollable, savePollState, updateSubscription, type PollState, type Subscription } from "./subscriptions";
import { append } from "../lifecycle/dispatch";

// PR autonomy without webhooks: read each subscribed PR with conditional requests (a 304 is free against the rate limit), turn
// what changed into the PR events services/githubIngest.ts applies. The reads are Effects failing with `GithubError`; the
// writes are one transaction per subscription.

// 10 s: a CI failure or a conflict reaches the agent within seconds. Unchanged reads are 304s, free against the rate limit.
export const POLL_MS = 10_000;
export const POLL_AUTH_FAILED_MS = 5 * 60_000;
/** A PR whose watch ended while it was open (`endedOpen`) is read this often, for its state alone. */
export const ENDED_STATE_MS = 60_000;
/** A merged PR's branch is read this often while it is watched for late pushes (`pollMergedBranch`). */
export const MERGED_BRANCH_MS = 30_000;
const NOT_VISIBLE = "PR not found or not accessible to your GitHub token";

const actor = (u: GhUser | null | undefined): Actor => ({ login: u?.login ?? "ghost", bot: u?.type === "Bot" });
const time = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : undefined);

export interface Observation {
  events: PrEvent[];
  /** Applied before the events: first-time hydration and the review baseline. */
  baseline?: Partial<Omit<Subscription, "id" | "dorkId" | "repo" | "number">>;
  /** Why the subscription must end (the PR is not visible, or already closed). */
  end?: string;
  poll: PollState;
}

/** One `observe` call: what was there before, and what this read has found so far. */
interface Look {
  app: App;
  gh: GithubClient;
  sub: Subscription;
  old: PollState;
  poll: PollState;
  etags: Record<string, string>;
  events: PrEvent[];
  baseline: NonNullable<Observation["baseline"]>;
  /** `/repos/:owner/:name` */
  base: string;
  /** Conditional GET: keeps a path's ETag for the next tick when it is still good. */
  get: <S extends Parameters<typeof getCached>[1]>(schema: S, path: string) => Effect.Effect<Cached<S["Type"]>, GithubError>;
}

const clientOf = (app: App, token: string): GithubClient => ({ fetch: app.fetch, token, now: () => app.now() });

/** Reads GitHub for one subscription. Fails with `GithubError` for failures other than a missing PR. */
export const observe = (app: App, token: string, sub: Subscription): Effect.Effect<Observation, GithubError> =>
  Effect.gen(function* () {
    const gh = clientOf(app, token);
    const old = sub.poll ?? {};
    const etags: Record<string, string> = {};
    const get: Look["get"] = (schema, path) =>
      getCached(gh, schema, path, old.etags?.[path]).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            if (r.status === 200 && r.etag) etags[path] = r.etag;
            else if (r.status === 304 && old.etags?.[path]) etags[path] = old.etags[path];
          }),
        ),
      );
    const look: Look = { app, gh, sub, old, poll: { ...old, etags }, etags, events: [], baseline: {}, base: `/repos/${sub.repo}`, get };

    const pr = yield* observePr(look).pipe(
      Effect.catchIf(
        (e) => e.reason === "not_visible",
        () => Effect.succeed({ done: { events: [], end: NOT_VISIBLE, poll: old } satisfies Observation }),
      ),
    );
    if (pr.done) return pr.done;

    yield* observeReviewsAndComments(look);
    if (pr.head) yield* observeChecks(look, pr.head);
    const { events, baseline, poll } = look;
    return { events, baseline: Object.keys(baseline).length ? baseline : undefined, poll };
  });

// ---- the PR itself
type PrLook = { head: string | undefined; done?: undefined } | { done: Observation };

/** The PR's head to read CI for, or the whole observation when the PR is closed. */
const observePr = (look: Look): Effect.Effect<PrLook, GithubError> =>
  Effect.gen(function* () {
    const { sub, events, baseline, poll } = look;
    const prPath = `${look.base}/pulls/${sub.number}`;
    const r = yield* look.get(GhPr, prPath);
    if (r.status !== 200) return { head: sub.headSha };
    const pr = r.json;
    const state = pr.merged ? "merged" : pr.state;
    if (!sub.title) {
      // First look: fill the subscription in. Not an event.
      Object.assign(baseline, { title: pr.title, headRef: pr.head.ref, headSha: pr.head.sha, baseRef: pr.base.ref, state, mergeable: pr.mergeable });
      poll.baseSha = pr.base.sha;
      if (state !== "open") return { done: { events, baseline, end: state, poll } };
      // A PR that already conflicts when subscribed (a branch cut from an old base) is news, unlike history: say so now.
      if (pr.mergeable === false) events.push({ kind: "mergeable", baseSha: pr.base.sha, mergeable: false });
    } else if (state !== "open") {
      // merged_by is null for a plain close; only the issue endpoint says who closed it (one extra read, once per PR). A failed read names nobody.
      const by =
        state === "merged"
          ? pr.merged_by
          : yield* getCached(look.gh, GhIssue, `${look.base}/issues/${sub.number}`).pipe(
              Effect.map((i) => (i.status === 200 ? i.json.closed_by : null)),
              Effect.orElseSucceed(() => null),
            );
      events.push({
        kind: "pr_closed",
        merged: state === "merged",
        sender: actor(by),
        // Only a merge into the default branch ships: a stacked PR merging into its parent's branch is not a release.
        ...(state === "merged" && pr.merge_commit_sha && (!pr.base.repo?.default_branch || pr.base.ref === pr.base.repo.default_branch)
          ? { mergeSha: pr.merge_commit_sha, mergedAt: time(pr.merged_at) }
          : {}),
      });
      // Watch the branch for a while: a push to it now reaches no PR (`pollMergedBranch`). A fork's branch is not ours to read.
      if (state === "merged" && (pr.head.repo?.full_name ?? sub.repo).toLowerCase() === sub.repo.toLowerCase())
        poll.merged = { at: time(pr.merged_at) ?? look.app.now(), headRef: pr.head.ref, headSha: pr.head.sha };
      return { done: { events, baseline, poll } };
    } else {
      yield* observePrChanges(look, pr);
    }
    if (pr.mergeable === null) delete look.etags[prPath]; // GitHub computes it lazily: ask again next tick
    return { head: pr.head.sha };
  });

/** An open PR seen before: new commits, a new base, a mergeability answer. */
const observePrChanges = (look: Look, pr: GhPr) =>
  Effect.gen(function* () {
    const { sub, old, events, poll } = look;
    if (pr.head.sha !== sub.headSha) events.push({ kind: "pr_synchronize", headSha: pr.head.sha, headRef: pr.head.ref });
    if (pr.base.ref !== sub.baseRef) events.push(yield* baseChanged(look, pr.base.ref));
    if (pr.mergeable !== null && (pr.mergeable !== sub.mergeable || pr.base.sha !== old.baseSha)) events.push({ kind: "mergeable", baseSha: pr.base.sha, mergeable: pr.mergeable });
    if (pr.mergeable !== null) poll.baseSha = pr.base.sha;
  });

/**
 * Only the issue's events say who retargeted it, and when: one read, only when the base moved. Newest last. A full page may not
 * reach the newest event, so then nobody is named rather than whoever retargeted it long ago. A failed read names nobody.
 */
const baseChanged = ({ gh, sub, base }: Look, baseRef: string): Effect.Effect<PrEvent> =>
  getCached(gh, GhIssueEvents, `${base}/issues/${sub.number}/events?per_page=100`).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((changed) => {
      const page = changed?.status === 200 && changed.json.length < 100 ? changed.json : [];
      const ev = page.filter((e) => e.event === "base_ref_changed").at(-1);
      return { kind: "pr_base_changed", baseRef, from: sub.baseRef ?? "", ...(ev?.actor ? { sender: actor(ev.actor), at: time(ev.created_at) } : {}) };
    }),
  );

// ---- reviews and comments (a baseline the first time: history is not replayed to the agent)
const observeReviewsAndComments = (look: Look) =>
  Effect.gen(function* () {
    const { app, sub, old, poll, base } = look;
    const first = !old.baselined;
    const reviews = yield* look.get(GhReviews, `${base}/pulls/${sub.number}/reviews?per_page=100`);
    if (reviews.status === 200) {
      if (first) baselineReviews(look, reviews.json);
      else newReviews(look, reviews.json);
    }

    const since = first ? undefined : old.since;
    const q = `per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const issueComments = yield* look.get(GhComments, `${base}/issues/${sub.number}/comments?${q}`);
    const reviewComments = yield* look.get(GhComments, `${base}/pulls/${sub.number}/comments?${q}`);
    let newest = old.since;
    for (const [res, key, inline] of [
      [issueComments, "lastCommentId", false],
      [reviewComments, "lastReviewCommentId", true],
    ] as const) {
      if (res.status !== 200) continue; // 304: nothing new in this list
      const last = old[key] ?? 0;
      if (!first) newest = newComments(look, res.json, last, inline, newest);
      poll[key] = Math.max(last, ...res.json.map((c) => c.id));
    }
    if (!first) poll.since = newest;
    // Baselined only when the whole first read worked; otherwise the next tick starts it again.
    else if (reviews.status === 200 && issueComments.status === 200 && reviewComments.status === 200) {
      poll.baselined = true;
      poll.since = new Date(app.now()).toISOString();
    }
  });

function baselineReviews({ baseline, poll }: Look, list: readonly GhReview[]) {
  let review: Subscription["review"] = "none";
  for (const x of list) {
    const st = x.state.toLowerCase();
    if (st === "approved" || st === "changes_requested") review = st;
    else if (st === "commented" && review === "none") review = "commented";
  }
  baseline.review = review;
  poll.lastReviewId = Math.max(0, ...list.map((x) => x.id));
}

function newReviews({ old, poll, events }: Look, list: readonly GhReview[]) {
  for (const x of list) {
    if (x.id <= (old.lastReviewId ?? 0)) continue;
    const st = x.state.toLowerCase();
    if (st === "approved" || st === "changes_requested" || st === "commented")
      events.push({ kind: "review", state: st, body: x.body ?? "", url: x.html_url, sender: actor(x.user), at: time(x.submitted_at) });
  }
  poll.lastReviewId = Math.max(old.lastReviewId ?? 0, ...list.map((x) => x.id));
}

/** Emits the comments newer than `last`; returns the newest comment time seen so far. */
function newComments({ events }: Look, list: readonly GhComment[], last: number, inline: boolean, newest: string | undefined): string | undefined {
  for (const c of list) {
    if (c.id <= last) continue;
    events.push({ kind: "comment", body: c.body ?? "", url: c.html_url, ...(inline && c.path ? { path: c.path } : {}), sender: actor(c.user), at: time(c.created_at) });
    if (!newest || c.created_at > newest) newest = c.created_at;
  }
  return newest;
}

// ---- CI: every check suite of the current head
const observeChecks = ({ old, poll, events, base, get }: Look, head: string) =>
  Effect.gen(function* () {
    const suites = yield* get(GhSuites, `${base}/commits/${head}/check-suites?per_page=100`);
    if (suites.status !== 200) {
      const same = old.checksSha === head;
      poll.checksSha = head;
      poll.seen = same ? old.seen : {};
      return;
    }
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
  });

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

/**
 * Learns whose token this is when settings could not at the time (GitHub was unreachable). A failure waits for the next tick. The
 * automation watcher uses it too: the login's own comments are the agent's.
 */
export const ensureLogin = (app: App, token: string) =>
  readSettings(app).githubLogin
    ? Effect.void
    : getCached(clientOf(app, token), GhViewer, "/user").pipe(
        Effect.tap((r) => Effect.sync(() => r.status === 200 && update(app.db, "settings", { id: 1 }, { githubLogin: r.json.login }))),
        Effect.ignore,
      );

/** When a failed read means stopping the whole pass: rate limited until it lifts, or a bad token. `undefined`: go on. */
function stopFor(app: App, sub: Pick<Subscription, "repo" | "number">, e: GithubError): number | undefined {
  if (e.retryAt !== undefined) return Math.max(e.retryAt - app.now(), 1_000); // rate limited: stop until it lifts
  if (e.status === 401) return POLL_AUTH_FAILED_MS; // the token is bad: nothing else will work either
  console.error("poll failed", sub.repo, sub.number, e.status ?? e.reason);
  return undefined;
}

/** Observes and applies one subscription. A bug in either is logged and the pass goes on to the next one. */
const pollSub = (app: App, token: string, sub: Subscription): Effect.Effect<number | undefined> =>
  observe(app, token, sub).pipe(
    Effect.flatMap((obs) => Effect.sync(() => applyObservation(app, sub.id, obs))),
    Effect.as(undefined),
    Effect.catch((e) => Effect.sync(() => stopFor(app, sub, e))),
    Effect.catchDefect(() =>
      Effect.sync(() => {
        console.error("poll failed", sub.repo, sub.number, "unexpected");
        return undefined;
      }),
    ),
  );

/** Observes and applies one ship (services/ships.ts), like `pollSub`. */
const pollShip = (app: App, token: string, ship: Ship): Effect.Effect<number | undefined> =>
  observeShip(app, token, ship).pipe(
    Effect.flatMap((obs) => Effect.sync(() => applyShip(app, ship.id, obs))),
    Effect.as(undefined),
    Effect.catch((e) => Effect.sync(() => stopFor(app, { repo: ship.repo, number: ship.number }, e))),
    Effect.catchDefect(() =>
      Effect.sync(() => {
        console.error("ship poll failed", ship.repo, ship.number, "unexpected");
        return undefined;
      }),
    ),
  );

/** When each ended-but-open PR was last read, with its ETag. In memory: after a restart each is read once more, which is cheap. */
const endedReads = new WeakMap<App, Map<number, { at: number; etag?: string }>>();

/**
 * Reads the state of a PR whose watch ended while it was open, at most every `ENDED_STATE_MS`. A close or merge only updates the
 * subscription's state (the sidebar's colour) and, for a merge, says so in the transcript: nothing reaches the agent.
 */
const pollEndedState = (app: App, token: string, sub: Subscription): Effect.Effect<number | undefined> => {
  let reads = endedReads.get(app);
  if (!reads) endedReads.set(app, (reads = new Map()));
  const last = reads.get(sub.id);
  if (last && app.now() - last.at < ENDED_STATE_MS) return Effect.succeed(undefined);
  return getCached(clientOf(app, token), GhPr, `/repos/${sub.repo}/pulls/${sub.number}`, last?.etag).pipe(
    Effect.map((r) => {
      reads.set(sub.id, { at: app.now(), etag: r.status === 200 ? r.etag : last?.etag });
      if (r.status !== 200) return undefined;
      const state = r.json.merged ? "merged" : r.json.state;
      if (state === "open") return undefined;
      app.db.tx(() => {
        const cur = getSub(app, sub.id);
        if (cur?.status !== "ended" || cur.state !== "open") return;
        updateSubscription(app, sub.id, { state });
        if (state === "merged") append(app, sub.dorkId, { type: "pr_merged", url: sub.url, number: sub.number });
      });
      return undefined;
    }),
    Effect.catch((e) =>
      Effect.sync(() => {
        // Gone or no longer visible: stop asking (until a restart). A rate limit (a 403 with `retryAt`) and anything else are tried
        // again next time.
        const gone = e.retryAt === undefined && (e.status === 404 || e.status === 403);
        reads.set(sub.id, { at: gone ? Number.MAX_SAFE_INTEGER : app.now(), etag: last?.etag });
        return stopFor(app, sub, e);
      }),
    ),
    Effect.catchDefect(() =>
      Effect.sync(() => {
        console.error("poll failed", sub.repo, sub.number, "unexpected");
        return undefined;
      }),
    ),
  );
};

/**
 * When each merged PR's branch was last read, with its ETag and the head it showed. `covered`: that head was a late push an open PR
 * covered, so it is asked about again on every read (a 304 says the branch did not move, not that the PR is still open). In memory.
 */
const branchReads = new WeakMap<App, Map<number, { at: number; etag?: string; sha?: string; covered?: boolean }>>();

/**
 * What a merged PR's branch, now at `sha`, is: `late` (commits on top of the merged head, in no PR: warn), `covered` (on top, but a
 * new open PR comes from the branch: ask again later, that PR may close unmerged) or `fine` (recreated from the base, rewritten).
 */
const latePush = (gh: GithubClient, sub: Subscription, merged: NonNullable<PollState["merged"]>, sha: string): Effect.Effect<"late" | "covered" | "fine", GithubError> =>
  Effect.gen(function* () {
    // A branch recreated from the base (or rewritten) is not the merged work plus more: only "ahead" is.
    const cmp = yield* getCached(gh, GhCompare, `/repos/${sub.repo}/compare/${merged.headSha}...${sha}`);
    if (cmp.status !== 200 || cmp.json.status !== "ahead") return "fine";
    // Already on its way in through a new PR from the same branch: nothing is lost.
    const owner = sub.repo.split("/")[0]!;
    const open = yield* getCached(gh, GhPrList, `/repos/${sub.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${merged.headRef}`)}&per_page=5`);
    if (open.status !== 200) return "fine";
    return open.json.length ? "covered" : "late";
  });

/**
 * Detects commits pushed on top of a merged PR's branch after the merge (a push the bridge's guard did not see): they are in no PR and
 * never reach the base. Tells the agent once (`pushed_after_merge`), so it moves them to a new PR. A deleted branch, one recreated
 * from the base, or one with a new open PR is fine: nothing to say.
 */
const pollMergedBranch = (app: App, token: string, sub: Subscription): Effect.Effect<number | undefined> => {
  const merged = sub.poll?.merged;
  if (!merged) return Effect.succeed(undefined);
  let reads = branchReads.get(app);
  if (!reads) branchReads.set(app, (reads = new Map()));
  const last = reads.get(sub.id);
  if (last && app.now() - last.at < MERGED_BRANCH_MS) return Effect.succeed(undefined);
  const gh = clientOf(app, token);
  const path = `/repos/${sub.repo}/branches/${encodeURIComponent(merged.headRef)}`;
  return Effect.gen(function* () {
    const r = yield* getCached(gh, GhBranch, path, last?.etag);
    const sha = r.status === 200 ? r.json.commit.sha : last?.sha;
    const etag = r.status === 200 ? r.etag : last?.etag;
    reads.set(sub.id, { at: app.now(), etag, sha });
    if (!sha || sha === merged.headSha || (r.status !== 200 && !last?.covered)) return undefined;
    const verdict = yield* latePush(gh, sub, merged, sha);
    if (verdict === "covered") reads.set(sub.id, { at: app.now(), etag, sha, covered: true });
    if (verdict !== "late") return undefined;
    app.db.tx(() => {
      const cur = getSub(app, sub.id);
      if (!cur?.poll?.merged || cur.poll.merged.warned) return;
      savePollState(app, sub.id, { ...cur.poll, merged: { ...cur.poll.merged, warned: sha } });
      enqueueNotification(
        app,
        sub.dorkId,
        sub.id,
        "pushed_after_merge",
        `${merged.headRef} is now at ${sha.slice(0, 7)}, pushed after this PR merged (its head was ${merged.headSha.slice(0, 7)}). Those commits are in no PR and will not reach ${sub.baseRef ?? "the base branch"}.`,
      );
    });
    return undefined;
  }).pipe(
    Effect.catch((e) =>
      Effect.sync(() => {
        reads.set(sub.id, { at: app.now(), etag: last?.etag });
        return e.reason === "not_visible" ? undefined : stopFor(app, sub, e); // 404: the branch was deleted at the merge
      }),
    ),
    Effect.catchDefect(() =>
      Effect.sync(() => {
        console.error("merged branch poll failed", sub.repo, sub.number, "unexpected");
        return undefined;
      }),
    ),
  );
};

/** Polls each item in order; the first that says to stop the whole pass (a rate limit, a bad token) ends it with its delay. */
const firstStop = <T>(items: readonly T[], poll: (x: T) => Effect.Effect<number | undefined>): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    for (const x of items) {
      const stop = yield* poll(x);
      if (stop !== undefined) return stop;
    }
    return undefined;
  });

/** One pass over every subscription and ship that needs watching. Answers when to look again, or null when nothing needs polling. */
export const pollOnceEffect = (app: App): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const subs = pollable(app);
    const ships = openShips(app);
    const ended = endedOpen(app);
    const merged = mergedBranches(app);
    if (!subs.length && !ships.length && !ended.length && !merged.length) return null;
    const token = yield* Effect.promise(() => githubToken(app));
    if (!token) return POLL_MS * 2; // subscriptions wait for a token to be set
    yield* ensureLogin(app, token);
    const stop =
      (yield* firstStop(subs, (s) => {
        const sub = getSub(app, s.id);
        return !sub || sub.status === "ended" ? Effect.succeed(undefined) : pollSub(app, token, sub);
      })) ??
      (yield* firstStop(ships, (s) => {
        const ship = getShip(app, s.id);
        return !ship || ship.endedAt !== undefined || !shipDue(ship, app.now()) ? Effect.succeed(undefined) : pollShip(app, token, ship);
      })) ??
      (yield* firstStop(ended, (sub) => pollEndedState(app, token, sub))) ??
      (yield* firstStop(merged, (sub) => pollMergedBranch(app, token, sub)));
    if (stop !== undefined) return stop;
    return subs.length || ships.length ? POLL_MS : merged.length ? MERGED_BRANCH_MS : ENDED_STATE_MS;
  });

/** The Promise form, for the poll job (lifecycle/jobs.ts). */
export const pollOnce = (app: App): Promise<number | null> => Effect.runPromise(pollOnceEffect(app));
