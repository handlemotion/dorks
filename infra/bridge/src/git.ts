import { execFile } from "node:child_process";
import { chownSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHILD_ENV_DENY } from "./config";
import type { Log } from "./redact";
import { asIdentity, type Identity } from "./runas";

export class SetupError extends Error {
  constructor(readonly step: string) {
    super(`setup failed: ${step}`);
  }
}

interface GitCtx {
  gitBaseUrl: string;
  workDir: string;
  /** Value for `credential.helper` (see credentials.ts). */
  helper: string;
  log: Log;
  env?: NodeJS.ProcessEnv;
  /** Run git as this user (see runas.ts) so the working tree is theirs. */
  runAs?: Identity | null;
}

/** The URL prefixes `credential.<url>.helper` is set for: github.com, and the clone base when it is some other http(s) host. */
const helperScopes = (gitBaseUrl: string) => [...new Set(["https://github.com", gitBaseUrl].filter((u) => /^https?:\/\//.test(u)))];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function runGit(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, id?: Identity | null): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const [bin, argv] = asIdentity(id, "git", args);
    execFile(bin, argv, { cwd: cwd ?? (id ? "/" : undefined), env, maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

const gitEnv = (base: NodeJS.ProcessEnv, id?: Identity | null): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!CHILD_ENV_DENY.some((re) => re.test(k))) env[k] = v;
  if (id) Object.assign(env, { HOME: id.home, USER: id.user, LOGNAME: id.user });
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.GCM_INTERACTIVE = "never";
  return env;
};

/** Clone-or-fetch the repo and check out the dork branch (creating it if needed). Idempotent; never rewrites local work. Returns the repo dir. */
export async function prepareRepo(ctx: GitCtx, repo: { fullName: string; branch: string }): Promise<string> {
  const { fullName, branch } = repo;
  if (!REPO_RE.test(fullName) || fullName.includes("..")) throw new SetupError("invalid repo name");
  const id = ctx.runAs;
  const env = gitEnv(ctx.env ?? process.env, id);
  const run = (args: string[], cwd: string | undefined, e: NodeJS.ProcessEnv) => runGit(args, cwd, e, id);
  const dir = join(ctx.workDir, fullName);
  const url = `${ctx.gitBaseUrl}/${fullName}.git`; // clean URL: no credentials, ever
  // First entry resets any helper configured system/globally so only ours answers.
  const helperCfg = ["-c", "credential.helper=", "-c", `credential.helper=${ctx.helper}`];
  const git = (args: string[], cwd = dir) => run([...helperCfg, ...args], cwd, env);

  if (!branch || branch.startsWith("-") || (await run(["check-ref-format", "--branch", branch], undefined, env)).code !== 0) throw new SetupError("invalid branch name");

  const isRepo = existsSync(join(dir, ".git"));
  if (!isRepo) {
    const tmp = `${dir}.cloning`;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true }); // leftover of an interrupted clone; the dork's real work only ever lives in a complete clone
    mkdirSync(dirname(dir), { recursive: true });
    if (id) for (const d of [ctx.workDir, dirname(dir)]) chownSync(d, id.uid, id.gid); // the clone is made by that user, inside these
    ctx.log("cloning", fullName);
    if ((await run([...helperCfg, "clone", "--quiet", url, tmp], undefined, env)).code !== 0) throw new SetupError("git clone");
    renameSync(tmp, dir);
  } else {
    ctx.log("fetching", fullName);
    await run(["remote", "set-url", "origin", url], dir, env); // heal a URL someone put credentials in
    if ((await git(["fetch", "--quiet", "origin"])).code !== 0) ctx.log("fetch failed; continuing with the checkout on disk");
  }

  // Persist the helper for the agent's own git commands (push etc.) in the user's global config, scoped to the git host, so any repo
  // it clones under the workdir can push, not just this one. It holds a socket path, not a secret.
  for (const scope of helperScopes(ctx.gitBaseUrl)) {
    await run(["config", "--global", "--replace-all", `credential.${scope}.helper`, ""], dir, env); // the empty value resets earlier helpers
    await run(["config", "--global", "--add", `credential.${scope}.helper`, ctx.helper], dir, env);
  }
  for (const [k, v] of [["user.name", "dorks"], ["user.email", "dorks@users.noreply.github.com"]] as const) {
    if (!(await run(["config", k], dir, env)).stdout.trim()) await run(["config", "--global", k, v], dir, env);
  }

  const exists = async (ref: string) => (await run(["show-ref", "--verify", "--quiet", ref], dir, env)).code === 0;
  let ok: boolean;
  if (await exists(`refs/heads/${branch}`)) ok = (await run(["checkout", "--quiet", branch], dir, env)).code === 0;
  else if (await exists(`refs/remotes/origin/${branch}`)) ok = (await run(["checkout", "--quiet", "-b", branch, "--track", `origin/${branch}`], dir, env)).code === 0;
  else ok = (await run(["checkout", "--quiet", "-b", branch], dir, env)).code === 0; // new dork branch off the default branch
  if (!ok) throw new SetupError("git checkout");
  return dir;
}
