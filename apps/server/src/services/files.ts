import { rankFiles } from "@dorks/shared";
import type { App } from "../app";
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
