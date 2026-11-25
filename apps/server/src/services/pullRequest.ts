import type { MergeableState, MergeMethod, PullRequestChecks, PullRequestComment, PullRequestFile, PullRequestPerson, PullRequestSection, PullRequestView } from "@dorks/shared";
import { fail, type App } from "../app";
import { normalizeRepo, validRepo } from "../lib/repo";
import { setTimer } from "../lifecycle/dispatch";
import { owned } from "./dorks";
import { githubToken } from "./settings";

// The session's pull request, read live from GitHub as the GitHub CLI's login (docs/github.md), and the actions Chat details takes
// on it: merge, and bring the branch up to date. Nothing here is stored; the poller (services/poller.ts) still owns the PR's
// lifecycle events, and is nudged after a merge so the transcript shows it at once.

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;
const PAGE = 100;
/** GitHub lists at most 3000 files for a PR; comments and checks rarely pass a few pages. */
const MAX_PAGES = 30;
const MAX_FAILING = 5;
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/**
 * `owner/name` and the number of one of the session's pull requests: `url` when given (a PR the session opened or follows: its
 * headline PR or any of its subscriptions, ended ones included), else its headline PR (the latest it opened). `not_found` otherwise,
 * so the endpoints cannot be pointed at an arbitrary PR.
 */
export function prRef(app: App, dorkId: string, url?: unknown): { repo: string; number: number } {
  const dork = owned(app, dorkId);
  if (url !== undefined && url !== null && url !== "" && typeof url !== "string") return fail("invalid", "url must be a pull request URL");
  const target = (url as string | undefined) || dork.prUrl;
  const m = target && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(target);
  if (!m || !validRepo(m[1])) return fail("not_found", url ? "Not a pull request URL." : "This session has no pull request yet.");
  const repo = normalizeRepo(m[1]);
  const number = Number(m[2]);
  if (target !== dork.prUrl && !app.db.get("SELECT 1 FROM pr_subscriptions WHERE dork_id = ? AND repo = ? AND number = ?", dorkId, repo, number)) {
    return fail("not_found", "This session does not follow that pull request.");
  }
  return { repo, number };
}

async function tokenOf(app: App): Promise<string> {
  const token = await githubToken(app);
  if (!token) return fail("not_configured", "Connect GitHub in Settings (the GitHub CLI's login) to see and merge pull requests.");
  return token;
}

type Json = Record<string, unknown>;

/** One GitHub call. Fails with GitHub's own short message (never the token, never the whole body). */
async function call(app: App, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await app.fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dorks",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return fail(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "github_error", "GitHub did not answer. Try again in a moment.");
  }
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

const ghMessage = (json: unknown) => {
  const m = json && typeof json === "object" ? (json as Json).message : undefined;
  return typeof m === "string" ? m.slice(0, 300) : undefined;
};

async function get(app: App, token: string, path: string): Promise<unknown> {
  const r = await call(app, token, "GET", path);
  // Not `not_found`: that means "this session has no PR", and the client would cache it as such.
  if (r.status === 404) return fail("github_error", "GitHub could not find this pull request, or the GitHub CLI's login cannot see it.");
  if (r.status === 401) return fail("github_error", "GitHub rejected the GitHub CLI's login. Run `gh auth login` again.");
  if (r.status === 403 || r.status === 429) return fail("rate_limited", ghMessage(r.json) ?? "GitHub refused the request.");
  if (r.status >= 300) return fail("github_error", `GitHub answered ${r.status}${ghMessage(r.json) ? `: ${ghMessage(r.json)}` : ""}`);
  return r.json;
}

/** Every page of a list read (`per_page=100` until a short page), up to `MAX_PAGES`; `pick` finds the list in a page. */
async function getAll(app: App, token: string, path: string, pick: (page: unknown) => unknown = (p) => p): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = arr(pick(await get(app, token, `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`)));
    out.push(...items);
    if (items.length < PAGE) break;
  }
  return out;
}

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const t = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};
const person = (v: unknown): PullRequestPerson => {
  const u = obj(v);
  return { login: s(u.login) || "ghost", avatarUrl: s(u.avatar_url) || undefined };
};

const MERGEABLE_STATES = new Set<MergeableState>(["clean", "unstable", "blocked", "behind", "dirty", "draft", "unknown", "has_hooks"]);

/** GitHub's file patch is only the hunks; Pierre's diff wants the `---`/`+++` header too. */
function filesOf(list: Json[]): PullRequestFile[] {
  return list.map((f) => {
    const path = s(f.filename);
    const previousPath = s(f.previous_filename) || undefined;
    const patch = s(f.patch);
    const from = f.status === "added" ? "/dev/null" : `a/${previousPath ?? path}`;
    const to = f.status === "removed" ? "/dev/null" : `b/${path}`;
    return {
      path,
      previousPath,
      status: s(f.status),
      additions: n(f.additions),
      deletions: n(f.deletions),
      patch: patch ? `--- ${from}\n+++ ${to}\n${patch}\n` : undefined,
    };
  });
}

/** A check run's outcome; null for cancelled or stale runs (superseded, they say nothing about the code). */
function runOutcome(r: Json): "pass" | "fail" | "pending" | null {
  if (r.status !== "completed") return "pending";
  if (["success", "neutral", "skipped"].includes(s(r.conclusion))) return "pass";
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(s(r.conclusion))) return "fail";
  return null;
}

/** Check runs (Actions and apps) and legacy commit statuses, folded into one count. */
function checksOf(runs: Json[], statuses: Json[]): PullRequestChecks {
  const c: PullRequestChecks = { total: 0, passed: 0, failed: 0, pending: 0, failing: [], runs: [] };
  const add = (outcome: "pass" | "fail" | "pending" | null, name: string, url?: string, summary?: string) => {
    if (!outcome) return;
    c.total++;
    c.runs.push({ name, outcome, url: url || undefined, summary: summary || undefined });
    if (outcome === "pass") c.passed++;
    else if (outcome === "pending") c.pending++;
    else {
      c.failed++;
      if (c.failing.length < MAX_FAILING) c.failing.push(name);
    }
  };
  for (const r of runs) add(runOutcome(r), s(r.name), s(r.html_url) || s(r.details_url), s(obj(r.output).title));
  // The combined status lists each context's latest state.
  for (const st of statuses) add(st.state === "success" ? "pass" : st.state === "pending" ? "pending" : "fail", s(st.context), s(st.target_url), s(st.description));
  const order = { fail: 0, pending: 1, pass: 2 };
  c.runs.sort((a, b) => order[a.outcome] - order[b.outcome] || a.name.localeCompare(b.name));
  return c;
}

function commentsOf(issueComments: Json[], reviews: Json[], reviewComments: Json[]): PullRequestComment[] {
  const out: PullRequestComment[] = [];
  for (const c of issueComments) out.push({ id: `c${n(c.id)}`, kind: "comment", author: person(c.user), body: s(c.body), url: s(c.html_url), createdAt: t(c.created_at) ?? 0 });
  for (const r of reviews) {
    // A bare "commented" review is only the wrapper of inline comments, which are listed on their own.
    if (r.state === "PENDING" || (r.state === "COMMENTED" && !s(r.body).trim())) continue;
    out.push({ id: `r${n(r.id)}`, kind: "review", author: person(r.user), body: s(r.body), url: s(r.html_url), createdAt: t(r.submitted_at) ?? 0, reviewState: s(r.state) });
  }
  for (const c of reviewComments)
    out.push({
      id: `l${n(c.id)}`,
      kind: "review_comment",
      author: person(c.user),
      body: s(c.body),
      url: s(c.html_url),
      createdAt: t(c.created_at) ?? 0,
      path: s(c.path) || undefined,
      line: typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : undefined,
    });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** `GET /api/dorks/:id/pr`: everything Chat details shows about the session's pull request, in one round of parallel reads. */
export async function getPullRequest(app: App, dorkId: string, url?: unknown): Promise<PullRequestView> {
  const { repo, number } = prRef(app, dorkId, url);
  const token = await tokenOf(app);
  const base = `/repos/${repo}`;
  const pr = obj(await get(app, token, `${base}/pulls/${number}`));
  const headSha = s(obj(pr.head).sha);
  // Comments, files and checks are best effort: a failure there should not hide the PR and its merge button.
  // A failed section is reported as unavailable, so the panel does not show it as empty.
  const unavailable = new Set<PullRequestSection>();
  const soft = (path: string, section?: PullRequestSection) =>
    get(app, token, path).catch(() => {
      if (section) unavailable.add(section);
      return null;
    });
  const softAll = (path: string, section: PullRequestSection, pick?: (page: unknown) => unknown) =>
    getAll(app, token, path, pick).catch((): Json[] => {
      unavailable.add(section);
      return [];
    });
  const [repoInfo, files, issueComments, reviews, reviewComments, runs, status] = await Promise.all([
    soft(base),
    softAll(`${base}/pulls/${number}/files`, "files"),
    softAll(`${base}/issues/${number}/comments`, "comments"),
    softAll(`${base}/pulls/${number}/reviews`, "comments"),
    softAll(`${base}/pulls/${number}/comments`, "comments"),
    headSha ? softAll(`${base}/commits/${headSha}/check-runs`, "checks", (p) => obj(p).check_runs) : [],
    headSha ? soft(`${base}/commits/${headSha}/status?per_page=${PAGE}`, "checks") : null,
  ]);
  const r = obj(repoInfo);
  const allowed = { squash: r.allow_squash_merge, merge: r.allow_merge_commit, rebase: r.allow_rebase_merge };
  // Without the repository's settings (no admin read), offer all three; GitHub refuses a disallowed one with a clear message.
  const mergeMethods = MERGE_METHODS.filter((m) => repoInfo === null || allowed[m] !== false);
  const merged = pr.merged === true || Boolean(pr.merged_at);
  const state = s(pr.mergeable_state) as MergeableState;
  return {
    repo,
    number,
    url: s(pr.html_url) || `https://github.com/${repo}/pull/${number}`,
    title: s(pr.title),
    body: s(pr.body),
    state: merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    draft: pr.draft === true,
    author: person(pr.user),
    headRef: s(obj(pr.head).ref),
    baseRef: s(obj(pr.base).ref),
    headSha,
    createdAt: t(pr.created_at) ?? 0,
    mergedAt: t(pr.merged_at),
    closedAt: t(pr.closed_at),
    mergedBy: pr.merged_by ? person(pr.merged_by) : undefined,
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    mergeableState: MERGEABLE_STATES.has(state) ? state : "unknown",
    additions: n(pr.additions),
    deletions: n(pr.deletions),
    changedFiles: n(pr.changed_files),
    checks: checksOf(runs, arr(obj(status).statuses)),
    mergeMethods: mergeMethods.length ? mergeMethods : [...MERGE_METHODS],
    files: filesOf(files),
    comments: commentsOf(issueComments, reviews, reviewComments),
    ...(unavailable.size ? { unavailable: [...unavailable] } : {}),
  };
}

/** What a merge request came to: merged, or handed to GitHub (a merge queue, a stack still merging) for the poller to see land. */
export type MergeResult = { merged: true; sha?: string } | { merged: false; queued: true };

/**
 * `POST /api/dorks/:id/pr/merge`: merges with `method`, pinned to `sha` (the head the owner looked at) so a push that lands in
 * between is not merged unseen. GitHub's reason for a refusal (conflicts, required checks or reviews, a moved head) is passed on.
 * A stacked PR (GitHub's native stacks) goes through the asynchronous merge, which also merges every open PR below it: merging the
 * top of a stack merges the whole stack in one go.
 */
export async function mergePullRequest(app: App, dorkId: string, method: unknown, sha: unknown, url?: unknown): Promise<MergeResult> {
  if (typeof method !== "string" || !MERGE_METHODS.includes(method as MergeMethod)) return fail("invalid", "method must be squash, merge or rebase");
  if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))) return fail("invalid", "sha must be a commit sha");
  const { repo, number } = prRef(app, dorkId, url);
  const token = await tokenOf(app);
  // GitHub answers a merge of an already merged PR with success, and checks `sha` only loosely: look first.
  const pr = obj(await get(app, token, `/repos/${repo}/pulls/${number}`));
  if (pr.merged === true || pr.merged_at) return fail("conflict", "This pull request is already merged.");
  if (pr.state === "closed") return fail("conflict", "This pull request is closed.");
  if (sha && s(obj(pr.head).sha) !== sha) return fail("conflict", "New commits landed on the branch. Look them over, then merge again.");
  if (pr.stack) return mergeAsync(app, token, repo, number, method as MergeMethod, sha as string | undefined);
  const r = await call(app, token, "PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, ...(sha ? { sha } : {}) });
  const message = ghMessage(r.json);
  if (r.status === 200) {
    setTimer(app, "", "poll", 0); // the poller records the merge (and the transcript shows it) now, not at the next tick
    const merged = obj(r.json).sha;
    return { merged: true, sha: typeof merged === "string" ? merged : undefined };
  }
  // A stack GitHub did not mark on the PR object: the synchronous endpoint names the asynchronous one.
  if (r.status === 403 && /stacked/i.test(message ?? "")) return mergeAsync(app, token, repo, number, method as MergeMethod, sha as string | undefined);
  return mergeRefused(r.status, message);
}

const ASYNC_POLL_MS = 1_000;
const ASYNC_WAIT_MS = 30_000;

/**
 * GitHub's asynchronous merge (`PUT …/merge-async`, the one stacked PRs require): it answers with a request id at once and merges
 * in the background, so wait for the outcome, a while: merged, or failed with GitHub's reason. A 200 is a settled answer (already
 * merged, or already in a merge queue) read like any other. A merge queue, or a stack still
 * merging when the wait runs out, is reported as queued; the poller records the merge when it lands.
 */
async function mergeAsync(app: App, token: string, repo: string, number: number, method: MergeMethod, sha?: string): Promise<MergeResult> {
  const r = await call(app, token, "PUT", `/repos/${repo}/pulls/${number}/merge-async`, { merge_method: method, ...(sha ? { sha } : {}) });
  setTimer(app, "", "poll", 0);
  if (r.status !== 200 && r.status !== 202 && r.status !== 409) {
    const message = asyncMessage(r.json) ?? ghMessage(r.json);
    if (r.status === 400) return fail("conflict", message ?? "GitHub says this pull request cannot be merged yet.");
    return mergeRefused(r.status, message);
  }
  const uuid = s(obj(obj(r.json).details).uuid);
  let result = obj(r.json);
  for (const deadline = Date.now() + ASYNC_WAIT_MS; uuid && s(result.status) === "pending" && Date.now() < deadline;) {
    await new Promise((done) => setTimeout(done, ASYNC_POLL_MS));
    const poll = await call(app, token, "GET", `/repos/${repo}/pulls/${number}/merge-async/${encodeURIComponent(uuid)}`);
    if (poll.status !== 200) break;
    result = obj(poll.json);
  }
  const status = s(result.status) || (r.status === 200 ? "merged" : "");
  if (status === "merged") {
    setTimer(app, "", "poll", 0);
    const merged = s(obj(result.details).sha);
    return { merged: true, sha: merged || undefined };
  }
  if (status === "failed") return fail("conflict", asyncMessage(result) ? `GitHub could not merge: ${asyncMessage(result)}` : "GitHub could not merge this pull request.");
  return { merged: false, queued: true };
}

/** The message an asynchronous merge result carries, in `details`. */
function asyncMessage(json: unknown): string | undefined {
  const m = obj(obj(json).details).message;
  return typeof m === "string" && m ? m : undefined;
}

/** Why GitHub refused a merge, as the owner should read it. */
function mergeRefused(status: number, message: string | undefined): never {
  if (status === 409) return fail("conflict", "New commits landed on the branch. Look them over, then merge again.");
  if (status === 405) return fail("conflict", message ?? "GitHub says this pull request cannot be merged yet.");
  if (status === 401) return fail("github_error", "GitHub rejected the GitHub CLI's login. Run `gh auth login` again.");
  if (status === 403 || status === 404) return fail("github_error", message ? `GitHub refused the merge: ${message}` : "The GitHub CLI's login cannot merge into this repository.");
  return fail("github_error", message ? `GitHub refused the merge: ${message}` : `GitHub answered ${status}.`);
}

/** `POST /api/dorks/:id/pr/update-branch`: merges the base branch into the PR's branch (GitHub's "Update branch"). */
export async function updatePullRequestBranch(app: App, dorkId: string, sha: unknown, url?: unknown): Promise<void> {
  if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))) return fail("invalid", "sha must be a commit sha");
  const { repo, number } = prRef(app, dorkId, url);
  const token = await tokenOf(app);
  const r = await call(app, token, "PUT", `/repos/${repo}/pulls/${number}/update-branch`, sha ? { expected_head_sha: sha } : {});
  if (r.status === 202 || r.status === 200) return;
  const message = ghMessage(r.json);
  if (r.status === 422) return fail("conflict", message ?? "GitHub could not update the branch. It may have conflicts.");
  return fail("github_error", message ? `GitHub refused: ${message}` : `GitHub answered ${r.status}.`);
}
