import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, runGit } from "./git";
import { validRepo } from "./pr-ref";
import type { Identity } from "./runas";

// What the Stop gate looks at: the git repositories under the workdir, and work in them that has not reached GitHub. Local reads only
// (no fetch), so it is fast and offline-safe; the one network question, "does this pushed branch have a PR?", is the caller's `hasPr`.

export type FindingKind =
  | "unpushed" // commits on a branch that its remote counterpart does not have
  | "unpublished" // a branch with commits beyond the default branch that was never pushed
  | "no_pr"; // a pushed branch with commits beyond the default branch and no pull request

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
  /** Whether a pull request (open, merged or closed) exists for the branch; null when it cannot be told. Unknown never produces a finding. */
  hasPr: (repo: string, branch: string) => Promise<boolean | null>;
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
  const repo = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/");
  return validRepo(repo) ? repo : null;
}

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

async function scanRepo(dir: string, o: ScanOptions): Promise<{ done: Finding[]; pushed: Finding[] }> {
  const env = gitEnv(o.env, o.runAs);
  const out = async (...args: string[]) => {
    const r = await runGit(args, dir, env, o.runAs, GIT_TIMEOUT_MS);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const count = async (range: string) => Number(await out("rev-list", "--count", range)) || 0;
  const exists = async (ref: string) => (await out("rev-parse", "--verify", "--quiet", ref)) !== null;

  const repo = repoFromUrl(await out("config", "--get", "remote.origin.url"));
  // The default branch: what origin/HEAD points to, else origin/main or origin/master. Without one, "beyond the default branch" is unknowable.
  let base = await out("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  for (const guess of base ? [] : ["origin/main", "origin/master"]) if (await exists(`refs/remotes/${guess}`)) base = guess;

  const done: Finding[] = [];
  const pushed: Finding[] = [];
  const found = (kind: FindingKind, branch: string, detail: string) => ({ kind, dir, repo, branch, detail });
  const heads = await out("for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)", "refs/heads");
  for (const line of heads ? heads.split("\n") : []) {
    const [branch = "", upstream = "", track = ""] = line.split("\t");
    if (!branch || track === "gone") continue; // gone: its remote branch was deleted (merged and cleaned up)
    const isBase = base === `origin/${branch}`;
    // `git checkout -b feat origin/main` leaves feat tracking the default branch, which says nothing about whether feat was pushed.
    let remote: string | null = upstream && (isBase || upstream !== base) ? upstream : null;
    if (!remote && (await exists(`refs/remotes/origin/${branch}`))) remote = `origin/${branch}`; // pushed without -u
    const beyondBase = !isBase && base ? await count(`${base}..${branch}`) : 0;
    if (remote) {
      const ahead = await count(`${remote}..${branch}`);
      if (ahead > 0) done.push(found("unpushed", branch, `${commits(ahead)} not pushed to ${remote}`));
      else if (beyondBase > 0) pushed.push(found("no_pr", branch, `pushed to ${remote}, no pull request`));
    } else if (beyondBase > 0) done.push(found("unpublished", branch, `${commits(beyondBase)} not pushed anywhere (no upstream)`));
  }
  return { done, pushed };
}

/** Everything under the workdir that has not made it to a PR yet, repository by repository, branch by branch. */
export async function scanWork(o: ScanOptions): Promise<Finding[]> {
  const scans = await Promise.all(findRepos(o.workDir).map((dir) => scanRepo(dir, o)));
  const candidates = scans.flatMap((s) => s.pushed).slice(0, MAX_PR_LOOKUPS);
  const noPr = (await Promise.all(candidates.map(async (f) => ((f.repo ? await o.hasPr(f.repo, f.branch) : null) === false ? f : null)))).filter((f) => f !== null);
  return [...scans.flatMap((s) => s.done), ...noPr];
}
