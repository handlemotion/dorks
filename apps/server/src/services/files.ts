import { existsSync } from "node:fs";
import { join } from "node:path";
import { rankFiles } from "@dorks/shared";
import { fail, type App } from "../app";
import { clonePath, git } from "../lib/localGit";
import { localRoot } from "../lib/localBox";
import { owned } from "./dorks";

// The repository's files for the composer's `@` menu (docs/architecture.md, "Mentions"): the bridge sends a `git ls-files` listing
// whenever it changes, and the UI searches the last one here, so it works while the box sleeps too.

/** Keeps the bridge's latest listing for a dork. */
export function storeFiles(app: App, dorkId: string, paths: string[], truncated: boolean) {
  app.db.run(
    "INSERT INTO dork_files (dork_id, paths, truncated, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (dork_id) DO UPDATE SET paths = excluded.paths, truncated = excluded.truncated, updated_at = excluded.updated_at",
    dorkId,
    JSON.stringify(paths),
    truncated ? 1 : 0,
    app.now(),
  );
}

export interface FileSearch {
  /** The best matches, best first. */
  files: string[];
  /** False until the box has listed its files once. */
  listed: boolean;
  /** The listing stopped short of the whole tree. */
  truncated: boolean;
}

/** The dork's files that match `query` (`rankFiles`), at most `limit`. */
export function searchFiles(app: App, dorkId: string, query: string, limit = 50): FileSearch {
  owned(app, dorkId);
  const row = app.db.get<{ paths: string; truncated: number }>("SELECT paths, truncated FROM dork_files WHERE dork_id = ?", dorkId);
  if (!row) return { files: [], listed: false, truncated: false };
  const paths = JSON.parse(row.paths) as string[];
  return { files: rankFiles(paths, query.slice(0, 200), Math.min(Math.max(1, limit), 100)), listed: true, truncated: row.truncated === 1 };
}

/** `owner/name`, neither part starting with a dot (so never `..`): it becomes a path under the clones. */
const REPO_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** The bridge sends at most this many paths; a clone's listing is cut the same way. */
const MAX_PATHS = 5000;
const CLONE_TTL_MS = 30_000;
const cloneListings = new Map<string, { at: number; paths: string[]; truncated: boolean }>();

/** The default branch's files in this computer's clone of `repo` (local dorks, docs/local-dorks.md), or null when there is none. */
async function cloneFiles(app: App, repo: string): Promise<{ paths: string[]; truncated: boolean } | null> {
  const clone = clonePath(join(localRoot(app), "repos"), repo);
  const cached = cloneListings.get(clone);
  if (cached && app.now() - cached.at < CLONE_TTL_MS) return cached;
  if (!existsSync(clone)) return null;
  let r = await git(["ls-tree", "-r", "-z", "--name-only", "refs/remotes/origin/HEAD"], clone);
  if (r.code !== 0) r = await git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], clone);
  if (r.code !== 0) return null;
  const all = r.stdout.split("\0").filter(Boolean);
  const listing = { at: app.now(), paths: all.slice(0, MAX_PATHS), truncated: all.length > MAX_PATHS };
  cloneListings.set(clone, listing);
  return listing;
}

/**
 * A repository's files before a session in it exists (the new-session composer's `@` menu): for the owner at this computer, its local
 * clone's default branch (where a local session's worktree starts); otherwise, or with no clone yet, the last listing a session in
 * that repository sent.
 */
export async function searchRepoFiles(app: App, repo: string, query: string, limit: number, local: boolean): Promise<FileSearch> {
  if (!REPO_RE.test(repo)) fail("invalid", "repo must be owner/name");
  const max = Math.min(Math.max(1, limit), 100);
  const q = query.slice(0, 200);
  const clone = local ? await cloneFiles(app, repo) : null;
  if (clone) return { files: rankFiles(clone.paths, q, max), listed: true, truncated: clone.truncated };
  const row = app.db.get<{ paths: string; truncated: number }>(
    "SELECT f.paths, f.truncated FROM dork_files f JOIN dorks d ON d.id = f.dork_id WHERE d.repo = ? COLLATE NOCASE AND d.deleting = 0 ORDER BY f.updated_at DESC LIMIT 1",
    repo,
  );
  if (!row) return { files: [], listed: false, truncated: false };
  return { files: rankFiles(JSON.parse(row.paths) as string[], q, max), listed: true, truncated: row.truncated === 1 };
}
