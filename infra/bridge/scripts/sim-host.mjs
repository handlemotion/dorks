// Glue for infra/bridge-sim/host.mjs (BRIDGE_IMPL=real): builds the bundle, provisions a local git "remote" for the repos the e2e
// uses, and hands back how to launch one real bridge per sim box. Dev/test only; the production box starts `dorks-bridge` itself.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeClaude = join(here, "../test/fixtures/fake-claude.mjs");

/** @param {{ repos?: string[] }} [opts] */
export function prepareRealBridge({ repos = ["acme/demo"] } = {}) {
  execFileSync(process.execPath, [join(here, "build.mjs")], { stdio: "inherit" });
  const root = process.env.DORKS_E2E_ROOT || mkdtempSync(join(tmpdir(), "dorks-bridge-e2e-"));
  const remotes = join(root, "remote");
  const id = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@e2e", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@e2e" };
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, ...id } });
  for (const repo of repos) {
    const bare = join(remotes, `${repo}.git`);
    if (existsSync(bare)) continue;
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "--initial-branch=main");
    const seed = mkdtempSync(join(root, "seed-"));
    git(seed, "init", "--initial-branch=main");
    writeFileSync(join(seed, "README.md"), `# ${repo}\n`);
    git(seed, "add", ".");
    git(seed, "commit", "-m", "init");
    git(seed, "push", bare, "main");
    rmSync(seed, { recursive: true, force: true });
  }
  mkdirSync(join(root, "gitconfig"), { recursive: true }); // one global git config per simulated box (envFor)
  // Git refuses a local remote owned by another user, so with CLAUDE_RUN_AS the stand-in for GitHub belongs to that user.
  // Its per-box CLAUDE_CONFIG_DIR (below) must be creatable by that user too, and it must be able to traverse to the settings and
  // MCP files in each box's state dir (the bridge makes the state dir itself 0711, not its parent).
  if (process.env.CLAUDE_RUN_AS) {
    chmodSync(root, 0o711); // a mkdtemp root is 0700: the user must traverse it to reach its own dirs
    mkdirSync(join(root, "claude"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    chmodSync(join(root, "state"), 0o711);
    execFileSync("chown", ["-R", process.env.CLAUDE_RUN_AS, remotes, join(root, "claude"), join(root, "gitconfig")]);
  }
  return {
    cli: join(here, "../dist/cli.mjs"),
    /** Env for one bridge process: only what a real box provides (plus test knobs). No host keys. */
    envFor(dorkId, bridgeSecret, bridgeUrl) {
      const short = dorkId.slice(-12);
      return {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // The bridge writes `git config --global` (credential helper, identity), right in a box but not on this host: give each
        // simulated box its own global git config so a test run never touches the developer's ~/.gitconfig.
        GIT_CONFIG_GLOBAL: join(root, "gitconfig", short),
        // Outbound proxy / extra CA for hosts that need them to reach Anthropic (CI and sandboxes often do).
        ...Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
        DORK_ID: dorkId,
        BRIDGE_URL: bridgeUrl,
        BRIDGE_SECRET: bridgeSecret,
        CLAUDE_BIN: process.env.CLAUDE_BIN || fakeClaude,
        // A host running as root (a CI or cloud container) needs privilege separation for the real CLI, which refuses
        // bypassPermissions as root: CLAUDE_RUN_AS=<unprivileged user> passes through, like a box configured for it.
        ...(process.env.CLAUDE_RUN_AS ? { CLAUDE_RUN_AS: process.env.CLAUDE_RUN_AS } : {}),
        DORKS_GIT_BASE_URL: `file://${remotes}`,
        DORKS_STATE_DIR: join(root, "state", short), // survives a "pause" (killed process), like a paused box's disk
        DORKS_WORKDIR: join(root, "work", short),
        CLAUDE_CONFIG_DIR: join(root, "claude", short), // session transcripts: like the box disk, they survive a "pause"
        HEARTBEAT_MS: process.env.HEARTBEAT_MS,
        DELTA_BATCH_MS: process.env.DELTA_BATCH_MS,
      };
    },
  };
}
