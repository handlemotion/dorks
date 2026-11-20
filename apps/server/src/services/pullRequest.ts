import type { MergeableState, MergeMethod, PullRequestChecks, PullRequestComment, PullRequestFile, PullRequestPerson, PullRequestView } from "@dorks/shared";
import { fail, type App } from "../app";
import { validRepo } from "../lib/repo";
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

/** `owner/name` and the number from the session's PR URL, or `not_found` when it has none. */
export function prRef(app: App, dorkId: string): { repo: string; number: number } {
  const dork = owned(app, dorkId);
  const m = dork.prUrl && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(dork.prUrl);
  if (!m || !validRepo(m[1])) return fail("not_found", "This session has no pull request yet.");
  return { repo: m[1], number: Number(m[2]) };
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
export async function getPullRequest(app: App, dorkId: string): Promise<PullRequestView> {
  const { repo, number } = prRef(app, dorkId);
  const token = await tokenOf(app);
  const base = `/repos/${repo}`;
  const pr = obj(await get(app, token, `${base}/pulls/${number}`));
  const headSha = s(obj(pr.head).sha);
  // Comments, files and checks are best effort: a failure there should not hide the PR and its merge button.
  const soft = (path: string) => get(app, token, path).catch(() => null);
  const softAll = (path: string, pick?: (page: unknown) => unknown) => getAll(app, token, path, pick).catch((): Json[] => []);
  const [repoInfo, files, issueComments, reviews, reviewComments, runs, status] = await Promise.all([
    soft(base),
    softAll(`${base}/pulls/${number}/files`),
    softAll(`${base}/issues/${number}/comments`),
    softAll(`${base}/pulls/${number}/reviews`),
    softAll(`${base}/pulls/${number}/comments`),
    headSha ? softAll(`${base}/commits/${headSha}/check-runs`, (p) => obj(p).check_runs) : [],
    headSha ? soft(`${base}/commits/${headSha}/status?per_page=${PAGE}`) : null,
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
  };
}

/**
 * `POST /api/dorks/:id/pr/merge`: merges with `method`, pinned to `sha` (the head the owner looked at) so a push that lands in
 * between is not merged unseen. GitHub's reason for a refusal (conflicts, required checks or reviews, a moved head) is passed on.
 */
export async function mergePullRequest(app: App, dorkId: string, method: unknown, sha: unknown): Promise<{ merged: true; sha?: string }> {
  if (typeof method !== "string" || !MERGE_METHODS.includes(method as MergeMethod)) return fail("invalid", "method must be squash, merge or rebase");
  if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))) return fail("invalid", "sha must be a commit sha");
  const { repo, number } = prRef(app, dorkId);
  const token = await tokenOf(app);
  // GitHub answers a merge of an already merged PR with success, and checks `sha` only loosely: look first.
  const pr = obj(await get(app, token, `/repos/${repo}/pulls/${number}`));
  if (pr.merged === true || pr.merged_at) return fail("conflict", "This pull request is already merged.");
  if (pr.state === "closed") return fail("conflict", "This pull request is closed.");
  if (sha && s(obj(pr.head).sha) !== sha) return fail("conflict", "New commits landed on the branch. Look them over, then merge again.");
  const r = await call(app, token, "PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, ...(sha ? { sha } : {}) });
  const message = ghMessage(r.json);
  if (r.status === 200) {
    setTimer(app, "", "poll", 0); // the poller records the merge (and the transcript shows it) now, not in 30s
    const merged = obj(r.json).sha;
    return { merged: true, sha: typeof merged === "string" ? merged : undefined };
  }
  return mergeRefused(r.status, message);
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
export async function updatePullRequestBranch(app: App, dorkId: string, sha: unknown): Promise<void> {
  if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))) return fail("invalid", "sha must be a commit sha");
  const { repo, number } = prRef(app, dorkId);
  const token = await tokenOf(app);
  const r = await call(app, token, "PUT", `/repos/${repo}/pulls/${number}/update-branch`, sha ? { expected_head_sha: sha } : {});
  if (r.status === 202 || r.status === 200) return;
  const message = ghMessage(r.json);
  if (r.status === 422) return fail("conflict", message ?? "GitHub could not update the branch. It may have conflicts.");
  return fail("github_error", message ? `GitHub refused: ${message}` : `GitHub answered ${r.status}.`);
}
