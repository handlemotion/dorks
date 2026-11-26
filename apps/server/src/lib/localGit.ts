import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// The checkouts of local dorks (docs/local-dorks.md). Every repository has one bare clone under the data directory
// (`<local>/repos/<owner>/<name>.git`), cloned from GitHub the first time and fetched before each use; every local dork works in its own
// git worktree of that clone, on its own branch. Archiving a dork removes its worktree (the branch stays in the clone, and on GitHub
// once pushed); its next wake adds it again, from the pushed branch when there is one.
//
// Git runs here with no user or system config (the owner's `url.insteadOf` or credential helpers must not apply) and the GitHub token
// only in its environment, as an `http.extraHeader`, never in a URL or an argument.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 15 * 60_000;

export interface GitAuth {
  /** `https://github.com` (or `DORKS_GIT_BASE_URL` in development): repos are `<base>/<owner>/<name>.git`. */
  baseUrl: string;
  /** The GitHub token, for https remotes. */
  token?: string;
}

export class LocalGitError extends Error {
  constructor(
    readonly step: string,
    readonly detail = "",
  ) {
    super(`git ${step} failed`);
    this.name = "LocalGitError";
  }
}

function gitEnv(auth?: GitAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  if (auth?.token && /^https?:\/\//.test(auth.baseUrl)) {
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${auth.baseUrl}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}` });
  }
  return env;
}

export function git(args: string[], cwd: string | undefined, auth?: GitAuth): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: gitEnv(auth), maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Never let a token or a URL with one reach a log: git echoes remote URLs in its errors. */
const tail = (s: string) =>
  s
    .replace(/(x-access-token|basic)[^\s]*/gi, "$1 ***")
    .trim()
    .split("\n")
    .slice(-3)
    .join(" | ")
    .slice(0, 300);

async function must(step: string, args: string[], cwd: string | undefined, auth?: GitAuth) {
  const r = await git(args, cwd, auth);
  if (r.code !== 0) throw new LocalGitError(step, tail(r.stderr));
  return r.stdout;
}

const has = async (clone: string, ref: string) => (await git(["show-ref", "--verify", "--quiet", ref], clone)).code === 0;

// One git operation at a time per clone: two dorks of one repository starting together would race on its lock files.
const chains = new Map<string, Promise<unknown>>();
function serial<A>(key: string, f: () => Promise<A>): Promise<A> {
  const run = (chains.get(key) ?? Promise.resolve()).then(f, f);
  const settled = run.catch(() => {});
  chains.set(key, settled);
  void settled.then(() => chains.get(key) === settled && chains.delete(key));
  return run;
}

export interface Checkout {
  /** `<local>/repos`: the bare clones. */
  reposDir: string;
  /** The dork's work directory; its worktree is `<workDir>/<owner>/<name>`, where the bridge expects its repository. */
  workDir: string;
  repo: string;
  branch: string;
}

export const clonePath = (reposDir: string, repo: string) => join(reposDir, `${repo}.git`);
export const worktreePath = (workDir: string, repo: string) => join(workDir, repo);

/** The bare clone of `repo`, made on first use and fetched every time (a fetch that fails keeps what is on disk). */
async function freshClone(reposDir: string, repo: string, auth: GitAuth): Promise<string> {
  if (!REPO_RE.test(repo) || repo.includes("..")) throw new LocalGitError("repository name");
  const clone = clonePath(reposDir, repo);
  const url = `${auth.baseUrl.replace(/\/+$/, "")}/${repo}.git`; // clean URL: no credentials, ever
  if (!existsSync(join(clone, "HEAD"))) {
    const tmp = `${clone}.cloning`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(dirname(clone), { recursive: true });
    await must("init", ["init", "--quiet", "--bare", tmp], undefined);
    await must("config", ["remote", "add", "origin", url], tmp);
    // A bare repository has no remote-tracking refs by default; worktrees branch off them, so fetch into refs/remotes/origin.
    await must("config", ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], tmp);
    await must("clone", ["fetch", "--quiet", "origin"], tmp, auth);
    await must("default branch", ["remote", "set-head", "origin", "--auto"], tmp, auth);
    renameSync(tmp, clone);
    return clone;
  }
  await git(["remote", "set-url", "origin", url], clone); // heal a URL someone put credentials in
  const fetched = await git(["fetch", "--quiet", "--prune", "origin"], clone, auth);
  if (fetched.code !== 0) console.error("local: fetch failed; using the clone on disk", tail(fetched.stderr));
  else if (!(await has(clone, "refs/remotes/origin/HEAD"))) await git(["remote", "set-head", "origin", "--auto"], clone, auth);
  return clone;
}

/**
 * The dork's worktree, added when it is missing (a new dork, or one archived and woken again). The branch comes, in order, from the
 * clone's own branch of that name (fast-forwarded to the pushed one when that is ahead), the pushed branch, or the default branch.
 * Returns the worktree's path. Idempotent: an existing worktree is left as the agent left it.
 */
export function ensureWorktree(c: Checkout, auth: GitAuth): Promise<string> {
  return serial(c.repo, async () => {
    const clone = await freshClone(c.reposDir, c.repo, auth);
    const wt = worktreePath(c.workDir, c.repo);
    if (existsSync(join(wt, ".git"))) return wt;
    if ((await git(["check-ref-format", "--branch", c.branch], clone)).code !== 0) throw new LocalGitError("branch name");
    rmSync(wt, { recursive: true, force: true }); // what is left of an interrupted add
    mkdirSync(dirname(wt), { recursive: true });
    await git(["worktree", "prune"], clone);
    const local = await has(clone, `refs/heads/${c.branch}`);
    const pushed = await has(clone, `refs/remotes/origin/${c.branch}`);
    const ahead = local && pushed && (await git(["merge-base", "--is-ancestor", c.branch, `origin/${c.branch}`], clone)).code === 0;
    if (ahead) await must("fast-forward", ["branch", "--force", c.branch, `origin/${c.branch}`], clone);
    if (local) await must("worktree add", ["worktree", "add", "--quiet", wt, c.branch], clone);
    else if (pushed) await must("worktree add", ["worktree", "add", "--quiet", "--track", "-b", c.branch, wt, `origin/${c.branch}`], clone);
    else await must("worktree add", ["worktree", "add", "--quiet", "--no-track", "-b", c.branch, wt, "refs/remotes/origin/HEAD"], clone);
    return wt;
  });
}

/**
 * Removes the dork's worktree (`git worktree remove --force`, then prune). Uncommitted changes in it are gone; commits stay on the
 * branch in the clone. `dropBranch` (the dork is deleted) also deletes that branch from the clone, never from GitHub.
 */
export function removeWorktree(c: Checkout, dropBranch = false): Promise<void> {
  return serial(c.repo, async () => {
    const clone = clonePath(c.reposDir, c.repo);
    const wt = worktreePath(c.workDir, c.repo);
    if (!existsSync(join(clone, "HEAD"))) {
      rmSync(wt, { recursive: true, force: true });
      return;
    }
    if (existsSync(wt) && (await git(["worktree", "remove", "--force", wt], clone)).code !== 0) rmSync(wt, { recursive: true, force: true });
    await git(["worktree", "prune"], clone);
    if (dropBranch && REPO_RE.test(c.repo)) await git(["branch", "-D", c.branch], clone);
  });
}

/** The worktrees git knows for a clone (for tests and checks). */
export async function listWorktrees(reposDir: string, repo: string): Promise<string[]> {
  const out = (await git(["worktree", "list", "--porcelain"], clonePath(reposDir, repo))).stdout;
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9))
    .filter((p) => !p.endsWith(".git"));
}
