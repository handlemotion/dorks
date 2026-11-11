import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the bridge reads from its own environment. The box provides the first three; the rest are optional knobs. */
export interface Config {
  dorkId: string;
  bridgeUrl: string;
  /**
   * When the bridge URL is the owner's embedded Wurmhol tunnel: the Dorks tunnel service and this sandbox's ticket for it, traded
   * for the grants the relay wants. Not an authenticator: the per-dork secret is. Never logged, never forwarded to the child.
   */
  tunnel: { service: string; ticket: string } | null;
  /** Never logged, never forwarded to the Claude child. */
  bridgeSecret: string;
  claudeBin: string;
  /** Appended to the claude argv (space separated). Escape hatch, e.g. `--model sonnet`. */
  claudeExtraArgs: string[];
  permissionMode: string;
  /** Run claude (and its git setup) as this unprivileged user; the bridge must then be root. See runas.ts. */
  runAs: string | null;
  /** Base URL repos are cloned from: `<gitBaseUrl>/<owner>/<repo>.git`. */
  gitBaseUrl: string;
  /** Holds the dedupe journal and the files handed to Claude. Not secrets at rest: the token only ever lives in memory. */
  stateDir: string;
  /** Where the local RPC socket lives (`stateDir` when unset). Never under a lazily restored home: see `runtimeSockDir`. */
  sockDir?: string;
  workDir: string;
  heartbeatMs: number;
  deltaBatchMs: number;
  batchMs: number;
  flushIdleWaitMs: number;
  flushInterruptWaitMs: number;
  /** How long a flush waits for the whole-filesystem `sync` before reporting `flushed` anyway (the transcript is fsynced first). */
  flushSyncWaitMs: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * The bridge secret comes from a file (BRIDGE_SECRET_FILE, mode 0400) that is unlinked right after reading, so it never sits in the
 * process environment (/proc/<pid>/environ) where a same-uid child could read it. BRIDGE_SECRET in env is the fallback.
 */
function readSecret(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.BRIDGE_SECRET_FILE;
  if (!file) return env.BRIDGE_SECRET;
  try {
    const v = readFileSync(file, "utf8").trim();
    try {
      unlinkSync(file);
    } catch {
      /* read-only mount etc.: the file is still 0400 */
    }
    return v || env.BRIDGE_SECRET;
  } catch {
    return env.BRIDGE_SECRET; // file already consumed (restart after a pause): the entrypoint must provide it again, or env
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { DORK_ID: dorkId, BRIDGE_URL: bridgeUrl } = env;
  const bridgeSecret = readSecret(env);
  if (!dorkId || !bridgeUrl || !bridgeSecret) throw new Error("DORK_ID, BRIDGE_URL and BRIDGE_SECRET (or BRIDGE_SECRET_FILE) are required");
  const stateDir = env.DORKS_STATE_DIR || join(homedir(), ".dorks-bridge");
  return {
    dorkId,
    bridgeUrl,
    tunnel: env.DORKS_TUNNEL_SERVICE && env.DORKS_TUNNEL_TICKET ? { service: env.DORKS_TUNNEL_SERVICE, ticket: env.DORKS_TUNNEL_TICKET } : null,
    bridgeSecret,
    claudeBin: env.CLAUDE_BIN || "claude",
    claudeExtraArgs: (env.DORKS_CLAUDE_ARGS ?? "").split(/\s+/).filter(Boolean),
    permissionMode: env.DORKS_PERMISSION_MODE || "bypassPermissions",
    runAs: env.CLAUDE_RUN_AS || null,
    gitBaseUrl: (env.DORKS_GIT_BASE_URL || "https://github.com").replace(/\/+$/, ""),
    stateDir,
    sockDir: env.DORKS_SOCK_DIR || runtimeSockDir(env),
    workDir: env.DORKS_WORKDIR || join(homedir(), "work"),
    heartbeatMs: num(env.HEARTBEAT_MS, 30_000),
    deltaBatchMs: num(env.DELTA_BATCH_MS, 150),
    batchMs: num(env.DORKS_BATCH_MS, 50),
    flushIdleWaitMs: num(env.DORKS_FLUSH_IDLE_WAIT_MS, 20_000),
    flushInterruptWaitMs: num(env.DORKS_FLUSH_INTERRUPT_WAIT_MS, 5_000),
    flushSyncWaitMs: num(env.DORKS_FLUSH_SYNC_WAIT_MS, 5_000),
  };
}

/**
 * Variables that must never reach the Claude child (or anything it spawns): the bridge's own identity and the dev host's keys.
 * `DORKS_REAL_GH` is the exception: it tells the gh shim (a child of the CLI) where the real gh is.
 */
export const CHILD_ENV_DENY = [/^BRIDGE_/, /^CLAUDE_RUN_AS$/, /^DORK_ID$/, /^DORKS_(?!REAL_GH$)/, /^SIM_HOST_KEY$/, /^CLAUDE_BIN$/];

/**
 * A directory for the RPC socket that is not under the home directory. A Boat sandbox restored from a snapshot serves `/home/user`
 * lazily through FUSE and, once it is hydrated (about a minute after boot), swaps the real directory in. Files written by path
 * survive the swap, but a socket bound before it does not: the path then names a copied, dead socket file and every connect is
 * refused, so git, `gh`, `dorks` and the hooks lose the bridge. `/run` (tmpfs) is outside the lazy mount; `/tmp` is the fallback.
 */
export function runtimeSockDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? -1;
  // One dir per dork: several bridges under one user (the local simulator with the real bridge) must not share a socket.
  const name = `dorks-bridge-${(env.DORK_ID ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 36) || "default"}`;
  if (uid === 0) return join("/run", name);
  if (env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR)) return join(env.XDG_RUNTIME_DIR, name);
  return join(tmpdir(), `${name}-${uid}`);
}
