import { createHash } from "node:crypto";
import { MAX_FILE_BYTES, MAX_FILE_PATHS } from "@dorks/shared";
import { gitEnv, runGit } from "./git";
import type { Identity } from "./runas";

// The repository's files for the composer's `@` menu (docs/architecture.md, "Mentions"): `git ls-files` in the agent's working tree,
// tracked and untracked but never ignored ones, read again every few seconds and sent only when the listing changed.

export interface FileListing {
  paths: string[];
  truncated: boolean;
}

/** `git ls-files -z` output as paths, capped by count and bytes. Directories first by depth is the UI's job; this keeps git's order. */
export function parseListing(stdout: string): FileListing {
  const all = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  let bytes = 0;
  for (const p of all) {
    if (p.length > 1024) continue;
    if (paths.length >= MAX_FILE_PATHS || bytes + p.length + 3 > MAX_FILE_BYTES) return { paths, truncated: true };
    paths.push(p);
    bytes += Buffer.byteLength(p) + 3;
  }
  return { paths, truncated: false };
}

export class FileWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private busy = false;

  constructor(private o: { dir: string; baseEnv: NodeJS.ProcessEnv; runAs: Identity | null; send: (listing: FileListing) => void; everyMs?: number }) {}

  start() {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.o.everyMs ?? 15_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lists the tree and sends it when it differs from what was last sent. Best effort: a failed listing sends nothing. */
  async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], this.o.dir, gitEnv(this.o.baseEnv, this.o.runAs), this.o.runAs, 20_000);
      if (r.code !== 0) return;
      const listing = parseListing(r.stdout);
      const digest = createHash("sha256").update(JSON.stringify(listing)).digest("hex");
      if (digest === this.last) return;
      this.last = digest;
      this.o.send(listing);
    } finally {
      this.busy = false;
    }
  }
}
