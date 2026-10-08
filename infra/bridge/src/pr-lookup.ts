import { execFile } from "node:child_process";
import { findRealGh } from "./gh-shim";

const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Whether a pull request (any state) has the branch as its head: the real `gh`, authenticated with the bridge's own token (what the shim
 * would do for the agent, without the round trip through the socket). null when it cannot be told: no gh, no token, no network, a
 * remote that is not on GitHub.
 */
export function prLookup(env: NodeJS.ProcessEnv, self: string, token: () => string | null) {
  return (repo: string, branch: string): Promise<boolean | null> =>
    new Promise((resolve) => {
      let gh: string | null = null;
      try {
        gh = findRealGh(env, self);
      } catch {
        /* `self` is not a file: no gh to find */
      }
      const t = token();
      if (!gh || !t) return resolve(null);
      const args = ["pr", "list", "-R", repo, `--head=${branch}`, "--state", "all", "--limit", "1", "--json", "number"];
      const ghEnv = { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: t, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
      execFile(gh, args, { env: ghEnv, timeout: LOOKUP_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(String(stdout));
          resolve(Array.isArray(list) ? list.length > 0 : null);
        } catch {
          resolve(null);
        }
      });
    });
}
