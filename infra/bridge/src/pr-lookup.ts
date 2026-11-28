import { execFile } from "node:child_process";
import { findRealGh } from "./gh-shim";
import type { BranchPrStatus } from "./work-scan";

const LOOKUP_TIMEOUT_MS = 10_000;

interface GhPrRow {
  number?: unknown;
  state?: unknown;
  headRefOid?: unknown;
  url?: unknown;
  baseRefName?: unknown;
  mergedAt?: unknown;
  closedAt?: unknown;
  isCrossRepository?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Pull request status for a branch: the real `gh`, authenticated with the bridge's own token (what the shim would do for the agent,
 * without the round trip through the socket). Returns `{ state: "open" }` when any PR for the branch is open, the latest merged or
 * closed PR (with its head SHA so callers can tell whether newer commits were pushed after it ended), `{ state: "none" }` when no PR
 * exists, or null when it cannot be told (no gh, no token, no network, a remote not on GitHub). An ended PR also carries its URL, base
 * branch and when it ended, when gh says. PRs from forks that happen to use the same branch name are not this branch's.
 */
export function prLookup(env: NodeJS.ProcessEnv, self: string, token: () => string | null) {
  return (repo: string, branch: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<BranchPrStatus | null> =>
    new Promise((resolve) => {
      let gh: string | null = null;
      try {
        gh = findRealGh(env, self);
      } catch {
        /* `self` is not a file: no gh to find */
      }
      const t = token();
      if (!gh || !t) return resolve(null);
      const args = ["pr", "list", "-R", repo, `--head=${branch}`, "--state", "all", "--limit", "10", "--json", "number,state,headRefOid,url,baseRefName,mergedAt,closedAt,isCrossRepository"];
      const ghEnv = { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: t, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
      execFile(gh, args, { env: ghEnv, timeout: timeoutMs }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(String(stdout));
          if (!Array.isArray(list)) return resolve(null);
          const rows = (list as GhPrRow[]).filter((r) => r?.isCrossRepository !== true);
          if (rows.length === 0) return resolve({ state: "none" });
          if (rows.some((r) => typeof r.state === "string" && r.state.toUpperCase() === "OPEN")) return resolve({ state: "open" });
          const latest = rows[0];
          if (typeof latest?.number !== "number") return resolve(null);
          const state = typeof latest.state === "string" && latest.state.toUpperCase() === "MERGED" ? "merged" : "closed";
          const headSha = typeof latest.headRefOid === "string" && latest.headRefOid ? latest.headRefOid : null;
          const [url, base, at] = [str(latest.url), str(latest.baseRefName), str(state === "merged" ? latest.mergedAt : latest.closedAt)];
          resolve({ state, number: latest.number, headSha, ...(url ? { url } : {}), ...(base ? { base } : {}), ...(at ? { at } : {}) });
        } catch {
          resolve(null);
        }
      });
    });
}
