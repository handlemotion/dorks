// The session's pull request as Chat details shows it (`GET /api/dorks/:id/pr`), read live from GitHub with the GitHub CLI's login.

export type MergeMethod = "squash" | "merge" | "rebase";

/** `open` covers drafts (see `draft`); `merged` and `closed` are final. */
export type PullRequestState = "open" | "merged" | "closed";

/**
 * Whether the merge button can go: `clean` (ready), `unstable` (non-required checks failing, still mergeable), `blocked` (branch
 * protection: required checks or reviews), `behind` (needs the base branch merged in), `dirty` (conflicts), `draft`,
 * `unknown` (GitHub is still computing it), `has_hooks` (mergeable; pre-receive hooks run).
 */
export type MergeableState = "clean" | "unstable" | "blocked" | "behind" | "dirty" | "draft" | "unknown" | "has_hooks";

export interface PullRequestPerson {
  login: string;
  avatarUrl?: string;
}

export interface PullRequestFile {
  path: string;
  /** The old path, for a renamed file. */
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** A unified diff with `---`/`+++` headers; absent for binary or very large files. */
  patch?: string;
}

export interface PullRequestComment {
  id: string;
  kind: "comment" | "review" | "review_comment";
  author: PullRequestPerson;
  body: string;
  url: string;
  createdAt: number;
  /** A review's verdict: APPROVED, CHANGES_REQUESTED or COMMENTED. */
  reviewState?: string;
  /** An inline comment's file and line. */
  path?: string;
  line?: number;
}

export interface PullRequestChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** The failing checks' names (at most a few). */
  failing: string[];
}

export interface PullRequestView {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: PullRequestState;
  draft: boolean;
  author: PullRequestPerson;
  headRef: string;
  baseRef: string;
  headSha: string;
  createdAt: number;
  mergedAt?: number;
  closedAt?: number;
  mergedBy?: PullRequestPerson;
  /** null: GitHub has not computed it yet. */
  mergeable: boolean | null;
  mergeableState: MergeableState;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: PullRequestChecks;
  /** The merge methods the repository allows, in the order GitHub offers them. */
  mergeMethods: MergeMethod[];
  files: PullRequestFile[];
  /** Conversation comments, reviews with a body or a verdict, and inline comments, oldest first. */
  comments: PullRequestComment[];
}
