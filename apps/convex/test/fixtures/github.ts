// GitHub webhook payloads, trimmed from real deliveries (docs.github.com "Webhook events and payloads"): the fields the ingress
// reads plus enough of the surrounding noise to prove the parser ignores it. Each builder takes overrides for the interesting bits.

export const REPO = "Octo/Hello"; // GitHub reports the canonical casing; subscriptions are stored lowercase
export const INSTALLATION = 4242;
export const SLUG = "dorks-test";

export type Sender = { login: string; type: "User" | "Bot" };
export const alice: Sender = { login: "alice", type: "User" };
export const mallory: Sender = { login: "mallory", type: "User" };
export const bot: Sender = { login: `${SLUG}[bot]`, type: "Bot" };
export const coderabbit: Sender = { login: "coderabbitai[bot]", type: "Bot" };

const user = (s: Sender) => ({ login: s.login, id: 583231, node_id: "MDQ6VXNlcjU4MzIzMQ==", avatar_url: `https://avatars.githubusercontent.com/u/583231?v=4`, type: s.type, site_admin: false });
const repository = (full = REPO) => ({ id: 1296269, node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5", name: full.split("/")[1], full_name: full, private: false, owner: user({ login: full.split("/")[0], type: "User" }), default_branch: "main" });
const envelope = (sender: Sender, installation: number | null = INSTALLATION, repo = REPO) => ({
  repository: repository(repo), sender: user(sender), ...(installation === null ? {} : { installation: { id: installation, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNDI0Mg==" } }),
});

interface Pr { number?: number; headSha?: string; headRef?: string; baseRef?: string; headRepo?: string; merged?: boolean; state?: "open" | "closed" }
const pullRequest = ({ number = 12, headSha = "c0ffee1", headRef = "agent/x", baseRef = "main", headRepo = REPO, merged = false, state = "open" }: Pr = {}) => ({
  url: `https://api.github.com/repos/${REPO}/pulls/${number}`, id: 279147437, number, state, locked: false, title: "Add thing", user: user(bot),
  body: "Adds the thing.", html_url: `https://github.com/${REPO}/pull/${number}`, draft: false, merged, mergeable: null, comments: 0,
  head: { label: `${headRepo.split("/")[0]}:${headRef}`, ref: headRef, sha: headSha, repo: repository(headRepo) },
  base: { label: `Octo:${baseRef}`, ref: baseRef, sha: "b4e5f6a7", repo: repository() },
});

export const pullRequestEvent = (action: "opened" | "closed" | "synchronize" | "edited" | "labeled", pr: Pr = {}, o: { sender?: Sender; installation?: number | null; changes?: object } = {}) => ({
  action, number: pr.number ?? 12, pull_request: pullRequest(pr), ...(o.changes ? { changes: o.changes } : {}), ...(action === "synchronize" ? { before: "9d8c7b6", after: pr.headSha ?? "c0ffee1" } : {}),
  ...envelope(o.sender ?? alice, o.installation),
});
export const baseChanged = (from: string, pr: Pr = {}, o: { sender?: Sender } = {}) => pullRequestEvent("edited", pr, { ...o, changes: { base: { ref: { from }, sha: { from: "0a1b2c3" } } } });

export const reviewEvent = (state: "approved" | "changes_requested" | "commented", o: { number?: number; body?: string | null; sender?: Sender; action?: string } = {}) => ({
  action: o.action ?? "submitted",
  review: { id: 80, node_id: "MDE3OlB1bGxSZXF1ZXN0UmV2aWV3ODA=", user: user(o.sender ?? alice), body: o.body === undefined ? "Please rename this." : o.body, commit_id: "c0ffee1", state, html_url: `https://github.com/${REPO}/pull/${o.number ?? 12}#pullrequestreview-80`, author_association: "COLLABORATOR" },
  pull_request: pullRequest({ number: o.number }), ...envelope(o.sender ?? alice),
});

export const reviewCommentEvent = (o: { number?: number; body?: string; path?: string; sender?: Sender; action?: string } = {}) => ({
  action: o.action ?? "created",
  comment: { id: 10, pull_request_review_id: 42, diff_hunk: "@@ -1,3 +1,3 @@", path: o.path ?? "src/a.ts", line: 7, user: user(o.sender ?? alice), body: o.body ?? "Why not a Map?", html_url: `https://github.com/${REPO}/pull/${o.number ?? 12}#discussion_r10`, author_association: "COLLABORATOR" },
  pull_request: pullRequest({ number: o.number }), ...envelope(o.sender ?? alice),
});

export const issueCommentEvent = (o: { number?: number; body?: string; sender?: Sender; onIssue?: boolean; action?: string } = {}) => ({
  action: o.action ?? "created",
  issue: { url: `https://api.github.com/repos/${REPO}/issues/${o.number ?? 12}`, number: o.number ?? 12, title: "Add thing", user: user(bot), state: "open", ...(o.onIssue ? {} : { pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${o.number ?? 12}`, html_url: `https://github.com/${REPO}/pull/${o.number ?? 12}` } }) },
  comment: { id: 20, user: user(o.sender ?? alice), body: o.body ?? "Could you also handle empty input?", html_url: `https://github.com/${REPO}/pull/${o.number ?? 12}#issuecomment-20`, author_association: "MEMBER" },
  ...envelope(o.sender ?? alice),
});

export const checkSuiteEvent = (conclusion: string | null, o: { id?: number; headSha?: string; headBranch?: string | null; sender?: Sender; action?: string } = {}) => ({
  action: o.action ?? "completed",
  check_suite: {
    id: o.id ?? 118578147, node_id: "MDEwOkNoZWNrU3VpdGUxMTg1NzgxNDc=", head_branch: o.headBranch === undefined ? "agent/x" : o.headBranch, head_sha: o.headSha ?? "c0ffee1",
    status: "completed", conclusion, url: `https://api.github.com/repos/${REPO}/check-suites/118578147`, before: "9d8c7b6", after: o.headSha ?? "c0ffee1", pull_requests: [],
    app: { id: 15368, slug: "github-actions", name: "GitHub Actions" }, latest_check_runs_count: 3,
  },
  ...envelope(o.sender ?? alice),
});

export const pushEvent = (branch: string, o: { sha?: string; sender?: Sender; deleted?: boolean; ref?: string } = {}) => ({
  ref: o.ref ?? `refs/heads/${branch}`, before: "0a1b2c3d", after: o.sha ?? "d00d1e2", created: false, deleted: o.deleted ?? false, forced: false,
  commits: [{ id: o.sha ?? "d00d1e2", message: "Fix things", author: { name: "Alice", username: "alice" } }], head_commit: { id: o.sha ?? "d00d1e2" },
  ...envelope(o.sender ?? alice),
});

export const installationEvent = { action: "created", installation: { id: INSTALLATION, account: user(alice), app_id: 1, app_slug: SLUG }, repositories: [{ id: 1, full_name: REPO }], sender: user(alice) };
export const pingEvent = { zen: "Keep it logically awesome.", hook_id: 1, hook: { type: "App", id: 1, active: true, events: ["push"] }, sender: user(alice) };
