import { MAX_FILE_WRITE_BYTES, validRootId, validWorkspacePath, type WorkspaceFile, type WorkspaceRoot, type WorkspaceTree } from "@dorks/shared";
import { fail, type App } from "../app";
import { owned } from "./dorks";

// The Files tab of Chat details (docs/architecture.md, "Files"): the checkouts in a dork's sandbox, their files, one file's text, and
// a save. Nothing is stored here: every read goes to the box's bridge as a `call` frame on its authenticated socket and the answer
// comes straight back. A sleeping box is never woken for it.

/** Sends one `call` to a dork's connected bridge; rejects with an `AppFail` (the bridge's error, a timeout or a dropped socket). */
export type BridgeCaller = (op: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

const callers = new WeakMap<App, Map<string, BridgeCaller>>();

/** The bridge session of `dorkId` (http/bridgeWs.ts) offers its calls; the function it returns withdraws them. A newer session replaces an older one. */
export function registerBridgeCaller(app: App, dorkId: string, caller: BridgeCaller): () => void {
  let m = callers.get(app);
  if (!m) callers.set(app, (m = new Map()));
  m.set(dorkId, caller);
  return () => {
    if (m.get(dorkId) === caller) m.delete(dorkId);
  };
}

const READ_MS = 20_000;
const WRITE_MS = 30_000;

async function call(app: App, dorkId: string, op: string, args: Record<string, unknown>, timeoutMs = READ_MS): Promise<unknown> {
  const dork = owned(app, dorkId);
  if (dork.state !== "working" && dork.state !== "idle") return fail("sleeping", "The sandbox is asleep. Its files show while it is awake.");
  const caller = callers.get(app)?.get(dorkId);
  if (!caller) return fail("sleeping", "The sandbox is not connected yet.");
  return caller(op, args, timeoutMs);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const badAnswer = (): never => fail("failed", "The sandbox sent an answer this app cannot read.");

/** `GET /api/dorks/:id/workspace`: the git checkouts in the box's work directory, the session's own first. */
export async function workspaceRoots(app: App, dorkId: string): Promise<{ roots: WorkspaceRoot[] }> {
  const r = obj(await call(app, dorkId, "fs.roots", {}));
  if (!Array.isArray(r.roots)) return badAnswer();
  const roots = r.roots.map(obj).filter((x) => validRootId(x.id) && typeof x.name === "string");
  return {
    roots: roots.slice(0, 50).map((x) => ({
      id: x.id as string,
      name: (x.name as string).slice(0, 200),
      ...(typeof x.branch === "string" && x.branch ? { branch: x.branch.slice(0, 250) } : {}),
      primary: x.primary === true,
    })),
  };
}

/** `GET /api/dorks/:id/workspace/tree?root=`: a checkout's files (tracked and untracked, not ignored) and their git status. */
export async function workspaceTree(app: App, dorkId: string, root: unknown): Promise<WorkspaceTree> {
  if (!validRootId(root)) return fail("invalid", "root must name a repository in the sandbox");
  const r = obj(await call(app, dorkId, "fs.tree", { root }));
  if (!Array.isArray(r.paths) || !Array.isArray(r.status)) return badAnswer();
  return {
    root,
    paths: r.paths.filter((p): p is string => typeof p === "string"),
    truncated: r.truncated === true,
    status: r.status.map(obj).filter((s) => typeof s.path === "string" && typeof s.status === "string") as WorkspaceTree["status"],
  };
}

/** `GET /api/dorks/:id/workspace/file?root=&path=`: one file's text and its SHA-256, or only its size when binary or too large. */
export async function readWorkspaceFile(app: App, dorkId: string, root: unknown, path: unknown): Promise<WorkspaceFile> {
  if (!validRootId(root)) return fail("invalid", "root must name a repository in the sandbox");
  if (!validWorkspacePath(path)) return fail("invalid", "path must be a file in the repository");
  const r = obj(await call(app, dorkId, "fs.read", { root, path }));
  const size = typeof r.size === "number" ? r.size : 0;
  if (r.kind === "binary" || r.kind === "too_large") return { root, path, kind: r.kind, size };
  if (r.kind !== "text" || typeof r.contents !== "string" || typeof r.sha !== "string") return badAnswer();
  return { root, path, kind: "text", contents: r.contents, sha: r.sha, size };
}

/**
 * `PUT /api/dorks/:id/workspace/file`: replaces an existing file's text. `sha` is the version the owner edited; when the file on
 * disk is no longer that one (the agent changed it meanwhile) the bridge refuses with `conflict`, and a save without `sha` overwrites.
 */
export async function writeWorkspaceFile(app: App, dorkId: string, root: unknown, path: unknown, contents: unknown, sha: unknown): Promise<{ sha: string; size: number }> {
  if (!validRootId(root)) return fail("invalid", "root must name a repository in the sandbox");
  if (!validWorkspacePath(path)) return fail("invalid", "path must be a file in the repository");
  if (typeof contents !== "string") return fail("invalid", "contents must be text");
  if (Buffer.byteLength(contents, "utf8") > MAX_FILE_WRITE_BYTES) return fail("invalid", "That file is too large to save from here.");
  if (sha !== undefined && sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))) return fail("invalid", "sha must be a SHA-256");
  const r = obj(await call(app, dorkId, "fs.write", { root, path, contents, ...(sha ? { sha } : {}) }, WRITE_MS));
  if (typeof r.sha !== "string") return badAnswer();
  return { sha: r.sha, size: typeof r.size === "number" ? r.size : 0 };
}
