import { execFile } from "node:child_process";
import { findRealGh } from "./gh-shim";
import type { BranchPrStatus } from "./work-scan";

const LOOKUP_TIMEOUT_MS = 10_000;

interface GhPrRow {
  number?: unknown;
  state?: unknown;
  headRefOid?: unknown;
}

/**
 * Pull request status for a branch: the real `gh`, authenticated with the bridge's own token (what the shim would do for the agent,
 * without the round trip through the socket). Returns `{ state: "open" }` when any PR for the branch is open, the latest merged or
 * closed PR (with its head SHA so callers can tell whether newer commits were pushed after it ended), `{ state: "none" }` when no PR
 * exists, or null when it cannot be told (no gh, no token, no network, a remote not on GitHub).
 */
export function prLookup(env: NodeJS.ProcessEnv, self: string, token: () => string | null) {
  return (repo: string, branch: string): Promise<BranchPrStatus | null> =>
    new Promise((resolve) => {
      let gh: string | null = null;
      try {
        gh = findRealGh(env, self);
      } catch {
        /* `self` is not a file: no gh to find */
      }
      const t = token();
      if (!gh || !t) return resolve(null);
      const args = ["pr", "list", "-R", repo, `--head=${branch}`, "--state", "all", "--limit", "10", "--json", "number,state,headRefOid"];
      const ghEnv = { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: t, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
      execFile(gh, args, { env: ghEnv, timeout: LOOKUP_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(String(stdout));
          if (!Array.isArray(list)) return resolve(null);
          if (list.length === 0) return resolve({ state: "none" });
          const rows = list as GhPrRow[];
          if (rows.some((r) => typeof r.state === "string" && r.state.toUpperCase() === "OPEN")) return resolve({ state: "open" });
          const latest = rows[0];
          if (typeof latest?.number !== "number") return resolve(null);
          const state = typeof latest.state === "string" && latest.state.toUpperCase() === "MERGED" ? "merged" : "closed";
          const headSha = typeof latest.headRefOid === "string" && latest.headRefOid ? latest.headRefOid : null;
          resolve({ state, number: latest.number, headSha });
        } catch {
          resolve(null);
        }
      });
    });
}
