import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// The GitHub login Dorks acts as is the GitHub CLI's (docs/github.md). This reads it the way `gh` itself resolves it: `GH_TOKEN`,
// then `GITHUB_TOKEN`, then `gh auth token` (the token `gh auth login` saved, in the macOS keychain or gh's config). Nothing is
// copied into Dorks' settings, so `gh auth refresh`, `gh auth switch` or a new login take effect on the next read.

/** Where a GUI-launched process should also look for `gh` (a Finder-launched app has a minimal PATH). */
const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"];
const TIMEOUT_MS = 10_000;

/** The token and where it came from, or why there is none: `gh` is not installed, or it is not signed in. */
export type GhLogin = { token: string; source: "env" | "gh" } | { problem: "gh_missing" | "gh_logged_out" };

export function findGh(pathVar: string | undefined, extra: readonly string[] = EXTRA_DIRS): string | null {
  const dirs = [...(pathVar ? pathVar.split(delimiter) : []), ...extra].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The single line `gh auth token` prints, or null. */
export const parseToken = (stdout: string): string | null => {
  const t = stdout.trim();
  return t && !/\s/.test(t) ? t : null;
};

/** Reads the login from the environment, else from `gh`. Never logs or throws; the token stays in memory. */
export async function readGhLogin(env: NodeJS.ProcessEnv = process.env): Promise<GhLogin> {
  const fromEnv = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const gh = findGh(env.PATH);
  if (!gh) return { problem: "gh_missing" };
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(gh, ["auth", "token", "--hostname", "github.com"], { env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, timeout: TIMEOUT_MS, windowsHide: true }, (err, out) =>
      resolve(err ? null : String(out)),
    );
  });
  const token = stdout === null ? null : parseToken(stdout);
  return token ? { token, source: "gh" } : { problem: "gh_logged_out" };
}
