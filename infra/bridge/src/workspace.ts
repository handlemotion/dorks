import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
  MAX_TREE_PATHS,
  validRootId,
  validWorkspacePath,
  type WorkspaceFile,
  type WorkspaceGitStatus,
  type WorkspaceRoot,
  type WorkspaceTree,
} from "@dorks/shared";
import { gitEnv, runGit } from "./git";
import type { Identity } from "./runas";

// The Files tab of Chat details (docs/architecture.md, "Files"): the server asks with a `call` frame, this answers. Every git checkout in
// the work directory (the session's repository at `owner/name`, a build's, one the agent cloned beside it) is a root; inside one,
// the owner lists the files, reads one and writes one back. Paths are checked twice: by shape (validWorkspacePath), then resolved,
// symlinks and all, so nothing outside the checkout (or in its .git) is ever read or written. Writes only replace files that exist,
// in place, so the agent's user keeps owning them.

export class WorkspaceError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** At most this many checkouts are offered. */
const MAX_ROOTS = 50;
const GIT_TIMEOUT_MS = 20_000;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const isRepo = (dir: string) => existsSync(join(dir, ".git"));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** `owner/name` of a GitHub remote URL (https or ssh), else undefined. */
export function githubName(url: string): string | undefined {
  const m = /github\.com[/:]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

/** `git status --porcelain=v1 -z` as the tree's marks: the newest path of a rename, untracked files included. */
export function parseStatus(stdout: string): WorkspaceTree["status"] {
  const out: WorkspaceTree["status"] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    let status: WorkspaceGitStatus;
    if (xy === "??") status = "untracked";
    else if (xy.includes("R") || xy.includes("C")) {
      status = "renamed";
      i++; // the original path follows
    } else if (xy.includes("D")) status = "deleted";
    else if (xy.includes("A")) status = "added";
    else status = "modified";
    out.push({ path, status });
  }
  return out;
}

export class Workspace {
  constructor(private o: { workDir: string; primary: () => string | null; baseEnv: NodeJS.ProcessEnv; runAs: Identity | null }) {}

  private git(args: string[], cwd: string) {
    return runGit(args, cwd, gitEnv(this.o.baseEnv, this.o.runAs), this.o.runAs, GIT_TIMEOUT_MS);
  }

  /** The checkouts: the work directory itself, then one and two levels under it, skipping hidden directories and unfinished clones. */
  private candidates(): string[] {
    const { workDir } = this.o;
    const found: string[] = [];
    if (isRepo(workDir)) found.push(".");
    const dirs = (rel: string) => {
      try {
        return readdirSync(join(workDir, rel), { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.endsWith(".cloning"))
          .map((d) => (rel ? `${rel}/${d.name}` : d.name))
          .sort();
      } catch {
        return [];
      }
    };
    for (const one of dirs("")) {
      if (found.length >= MAX_ROOTS) break;
      if (isRepo(join(workDir, one))) {
        found.push(one);
        continue;
      }
      for (const two of dirs(one)) if (found.length < MAX_ROOTS && isRepo(join(workDir, two))) found.push(two);
    }
    return found;
  }

  async roots(): Promise<WorkspaceRoot[]> {
    const primary = this.o.primary();
    const primaryReal = primary ? real(primary) : null;
    const roots = await Promise.all(
      this.candidates().map(async (id): Promise<WorkspaceRoot> => {
        const dir = join(this.o.workDir, id);
        const [branch, origin] = await Promise.all([this.git(["symbolic-ref", "--short", "-q", "HEAD"], dir), this.git(["remote", "get-url", "origin"], dir)]);
        const name = (origin.code === 0 && githubName(origin.stdout)) || (id === "." ? "work" : id);
        return { id, name, ...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}), primary: !!primaryReal && real(dir) === primaryReal };
      }),
    );
    // The session's own repository first, then by name.
    return roots.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  }

  /** The checkout a root id names, resolved; `not_found` unless it is one of the work directory's checkouts. */
  private rootDir(id: unknown): string {
    if (!validRootId(id)) throw new WorkspaceError("invalid", "Not a repository in this sandbox.");
    const work = real(this.o.workDir);
    const dir = real(join(this.o.workDir, id));
    if (!work || !dir || !isRepo(dir) || (dir !== work && !dir.startsWith(work + sep))) throw new WorkspaceError("not_found", "That repository is not in this sandbox.");
    return dir;
  }

  /** A file inside a root, resolved through any symlinks; it must stay inside the root and out of its .git. */
  private filePath(rootId: unknown, path: unknown): string {
    const dir = this.rootDir(rootId);
    if (!validWorkspacePath(path)) throw new WorkspaceError("invalid", "Not a file path.");
    const p = real(join(dir, path));
    if (!p) throw new WorkspaceError("not_found", "That file is not there any more.");
    const inside = p.startsWith(dir + sep) ? p.slice(dir.length + 1) : null;
    if (inside === null || inside.split(sep).includes(".git")) throw new WorkspaceError("invalid", "That file is outside the repository.");
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new WorkspaceError("not_found", "That file is not there any more.");
    }
    if (!st.isFile()) throw new WorkspaceError("invalid", "Not a file.");
    return p;
  }

  async tree(rootId: unknown): Promise<WorkspaceTree> {
    const dir = this.rootDir(rootId);
    const [ls, st] = await Promise.all([
      this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], dir),
      this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dir),
    ]);
    if (ls.code !== 0) throw new WorkspaceError("not_found", "Could not list that repository.");
    const all = ls.stdout.split("\0").filter((p) => p && p.length <= 1024);
    const paths = all.slice(0, MAX_TREE_PATHS);
    return { root: rootId as string, paths, truncated: all.length > paths.length, status: st.code === 0 ? parseStatus(st.stdout).slice(0, MAX_TREE_PATHS) : [] };
  }

  read(rootId: unknown, path: unknown): WorkspaceFile {
    const p = this.filePath(rootId, path);
    const base = { root: rootId as string, path: path as string };
    const size = statSync(p).size;
    if (size > MAX_FILE_READ_BYTES) return { ...base, kind: "too_large", size };
    const buf = readFileSync(p);
    const head = buf.subarray(0, 8000);
    const contents = buf.toString("utf8");
    // NUL bytes, or bytes that are not UTF-8 (they would not survive a round trip through the editor).
    if (head.includes(0) || (contents.includes("\uFFFD") && !Buffer.from(contents, "utf8").equals(buf))) return { ...base, kind: "binary", size: buf.length };
    return { ...base, kind: "text", contents, sha: sha256(buf), size: buf.length };
  }

  /** Replaces an existing file's contents. `sha`: the version it was edited from; a different one on disk is a `conflict`. */
  write(rootId: unknown, path: unknown, contents: unknown, sha: unknown): { sha: string; size: number } {
    if (typeof contents !== "string") throw new WorkspaceError("invalid", "contents must be text");
    if (sha !== undefined && sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))) throw new WorkspaceError("invalid", "sha must be a SHA-256");
    const buf = Buffer.from(contents, "utf8");
    if (buf.length > MAX_FILE_WRITE_BYTES) throw new WorkspaceError("invalid", "That file is too large to save from here.");
    const p = this.filePath(rootId, path);
    if (sha && sha256(readFileSync(p)) !== sha) throw new WorkspaceError("conflict", "The file changed in the sandbox since you opened it.");
    writeFileSync(p, buf); // in place: owner and mode stay
    return { sha: sha256(buf), size: buf.length };
  }

  /** One `call` from the server. */
  async call(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "fs.roots":
        return { roots: await this.roots() };
      case "fs.tree":
        return this.tree(args.root);
      case "fs.read":
        return this.read(args.root, args.path);
      case "fs.write":
        return this.write(args.root, args.path, args.contents, args.sha);
      default:
        throw new WorkspaceError("invalid", `unknown call: ${op}`);
    }
  }
}
