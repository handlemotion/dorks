// Customer sandbox snapshots (docs/snapshots.md). Pure logic shared by the Convex functions, the provider and the tests:
// limits, validation, the script that runs inside the build box, log redaction and the "which snapshot does a new dork boot from" rule.

export const MAX_SETUP_SCRIPT_BYTES = 16 * 1024;
export const MAX_IMAGES_PER_USER = 10;
/** Builds start billable boxes, so they are capped per rolling 24 hours (all of the user's images together). */
export const MAX_BUILDS_PER_DAY = 10;
export const DEFAULT_BUILD_TIMEOUT_MIN = 20;
export const MIN_BUILD_TIMEOUT_MIN = 2;
export const MAX_BUILD_TIMEOUT_MIN = 30;
export const LOG_TAIL_CHARS = 8_000;
/** Where the runner, its log and its exit code live in the build box. Removed again before the snapshot is taken. */
export const BUILD_DIR = "/tmp/dorks-build";

export type ScriptPoll = { state: "running"; log: string } | { state: "done"; exitCode: number; log: string } | { state: "lost"; log: string };
export type SnapshotStatus = "creating" | "ready" | "error" | "missing";

/**
 * What the build needs from a sandbox provider, on top of BoxProvider (create/delete). Every call is safe to repeat: the build is
 * driven by scheduled steps that can be retried after a crash. Implemented by lib/upstash.ts, with a stand-in for BOX_PROVIDER=sim.
 */
export interface SnapshotBuilder {
  /** A box restored from `baseSnapshotId` with no env, no init command and no network policy (the setup script may need any host). Idempotent on `name`. */
  createBuildBox(baseSnapshotId: string, opts: { name: string }): Promise<{ id: string }>;
  /** The build box created for `name`, if any (used to clean up after a crash between creating the box and recording its id). */
  findBuildBox(name: string): Promise<string | null>;
  /** Writes files (absolute paths) into the box, owned by the box user, with the given mode. */
  putFiles(boxId: string, files: { path: string; content: string; secret?: boolean }[]): Promise<void>;
  /** Starts `BUILD_DIR/run.sh` detached (survives the request that starts it). A second call while it runs does nothing. */
  startRunner(boxId: string): Promise<void>;
  /** Progress of the detached runner. "lost" = the runner is gone without having written an exit code (box restarted or killed). */
  pollRunner(boxId: string): Promise<ScriptPoll>;
  /** A short command to completion in the build box. */
  check(boxId: string, command: string): Promise<{ exitCode: number; output: string }>;
  /** Starts the snapshot (idempotent on `name`: the existing one is returned) without waiting for it. */
  startSnapshot(boxId: string, name: string): Promise<{ id: string }>;
  snapshotStatus(boxId: string, snapshotId: string): Promise<SnapshotStatus>;
  /** Idempotent: deleting a missing snapshot is not an error. */
  deleteSnapshot(snapshotId: string): Promise<void>;
  /** Whether the account still has this snapshot and it is ready to restore (a deleted one answers 400/404 when restored, with no useful status). */
  snapshotReady(snapshotId: string): Promise<boolean>;
}

const unconfigured = () => {
  throw new Error("box provider not configured (UPSTASH_BOX_API_KEY)");
};
export const unconfiguredBuilder: SnapshotBuilder = {
  createBuildBox: unconfigured, findBuildBox: unconfigured, putFiles: unconfigured, startRunner: unconfigured, pollRunner: unconfigured,
  check: unconfigured, startSnapshot: unconfigured, snapshotStatus: unconfigured, deleteSnapshot: unconfigured, snapshotReady: unconfigured,
};

// ---------------------------------------------------------------- validation

/** Returns an error message, or null if the script is acceptable. */
export function validateSetupScript(script: string): string | null {
  if (!script.trim()) return "setup script is empty";
  if (new TextEncoder().encode(script).length > MAX_SETUP_SCRIPT_BYTES) return `setup script is larger than ${MAX_SETUP_SCRIPT_BYTES / 1024} KB`;
  if (script.includes("\0")) return "setup script contains a NUL byte";
  return null;
}

export const clampTimeoutMinutes = (m: number | undefined) =>
  m === undefined || !Number.isFinite(m) ? DEFAULT_BUILD_TIMEOUT_MIN : Math.min(Math.max(Math.round(m), MIN_BUILD_TIMEOUT_MIN), MAX_BUILD_TIMEOUT_MIN);

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What makes two builds of one image equivalent: the script and the timeout do not change the result, the script text does. */
export const scriptHash = (script: string) => sha256Hex(script.replace(/\r\n/g, "\n"));

// ---------------------------------------------------------------- the build script

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Tools the agent needs. The runner records where they resolve before the customer's script runs; `verifyScript` compares afterwards. */
export const TOOLS = ["node", "git", "claude", "dorks-bridge", "dorks", "gh"] as const;

/**
 * `BUILD_DIR/run.sh`: clones the repo (read-only token from `BUILD_DIR/gh-token` if the user has the GitHub App; anonymous otherwise,
 * which only works for public repos), deletes the token, then runs the customer's `BUILD_DIR/setup.sh` in the repo. The exit code lands
 * in `BUILD_DIR/exit` (written last, atomically) whatever happens. The customer's script never sees the token.
 */
export function runnerScript(repo: string): string {
  return `#!/bin/bash
D=${BUILD_DIR}
finish() { c=$?; echo "$c" > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"; }
trap finish EXIT
echo $$ > "$D/pid"
set -uo pipefail
export GIT_TERMINAL_PROMPT=0 CI=1 DEBIAN_FRONTEND=noninteractive DORKS_BUILD=1 DORKS_REPO=${shq(repo)}
mkdir -p "$HOME/work"
for t in ${TOOLS.join(" ")}; do p=$(type -P "$t" 2>/dev/null || true); echo "$t=$p"; done > "$D/tools.before"
echo ${shq(`==> [dorks] cloning ${repo}`)}
mkdir -p "$HOME/work/$(dirname ${shq(repo)})"
if [ -f "$D/gh-token" ]; then
  git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat ${BUILD_DIR}/gh-token)"; }; f' clone --quiet ${shq(`https://github.com/${repo}.git`)} "$HOME/work/"${shq(repo)}
  c=$?
else
  git clone --quiet ${shq(`https://github.com/${repo}.git`)} "$HOME/work/"${shq(repo)}
  c=$?
fi
rm -f "$D/gh-token"
if [ "$c" != 0 ]; then echo "==> [dorks] git clone failed (exit $c); is the repo public, or is the GitHub App installed on it?"; exit "$c"; fi
cd "$HOME/work/"${shq(repo)}
echo "==> [dorks] running the setup script in $(pwd)"
bash -e -o pipefail "$D/setup.sh"
c=$?
echo "==> [dorks] setup script exited with $c"
exit "$c"
`;
}

/** Starts the runner detached: the pidfile lets `pollRunner` tell "still running" from "died without an exit code". */
export const startRunnerCommand = `mkdir -p ${BUILD_DIR}; if [ -f ${BUILD_DIR}/pid ] && kill -0 "$(cat ${BUILD_DIR}/pid)" 2>/dev/null; then exit 0; fi; if [ -f ${BUILD_DIR}/exit ]; then exit 0; fi; nohup setsid bash ${BUILD_DIR}/run.sh >>${BUILD_DIR}/log 2>&1 </dev/null & for _ in $(seq 50); do [ -f ${BUILD_DIR}/pid ] && exit 0; sleep 0.1; done; exit 1`;

export const pollCommand = `D=${BUILD_DIR}; if [ -f $D/exit ]; then echo "STATE:done:$(cat $D/exit)"; elif [ -f $D/pid ] && kill -0 "$(cat $D/pid)" 2>/dev/null; then echo "STATE:running"; else echo "STATE:lost"; fi; tail -c ${LOG_TAIL_CHARS} $D/log 2>/dev/null`;

export function parsePoll(output: string): ScriptPoll {
  const nl = output.indexOf("\n");
  const head = nl < 0 ? output : output.slice(0, nl);
  const log = redactLog(nl < 0 ? "" : output.slice(nl + 1));
  const m = /^STATE:(running|lost|done:(-?\d+))$/.exec(head.trim());
  if (!m) return { state: "lost", log };
  if (m[1] === "running") return { state: "running", log };
  if (m[1] === "lost") return { state: "lost", log };
  return { state: "done", exitCode: Number(m[2]), log };
}

/** Credentials that must never be baked into a snapshot (snapshots are restored into other people's agents' boxes: the user's own, but still). */
const SECRET_REGEX = "(ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----";

/**
 * After the customer's script succeeded: the agent's toolchain still resolves where it did before (a script that removes or shadows
 * node/claude/dorks-bridge/gh would give a box whose agent never starts), and no credential was left in the home directory or in a
 * git remote. Prints only paths. Exit 0 = fine; otherwise the output says what is wrong.
 */
export const verifyScript = `D=${BUILD_DIR}
bad=0
for t in ${TOOLS.join(" ")}; do
  want=$(sed -n "s/^$t=//p" $D/tools.before)
  now=$(type -P "$t" 2>/dev/null || true)
  if [ -n "$want" ] && [ "$want" != "$now" ]; then echo "tool changed: $t was $want, now \${now:-missing}"; bad=1; fi
done
hits=$(grep -rIlE ${shq(SECRET_REGEX)} "$HOME" /workspace/home --exclude-dir=node_modules --exclude-dir=.cache --exclude-dir=.npm --exclude-dir=.pnpm-store --exclude-dir=work --exclude-dir=.box-internal 2>/dev/null | grep -vxF -e "$HOME/.git-credentials" -e "$HOME/.config/gh/hosts.yml" | head -5)
if [ -n "$hits" ]; then echo "a credential was written to the filesystem; it would be baked into the snapshot:"; echo "$hits"; bad=1; fi
for g in $(find "$HOME/work" -maxdepth 4 -name config -path '*/.git/config' 2>/dev/null); do
  if grep -qE 'url *= *https?://[^/ ]*@|extraheader|http\\.proxy' "$g"; then echo "git remote with credentials: $g"; bad=1; fi
done
exit $bad`;

/** `command` as one argument for `sh -c`: the scripts above use bash features (`type -P`). */
export const bashCommand = (script: string) => `bash -c ${shq(script)}`;

/**
 * Run just before the snapshot: leave no trace of the build, so the snapshot is the repo, its dependencies and whatever the script installed.
 * Upstash writes a GitHub token into every box at start (~/.git-credentials, ~/.config/gh/hosts.yml); it is rewritten on each restore,
 * so the stale copy is removed here instead of being baked into the snapshot, and the credential scan above ignores those two files.
 */
export const cleanupScript = `rm -rf ${BUILD_DIR} "$HOME"/.dorks* /tmp/dorks-* "$HOME/.git-credentials" "$HOME/.config/gh/hosts.yml" 2>/dev/null; sync; true`;

/** Best-effort scrubbing of what the setup script printed before it is stored: tokens and key blocks never go in the database. */
export function redactLog(text: string): string {
  return text
    .replace(/(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .slice(-LOG_TAIL_CHARS);
}

// ---------------------------------------------------------------- which snapshot does a new box boot from

export type ImageChoice = { snapshotId: string; source: "repo" | "account" | "base" };

/**
 * Most specific first: the account's ready image for this exact repo (never another repo's), then the account's own base
 * `userSettings.workstationSnapshotId`, then the deployment's base snapshot (`BASE_SNAPSHOT_ID`, not used with Upstash). An image without a ready
 * snapshot (never built, first build still running or failed) is skipped, so a broken or slow build never blocks creating dorks.
 */
export function pickSnapshot(o: {
  repo: string;
  images: { repo: string; snapshotId?: string | null }[];
  accountSnapshotId?: string | null;
  baseSnapshotId?: string | null;
}): ImageChoice | null {
  const repo = o.repo.toLowerCase();
  const ready = (r: string) => o.images.find((i) => i.repo === r && i.snapshotId)?.snapshotId ?? null;
  const exact = ready(repo);
  if (exact) return { snapshotId: exact, source: "repo" };
  if (o.accountSnapshotId) return { snapshotId: o.accountSnapshotId, source: "account" };
  if (o.baseSnapshotId) return { snapshotId: o.baseSnapshotId, source: "base" };
  return null;
}

export type OutdatedReason = "script_changed" | "base_changed";

/** Why a ready image no longer matches what would be built now (it is still used until rebuilt). Null = current. */
export function outdatedReason(o: { builtScriptHash?: string | null; builtBaseSnapshotId?: string | null; scriptHash: string; currentBaseSnapshotId?: string | null }): OutdatedReason | null {
  if (o.builtScriptHash !== o.scriptHash) return "script_changed";
  if (o.currentBaseSnapshotId && o.builtBaseSnapshotId !== o.currentBaseSnapshotId) return "base_changed";
  return null;
}
