import { v, type Infer } from "convex/values";
import { z } from "zod";

// Pure parsing of GitHub App webhook deliveries (docs/autonomy.md). Each raw schema names only the fields we read; everything
// else in GitHub's (large) payloads is dropped. The result is a small normalized `GithubEvent`, which is also what the ingest
// mutation takes as its argument, so the Convex validator below is the single definition of that shape.

const actor = v.object({ login: v.string(), bot: v.boolean() });
const base = { installationId: v.number(), repo: v.string(), sender: actor };

export const githubEvent = v.union(
  v.object({ ...base, kind: v.literal("pr_closed"), number: v.number(), merged: v.boolean() }),
  v.object({ ...base, kind: v.literal("pr_synchronize"), number: v.number(), headSha: v.string(), headRef: v.string() }),
  v.object({ ...base, kind: v.literal("pr_base_changed"), number: v.number(), baseRef: v.string(), from: v.string() }),
  v.object({
    ...base, kind: v.literal("review"), number: v.number(), url: v.string(), body: v.string(),
    state: v.union(v.literal("approved"), v.literal("changes_requested"), v.literal("commented")),
  }),
  // A PR conversation comment or an inline review comment (`path` set).
  v.object({ ...base, kind: v.literal("comment"), number: v.number(), url: v.string(), body: v.string(), path: v.optional(v.string()) }),
  v.object({ ...base, kind: v.literal("check_suite"), suiteId: v.number(), headSha: v.string(), headBranch: v.optional(v.string()), outcome: v.union(v.literal("pass"), v.literal("fail")) }),
  v.object({ ...base, kind: v.literal("push"), branch: v.string(), sha: v.string() }),
);
export type GithubEvent = Infer<typeof githubEvent>;

const senderRaw = z.object({ login: z.string(), type: z.string() }).optional(); // check_suite from a scheduled/API trigger can come from `ghost` or without one
const common = z.object({
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ full_name: z.string() }),
  sender: senderRaw,
});
const prNumber = z.object({ number: z.number() });

const pullRequest = common.extend({
  action: z.string(),
  pull_request: prNumber.extend({ merged: z.boolean().optional(), head: z.object({ sha: z.string(), ref: z.string() }), base: z.object({ ref: z.string() }) }),
  changes: z.object({ base: z.object({ ref: z.object({ from: z.string() }) }).optional() }).optional(),
});
const review = common.extend({
  action: z.string(),
  pull_request: prNumber,
  review: z.object({ state: z.string(), body: z.string().nullable(), html_url: z.string() }),
});
const reviewComment = common.extend({
  action: z.string(),
  pull_request: prNumber,
  comment: z.object({ body: z.string(), html_url: z.string(), path: z.string() }),
});
const issueComment = common.extend({
  action: z.string(),
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }),
  comment: z.object({ body: z.string(), html_url: z.string() }),
});
const checkSuite = common.extend({
  action: z.string(),
  check_suite: z.object({ id: z.number(), head_sha: z.string(), head_branch: z.string().nullable(), conclusion: z.string().nullable() }),
});
const pushRaw = common.extend({ ref: z.string(), after: z.string(), deleted: z.boolean().optional() });

/** check_suite conclusions → what CI means for the PR. `cancelled` (usually superseded by a newer run), `action_required` (a human must approve the run) and `stale` say nothing about the code. */
export function suiteOutcome(conclusion: string | null): "pass" | "fail" | null {
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "pass";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    default:
      return null;
  }
}

/** The App's own bot user, as it appears in `sender`. */
export const appBotLogin = (slug: string) => `${slug}[bot]`;

/** Whether the event was caused by the App itself (the dork). Bot logins are `<slug>[bot]`; a user may not register that name. */
export function sentByApp(sender: { login: string; bot: boolean }, slug: string): boolean {
  return sender.bot && sender.login.toLowerCase() === appBotLogin(slug).toLowerCase();
}

/**
 * Maps one delivery (`X-GitHub-Event` + JSON body) to the event the ingest handles, or null for everything else: events and actions we
 * do not act on, payloads that do not have the fields we need, and the `installation*` events (acknowledged and ignored).
 */
export function parseGithubEvent(event: string, payload: unknown): GithubEvent | null {
  const head = common.safeParse(payload);
  if (!head.success || head.data.installation === undefined) return null; // only App deliveries carry an installation
  const ctx = {
    installationId: head.data.installation.id,
    repo: head.data.repository.full_name,
    sender: { login: head.data.sender?.login ?? "ghost", bot: head.data.sender?.type === "Bot" },
  };
  switch (event) {
    case "pull_request": {
      const p = pullRequest.safeParse(payload);
      if (!p.success) return null;
      const { action, pull_request: pr, changes } = p.data;
      const number = pr.number;
      if (action === "closed") return { ...ctx, kind: "pr_closed", number, merged: pr.merged === true };
      if (action === "synchronize") return { ...ctx, kind: "pr_synchronize", number, headSha: pr.head.sha, headRef: pr.head.ref };
      if (action === "edited" && changes?.base) return { ...ctx, kind: "pr_base_changed", number, baseRef: pr.base.ref, from: changes.base.ref.from };
      return null;
    }
    case "pull_request_review": {
      const p = review.safeParse(payload);
      if (!p.success || p.data.action !== "submitted") return null;
      const state = p.data.review.state.toLowerCase();
      if (state !== "approved" && state !== "changes_requested" && state !== "commented") return null;
      return { ...ctx, kind: "review", number: p.data.pull_request.number, url: p.data.review.html_url, body: p.data.review.body ?? "", state };
    }
    case "pull_request_review_comment": {
      const p = reviewComment.safeParse(payload);
      if (!p.success || p.data.action !== "created") return null;
      return { ...ctx, kind: "comment", number: p.data.pull_request.number, url: p.data.comment.html_url, body: p.data.comment.body, path: p.data.comment.path };
    }
    case "issue_comment": {
      const p = issueComment.safeParse(payload);
      if (!p.success || p.data.action !== "created" || p.data.issue.pull_request === undefined) return null; // plain issues are not ours
      return { ...ctx, kind: "comment", number: p.data.issue.number, url: p.data.comment.html_url, body: p.data.comment.body };
    }
    case "check_suite": {
      const p = checkSuite.safeParse(payload);
      if (!p.success || p.data.action !== "completed") return null;
      const outcome = suiteOutcome(p.data.check_suite.conclusion);
      if (!outcome) return null;
      const { id, head_sha, head_branch } = p.data.check_suite;
      return { ...ctx, kind: "check_suite", suiteId: id, headSha: head_sha, ...(head_branch ? { headBranch: head_branch } : {}), outcome };
    }
    case "push": {
      const p = pushRaw.safeParse(payload);
      if (!p.success || p.data.deleted || !p.data.ref.startsWith("refs/heads/")) return null;
      return { ...ctx, kind: "push", branch: p.data.ref.slice("refs/heads/".length), sha: p.data.after };
    }
    default:
      return null;
  }
}
