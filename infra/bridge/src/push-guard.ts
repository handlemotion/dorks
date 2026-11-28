import { resolve } from "node:path";
import { gitEnv, runGit } from "./git";
import { errTag, type Log } from "./redact";
import type { Identity } from "./runas";
import { repoFromUrl, type BranchPrStatus } from "./work-scan";

// The push guard (docs/autonomy.md, "Pushes to a merged PR"): a `git push` to the branch of a PR that already merged (or closed) never
// reaches the base branch, and nobody notices. Claude's PreToolUse hook asks here before the push runs and blocks it; for agents without
// a pre-run hook (Codex, OpenCode, Antigravity) the bridge asks right after a push finished and tells the agent mid-turn. The server's
// poller is the backstop for pushes neither saw (services/poller.ts, `pollMergedBranch`).
// It is fast and fails open: the answer for a branch is cached for a few seconds, and a GitHub that cannot be reached lets the push
// through with a warning.

/** How long one answer for a repo and branch is reused (a push retried right after a block, several pushes in one command). */
export const PUSH_CHECK_TTL_MS = 10_000;
/** How long a pre-push lookup may take before the push goes ahead unchecked. */
export const PUSH_LOOKUP_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;

/** A branch a `git push` writes to. `sha`: the local commit pushed there, when it resolves. */
export interface PushTarget {
  dir: string;
  repo: string;
  branch: string;
  sha: string | null;
}

export type PushVerdict = { action: "allow" } | { action: "warn"; message: string } | { action: "block"; reason: string };

/** "2026-11-27 14:03 UTC" from an ISO time; null when there is none. */
const when = (iso: string | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null);

/**
 * The decision, pure: a branch whose latest PR is merged or closed is blocked, open or no PR at all passes, and unknown (GitHub not
 * reachable) passes with a warning. `reused`: the ended PR's head is not in what is pushed, so this is a new branch that reuses the name.
 */
export function pushVerdict(t: Pick<PushTarget, "repo" | "branch">, status: BranchPrStatus | null, reused = false): PushVerdict {
  if (!status)
    return {
      action: "warn",
      message: `Dorks could not check GitHub for a merged PR on ${t.repo} branch ${t.branch}. If that branch's PR already merged, this push will not reach the base branch: put the commits on a new branch from origin/main and open a new PR.`,
    };
  if (status.state === "open" || status.state === "none" || reused) return { action: "allow" };
  const pr = `PR #${status.number}${status.url ? ` (${status.url})` : ` in ${t.repo}`}`;
  const at = when(status.at);
  const base = status.base ?? "main";
  const what = status.state === "merged" ? `was already merged${at ? ` at ${at}` : ""}` : `was closed without merging${at ? ` at ${at}` : ""}`;
  return {
    action: "block",
    reason: `${pr} ${what}; this push to ${t.branch} would not reach ${base}. Create a branch from origin/${base}, cherry-pick your commit, and open a new PR.`,
  };
}

// ---------------------------------------------------------------- reading the command
/** Shell words of one command line, split into simple commands at unquoted ; && || | and newlines. Quotes are honoured, not expanded. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === ")") endSegment();
    else if (c === " " || c === "\t") endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/** A `git push` found in a command: the directory it runs in and its arguments after `push`. */
export interface PushCall {
  dir: string;
  args: string[];
}

const SHELLS = /^(?:\/\S*\/)?(?:ba|z|da)?sh$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The `push` call of one `git …` command's words, with `-C` applied to `dir`; null when it is another subcommand. */
function gitPush(w: string[], dir: string): PushCall | null {
  let i = 1;
  let gitDir = dir;
  while (i < w.length && w[i]!.startsWith("-")) {
    const opt = w[i]!;
    const valued = opt === "-C" || opt === "-c" || opt === "--git-dir" || opt === "--work-tree" || opt === "--namespace";
    if (opt === "-C" && w[i + 1]) gitDir = resolve(gitDir, w[i + 1]!);
    i += valued ? 2 : 1;
  }
  return w[i] === "push" ? { dir: gitDir, args: w.slice(i + 1) } : null;
}

/** The words of a simple command without what only prefixes it (`FOO=1`, `env`, `command`, `exec`). */
function bare(seg: string[]): string[] {
  let w = seg;
  while (w.length && (ASSIGNMENT.test(w[0]!) || w[0] === "command" || w[0] === "exec" || w[0] === "env")) w = w.slice(1);
  return w;
}

/** Every `git push` in a shell command, following `cd`, `git -C` and `bash -c '…'` (how Codex reports its commands). */
export function findPushes(command: string, cwd: string): PushCall[] {
  if (!/\bpush\b/.test(command)) return [];
  const out: PushCall[] = [];
  let dir = cwd;
  for (const w of shellSegments(command).map(bare)) {
    const [cmd = "", arg] = w;
    if (SHELLS.test(cmd)) {
      const c = w.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x));
      if (c !== -1 && w[c + 1]) out.push(...findPushes(w[c + 1]!, dir));
    } else if (cmd === "cd") {
      if (arg && arg !== "-") dir = resolve(dir, arg);
    } else if (/(?:^|\/)git$/.test(cmd)) {
      const push = gitPush(w, dir);
      if (push) out.push(push);
    }
  }
  return out;
}

/** Flags that take the next word as their value (when not written `--flag=value`). */
const VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
/** Pushes that write no branch, or say nothing about one: tags, deletions, everything at once, a dry run. */
const NOT_A_BRANCH = new Set(["-d", "--delete", "--tags", "--all", "--mirror", "--prune", "-n", "--dry-run", "--help", "-h"]);

/** The remote and refspecs of `git push <args>`; null for a push that writes no single branch (tags, deletions, --all, a dry run). */
export function pushArgs(args: string[]): { remote: string | null; refspecs: string[] } | null {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (NOT_A_BRANCH.has(a)) return null;
    if (VALUED.has(a)) i++;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const [remote = null, ...refspecs] = positional;
  return { remote, refspecs };
}

/** The local commit and the remote branch of one refspec; null for a deletion (`:branch`), a tag or another namespace. */
export function refspec(raw: string, current: string | null): { src: string; dst: string } | null {
  const spec = raw.replace(/^\+/, "");
  const colon = spec.indexOf(":");
  const src = colon === -1 ? spec : spec.slice(0, colon);
  let dst = colon === -1 ? spec : spec.slice(colon + 1);
  if (dst === "HEAD") dst = current ?? "";
  if (dst.startsWith("refs/")) dst = dst.startsWith("refs/heads/") ? dst.slice("refs/heads/".length) : "";
  return src && dst ? { src, dst } : null;
}

/** The branches one `git push` writes, read from the repo it runs in. Anything unclear is left out: the guard never guesses. */
export async function pushTargets(call: PushCall, env: NodeJS.ProcessEnv, runAs: Identity | null): Promise<PushTarget[]> {
  const parsed = pushArgs(call.args);
  if (!parsed) return [];
  const genv = gitEnv(env, runAs);
  const git = async (...args: string[]) => {
    const r = await runGit(["--no-optional-locks", ...args], call.dir, genv, runAs, GIT_TIMEOUT_MS);
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  const current = await git("symbolic-ref", "--short", "-q", "HEAD");
  const remote = parsed.remote ?? (current ? await git("config", "--get", `branch.${current}.remote`) : null) ?? "origin";
  const repo = repoFromUrl(/[:/]/.test(remote) ? remote : await git("remote", "get-url", remote));
  if (!repo) return [];
  const pairs: { src: string; dst: string }[] = [];
  if (!parsed.refspecs.length) {
    if (!current) return [];
    // `git push` alone goes to the upstream's branch when there is one (push.default simple/upstream), else the same name.
    const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    const dst = upstream?.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : current;
    pairs.push({ src: current, dst });
  }
  for (const raw of parsed.refspecs) {
    const pair = refspec(raw, current);
    if (pair) pairs.push(pair);
  }
  // The default branch itself is no PR's head (fork PRs from a `main` are filtered out by the lookup anyway).
  const head = (await git("symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`))?.slice(remote.length + 1);
  const defaults = new Set([head ?? "main", "main", "master"]);
  return Promise.all(pairs.filter((p) => !defaults.has(p.dst)).map(async (p) => ({ dir: call.dir, repo, branch: p.dst, sha: await git("rev-parse", "--verify", "-q", `${p.src}^{commit}`) })));
}

// ---------------------------------------------------------------- the guard
export interface PushGuardDeps {
  env: NodeJS.ProcessEnv;
  runAs: Identity | null;
  /** The latest PR for a branch (pr-lookup.ts); null when GitHub cannot be asked. */
  prStatus: (repo: string, branch: string, timeoutMs?: number) => Promise<BranchPrStatus | null>;
  log: Log;
  now?: () => number;
}

export class PushGuard {
  private cache = new Map<string, { at: number; status: Promise<BranchPrStatus | null> }>();

  constructor(private d: PushGuardDeps) {}

  /**
   * Before a command runs: block it when it pushes to an ended PR's branch, warn when that cannot be told. Null when it pushes nothing.
   * Several pushes in one command: the first block wins, else the first warning.
   */
  async check(command: string, cwd: string): Promise<PushVerdict | null> {
    const targets = (await Promise.all(findPushes(command, cwd).map((c) => pushTargets(c, this.d.env, this.d.runAs)))).flat();
    if (!targets.length) return null;
    const verdicts = await Promise.all(targets.map(async (t) => this.verdict(t)));
    return verdicts.find((v) => v.action === "block") ?? verdicts.find((v) => v.action === "warn") ?? { action: "allow" };
  }

  /** After a push already ran (agents without a pre-run hook): what to tell the agent at once, or null. */
  async afterPush(command: string, cwd: string): Promise<string | null> {
    const v = await this.check(command, cwd);
    if (v?.action !== "block") return null;
    this.d.log("push guard: a push landed on an ended PR's branch");
    return `Dorks: your last \`git push\` already ran, but ${v.reason.replace("this push", "that push").replace("your commit", "the commits you pushed")} Don't push to that branch again.`;
  }

  private async verdict(t: PushTarget): Promise<PushVerdict> {
    const status = await this.status(t.repo, t.branch);
    const reused = !!status && (status.state === "merged" || status.state === "closed") && !!status.headSha && !!t.sha && !(await this.contains(t, status.headSha));
    const v = pushVerdict(t, status, reused);
    if (v.action !== "allow") this.d.log(`push guard: ${v.action} a push to an ended or unknown PR's branch`);
    return v;
  }

  /** Whether the commit pushed contains the ended PR's head. Unknown (the head was never fetched here) counts as yes: the branch name is evidence enough. */
  private async contains(t: PushTarget, prHead: string): Promise<boolean> {
    if (t.sha === prHead) return true;
    const genv = gitEnv(this.d.env, this.d.runAs);
    const known = await runGit(["cat-file", "-e", `${prHead}^{commit}`], t.dir, genv, this.d.runAs, GIT_TIMEOUT_MS);
    if (known.code !== 0) return true;
    return (await runGit(["merge-base", "--is-ancestor", prHead, t.sha!], t.dir, genv, this.d.runAs, GIT_TIMEOUT_MS)).code === 0;
  }

  private status(repo: string, branch: string): Promise<BranchPrStatus | null> {
    const now = (this.d.now ?? Date.now)();
    const key = `${repo.toLowerCase()}#${branch}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < PUSH_CHECK_TTL_MS) return hit.status;
    for (const [k, v] of this.cache) if (now - v.at >= PUSH_CHECK_TTL_MS) this.cache.delete(k);
    const status = this.d.prStatus(repo, branch, PUSH_LOOKUP_TIMEOUT_MS).catch((e) => {
      this.d.log("push guard: lookup failed:", errTag(e));
      return null;
    });
    this.cache.set(key, { at: now, status });
    return status;
  }
}
