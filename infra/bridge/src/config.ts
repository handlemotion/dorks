import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the bridge reads from its own environment. The box provides the first three; the rest are optional knobs. */
export interface Config {
  dorkId: string;
  bridgeUrl: string;
  /** Never logged, never forwarded to the Claude child. */
  bridgeSecret: string;
  claudeBin: string;
  /** Appended to the claude argv (space separated). Escape hatch, e.g. `--model sonnet`. */
  claudeExtraArgs: string[];
  permissionMode: string;
  /** Base URL repos are cloned from: `<gitBaseUrl>/<owner>/<repo>.git`. */
  gitBaseUrl: string;
  /** Holds the credential socket + the dedupe journal. Not secrets at rest: the token only ever lives in memory. */
  stateDir: string;
  workDir: string;
  heartbeatMs: number;
  deltaBatchMs: number;
  batchMs: number;
  flushIdleWaitMs: number;
  flushInterruptWaitMs: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { DORK_ID: dorkId, BRIDGE_URL: bridgeUrl, BRIDGE_SECRET: bridgeSecret } = env;
  if (!dorkId || !bridgeUrl || !bridgeSecret) throw new Error("DORK_ID, BRIDGE_URL and BRIDGE_SECRET are required");
  const stateDir = env.DORKS_STATE_DIR || join(homedir(), ".dorks-bridge");
  return {
    dorkId,
    bridgeUrl,
    bridgeSecret,
    claudeBin: env.CLAUDE_BIN || "claude",
    claudeExtraArgs: (env.DORKS_CLAUDE_ARGS ?? "").split(/\s+/).filter(Boolean),
    permissionMode: env.DORKS_PERMISSION_MODE || "bypassPermissions",
    gitBaseUrl: (env.DORKS_GIT_BASE_URL || "https://github.com").replace(/\/+$/, ""),
    stateDir,
    workDir: env.DORKS_WORKDIR || join(homedir(), "work"),
    heartbeatMs: num(env.HEARTBEAT_MS, 30_000),
    deltaBatchMs: num(env.DELTA_BATCH_MS, 150),
    batchMs: num(env.DORKS_BATCH_MS, 50),
    flushIdleWaitMs: num(env.DORKS_FLUSH_IDLE_WAIT_MS, 20_000),
    flushInterruptWaitMs: num(env.DORKS_FLUSH_INTERRUPT_WAIT_MS, 5_000),
  };
}

/** Variables that must never reach the Claude child (or anything it spawns): the bridge's own identity and the dev host's keys. */
export const CHILD_ENV_DENY = [/^BRIDGE_/, /^DORK_ID$/, /^DORKS_/, /^SIM_HOST_KEY$/, /^CONVEX_/, /^CLAUDE_BIN$/];
