import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// What a local dork runs with (docs/local-dorks.md): the owner's own Node.js (the bridge is a Node script) and agent CLIs. A Finder-launched
// app gets a minimal PATH, so the owner's login shell is asked for theirs once, and the usual install directories are added after it.

const LOGIN_PATH_MS = 5_000;
const MARK = "__DORKS_PATH__";

const extraDirs = () => {
  const home = homedir();
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".bun", "bin"), join(home, ".volta", "bin"), "/usr/bin", "/bin"];
};

/** The PATH of the owner's login shell, or "" when it cannot be read in time. */
function loginShellPath(): Promise<string> {
  if (process.platform === "win32") return Promise.resolve("");
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `printf '${MARK}%s' "$PATH"`], { timeout: LOGIN_PATH_MS, env: { HOME: homedir(), USER: process.env.USER, SHELL: shell, TERM: "dumb" } }, (err, out) => {
      const s = String(out ?? "");
      const at = s.lastIndexOf(MARK);
      resolve(at < 0 ? "" : s.slice(at + MARK.length).trim());
    });
  });
}

const unique = (parts: string[]) => [...new Set(parts.filter(Boolean))].join(delimiter);

let cached: Promise<string> | undefined;
/** The PATH local bridges and agents run with: the server's own, the login shell's, then the usual install directories. */
export function localPath(): Promise<string> {
  cached ??= loginShellPath().then((login) => unique([...(process.env.PATH ?? "").split(delimiter), ...login.split(delimiter), ...extraDirs()]));
  return cached;
}

/** The first executable `name` on `path`, or null. */
export function findOn(path: string, name: string): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The CLI each agent is run as, on the owner's computer. */
export const AGENT_BINS: Record<string, string> = { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "agy" };
export const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity" };

export interface LocalTools {
  path: string;
  /** `DORKS_NODE_BIN`, else `node` on the local PATH. */
  node: string | null;
  gh: string | null;
}

export async function localTools(nodeBin?: string): Promise<LocalTools> {
  const path = await localPath();
  return { path, node: nodeBin || findOn(path, "node"), gh: findOn(path, "gh") };
}

/** Node's major version, or null when it cannot be run. */
export function nodeMajor(node: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(node, ["--version"], { timeout: LOGIN_PATH_MS }, (err, out) => {
      const m = /^v(\d+)\./.exec(String(out ?? "").trim());
      resolve(err || !m ? null : Number(m[1]));
    });
  });
}
