import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, runGit } from "./git";
import { validRepo } from "./pr-ref";
import type { Identity } from "./runas";

// What the Stop gate looks at: the git repositories under the workdir, and work in them that has not reached GitHub. Local reads only
// (no fetch), so it is fast and offline-safe; the one network question, "does this pushed branch have a PR?", is the caller's `hasPr`.

export type FindingKind =
  | "uncommitted" // changed or new files in the working tree, not committed at all
  | "unpushed" // commits on a branch that its remote counterpart does not have
  | "unpublished" // a branch with commits beyond the default branch that was never pushed
  | "no_pr" // a pushed branch with commits beyond the default branch and no pull request
  | "pr_ended"; // commits were pushed to a branch whose pull request is already merged or closed

/** What GitHub says about pull requests for a pushed branch. */
export type BranchPrStatus = { state: "open" } | { state: "merged" | "closed"; number: number; headSha: string | null } | { state: "none" };

export interface Finding {
  kind: FindingKind;
  /** The repository directory. */
  dir: string;
  /** owner/name from the origin remote, when it has one. */
  repo: string | null;
  branch: string;
  detail: string;
}

export interface ScanOptions {
  workDir: string;
  env: NodeJS.ProcessEnv;
  /** Run git as the user that owns the working trees (git refuses repositories owned by someone else). */
  runAs?: Identity | null;
  /** Pull request status for a pushed branch; null when it cannot be told. Unknown never produces a finding. */
  prStatus: (repo: string, branch: string) => Promise<BranchPrStatus | null>;
}

const GIT_TIMEOUT_MS = 10_000;
/** workDir/<owner>/<name> is the layout the bridge clones into; the agent may nest a little deeper. */
const MAX_DEPTH = 3;
/** A runaway box should not turn one Stop into dozens of `gh` calls. */
const MAX_PR_LOOKUPS = 10;

/** Directories with a `.git` directory below `root`, without descending into them (worktrees and submodules have a `.git` file: their branches are the owner repo's). */
export function findRepos(root: string, depth = MAX_DEPTH): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.name === ".git" && e.isDirectory())) return [root];
  if (depth === 0) return [];
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").flatMap((e) => findRepos(join(root, e.name), depth - 1));
}

/** `owner/name` from an https, ssh or file remote URL. */
export function repoFromUrl(url: string | null): string | null {
  if (!url) return null;
  const repo = url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join("/");
  return validRepo(repo) ? repo : null;
}

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

/** One local branch: unpushed commits, commits on no remote at all, or pushed beyond the default branch (a PR candidate). */
async function classifyBranch(
  branch: string,
  upstream: string,
  base: string | null,
  count: (range: string) => Promise<number>,
  exists: (ref: string) => Promise<boolean>,
): Promise<{ kind: FindingKind; detail: string; pushed: boolean; remote?: string } | null> {
  const isBase = base === `origin/${branch}`;
  // `git checkout -b feat origin/main` leaves feat tracking the default branch, which says nothing about whether feat was pushed.
  let remote: string | null = upstream && (isBase || upstream !== base) ? upstream : null;
  if (!remote && (await exists(`refs/remotes/origin/${branch}`))) remote = `origin/${branch}`; // pushed without -u
  const beyondBase = !isBase && base ? await count(`${base}..${branch}`) : 0;
  if (!remote) return beyondBase > 0 ? { kind: "unpublished", detail: `${commits(beyondBase)} not pushed anywhere (no upstream)`, pushed: false } : null;
  const ahead = await count(`${remote}..${branch}`);
  if (ahead > 0) return { kind: "unpushed", detail: `${commits(ahead)} not pushed to ${remote}`, pushed: false };
  return beyondBase > 0 ? { kind: "no_pr", detail: `pushed to ${remote}, no pull request`, pushed: true, remote } : null;
}

interface PushedCandidate {
  finding: Finding;
  remote: string;
  headSha: string;
}

async function scanRepo(dir: string, o: ScanOptions): Promise<{ done: Finding[]; pushed: PushedCandidate[] }> {
  const env = gitEnv(o.env, o.runAs);
  const out = async (...args: string[]) => {
    const r = await runGit(["--no-optional-locks", ...args], dir, env, o.runAs, GIT_TIMEOUT_MS); // never take index.lock from under the agent
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const count = async (range: string) => Number(await out("rev-list", "--count", range)) || 0;
  const exists = async (ref: string) => (await out("rev-parse", "--verify", "--quiet", ref)) !== null;

  const repo = repoFromUrl(await out("config", "--get", "remote.origin.url"));
  // The default branch: what origin/HEAD points to, else origin/main or origin/master. Without one, "beyond the default branch" is unknowable.
  let base = await out("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  for (const guess of base ? [] : ["origin/main", "origin/master"]) if (await exists(`refs/remotes/${guess}`)) base = guess;

  const done: Finding[] = [];
  const pushed: PushedCandidate[] = [];
  const found = (kind: FindingKind, branch: string, detail: string) => ({ kind, dir, repo, branch, detail });
  // Edits that were never committed: the commonest way to stop "done" with nothing on GitHub. Ignored files do not count.
  // A background read: no optional locks, so it never holds index.lock while the agent runs `git add` or `git commit`.
  const status = await out("status", "--porcelain", "--untracked-files=normal");
  if (status) {
    const n = status.split("\n").length;
    const branch = (await out("branch", "--show-current")) || "HEAD (detached)";
    done.push(found("uncommitted", branch, `${n} ${n === 1 ? "file" : "files"} changed and not committed`));
  }
  const heads = await out("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(objectname)", "refs/heads");
  for (const line of heads ? heads.split("\n") : []) {
    const [branch = "", upstream = "", track = "", headSha = ""] = line.split("\t");
    if (!branch || track === "gone") continue; // gone: its remote branch was deleted (merged and cleaned up)
    const f = await classifyBranch(branch, upstream, base, count, exists);
    if (!f) continue;
    if (f.pushed) pushed.push({ finding: found(f.kind, branch, f.detail), remote: f.remote ?? `origin/${branch}`, headSha });
    else done.push(found(f.kind, branch, f.detail));
  }
  return { done, pushed };
}

/**
 * True only when `prHeadSha` exists locally and `branchSha` is not an ancestor of it (meaning commits were added beyond the PR's head).
 * When a collaborator pushed extra commits before merging (fetched or unfetched), this returns false instead of a false positive.
 */
async function hasCommitsBeyondPr(dir: string, o: ScanOptions, branchSha: string, prHeadSha: string): Promise<boolean> {
  if (!branchSha || !prHeadSha || branchSha === prHeadSha) return false;
  const env = gitEnv(o.env, o.runAs);
  const known = await runGit(["rev-parse", "--verify", "--quiet", `${prHeadSha}^{commit}`], dir, env, o.runAs, GIT_TIMEOUT_MS);
  if (known.code !== 0) return false;
  const ancestor = await runGit(["merge-base", "--is-ancestor", branchSha, prHeadSha], dir, env, o.runAs, GIT_TIMEOUT_MS);
  return ancestor.code === 1;
}

/** Everything under the workdir that has not made it to a PR yet, repository by repository, branch by branch. */
export async function scanWork(o: ScanOptions): Promise<Finding[]> {
  const scans = await Promise.all(findRepos(o.workDir).map((dir) => scanRepo(dir, o)));
  const candidates = scans.flatMap((s) => s.pushed).slice(0, MAX_PR_LOOKUPS);
  const prFindings = (
    await Promise.all(
      candidates.map(async ({ finding, remote, headSha }) => {
        const status = finding.repo ? await o.prStatus(finding.repo, finding.branch) : null;
        if (!status || status.state === "open") return null;
        if (status.state === "none") return finding;
        if (!status.headSha || !(await hasCommitsBeyondPr(finding.dir, o, headSha, status.headSha))) return null;
        return {
          ...finding,
          kind: "pr_ended" as const,
          detail: `pushed to ${remote}, but PR #${status.number} is already ${status.state} — these commits did not go into it`,
        };
      }),
    )
  ).filter((f) => f !== null);
  return [...scans.flatMap((s) => s.done), ...prFindings];
}
