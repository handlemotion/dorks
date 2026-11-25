// The Files tab of Chat details (docs/architecture.md, "Files"): the repositories checked out in a dork's sandbox, their files and
// the contents of one, read and written by the server through the bridge (the `call` frames of the bridge protocol).

/** A git checkout in the box's work directory: the session's own repository, a build's, or one the agent cloned. */
export type WorkspaceRoot = {
  /** Its directory under the work directory, `owner/name` for the clones the bridge makes; "." for the work directory itself. */
  id: string;
  /** `owner/name` from its `origin` remote when it is on GitHub, else the directory's name. */
  name: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  /** The session's own repository (the agent's working directory). */
  primary: boolean;
};

/** git's view of a file that differs from HEAD, as the tree marks it. */
export type WorkspaceGitStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type WorkspaceTree = {
  root: string;
  /** Tracked and untracked files, never ignored ones (`git ls-files --cached --others --exclude-standard`). */
  paths: string[];
  /** More files than `MAX_TREE_PATHS`: the rest are left out. */
  truncated: boolean;
  status: { path: string; status: WorkspaceGitStatus }[];
};

/**
 * One file. `sha` is the SHA-256 of its bytes, hex: a write names the one it was edited from, so a change the agent made meanwhile is
 * not overwritten unseen. A binary file or one over `MAX_FILE_READ_BYTES` comes without its text.
 */
export type WorkspaceFile = { root: string; path: string; kind: "text"; contents: string; sha: string; size: number } | { root: string; path: string; kind: "binary" | "too_large"; size: number };

export const MAX_TREE_PATHS = 20_000;
/** What the editor opens: bigger files show their size only. */
export const MAX_FILE_READ_BYTES = 1024 * 1024;
export const MAX_FILE_WRITE_BYTES = MAX_FILE_READ_BYTES;

/**
 * A path inside a root as the owner may name it: relative, no `..`, `.` or empty segments, nothing in `.git`, no NUL. The bridge
 * checks the resolved path too (symlinks); this is the first gate, shared by the server and the bridge.
 */
export function validWorkspacePath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 1024 || p.includes("\0") || p.startsWith("/") || p.includes("\\")) return false;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== "..") && parts[0] !== ".git" && !parts.includes(".git");
}

/** A root id: "." or one or two plain directory names. */
export function validRootId(id: unknown): id is string {
  return id === "." || (typeof id === "string" && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(id) && !id.split("/").some((s) => s === "." || s === ".." || s === ".git"));
}
