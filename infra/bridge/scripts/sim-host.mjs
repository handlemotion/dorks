// Glue for infra/bridge-sim/host.mjs (BRIDGE_IMPL=real): builds the bundle, provisions a local git "remote" for the repos the e2e
// uses, and hands back how to launch one real bridge per sim box. Dev/test only; the production box starts `dorks-bridge` itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeClaude = join(here, "../test/fixtures/fake-claude.mjs");
const fakeOpencode = join(here, "../test/fixtures/fake-opencode.mjs");

/** @param {{ repos?: string[] }} [opts] */
export function prepareRealBridge({ repos = ["jaantonio/demo"] } = {}) {
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
  return {
    cli: join(here, "../dist/cli.mjs"),
    /** Env for one bridge process: only what a real box provides (plus test knobs). No host keys. */
    envFor(dorkId, bridgeSecret, bridgeUrl) {
      const short = dorkId.slice(-12);
      return {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Outbound proxy / extra CA for hosts that need them to reach Anthropic (CI and sandboxes often do).
        ...Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
        DORK_ID: dorkId,
        BRIDGE_URL: bridgeUrl,
        BRIDGE_SECRET: bridgeSecret,
        CLAUDE_BIN: process.env.CLAUDE_BIN || fakeClaude,
        DORKS_GIT_BASE_URL: `file://${remotes}`,
        DORKS_STATE_DIR: join(root, "state", short), // survives a "pause" (killed process), like a paused box's disk
        DORKS_WORKDIR: join(root, "work", short),
        CLAUDE_CONFIG_DIR: join(root, "claude", short), // session transcripts: like the box disk, they survive a "pause"
        OPENCODE_BIN: process.env.OPENCODE_BIN || fakeOpencode, // for dorks whose engine is opencode
        XDG_DATA_HOME: join(root, "xdg-data", short), // OpenCode's session database, per box like the transcripts
        HEARTBEAT_MS: process.env.HEARTBEAT_MS,
        DELTA_BATCH_MS: process.env.DELTA_BATCH_MS,
      };
    },
  };
}
