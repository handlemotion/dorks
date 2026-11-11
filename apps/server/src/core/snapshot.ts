// Seam for building the base snapshot (a saved snapshot in the user's Boat account that every dork sandbox starts from).
// The build service depends only on this, so it runs unchanged against Boat, the local simulator, and a fake in tests.

export interface SavedSnapshotInfo {
  name: string;
  status: "saving" | "ready" | "failed";
  /** Provider's failure reason; present when `status` is `failed`. */
  error?: string;
  /** The sandbox this was saved from. Lets a poller tell a fresh save from the one it replaces. */
  sourceSandboxId?: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SnapshotDriver {
  /** Build sandboxes this install made (any state), found by label: how a crashed build is cleaned up. */
  listBuildSandboxes(label: string, labelKey?: string): Promise<{ id: string }[]>;
  /**
   * Idempotent on `key`. The sandbox gets none of the account's credentials and a lifetime limit as a safety net. `from` starts it
   * from a saved snapshot (builds start from the base snapshot), `type` picks the machine size; `labelKey` defaults to `dorks-build`.
   */
  createBuildSandbox(o: { name: string; label: string; key: string; from?: string; type?: string; labelKey?: string }): Promise<{ id: string }>;
  waitReady(id: string): Promise<void>;
  writeFile(id: string, path: string, content: string, encoding: "utf8" | "base64"): Promise<void>;
  run(id: string, command: string, timeoutSeconds: number): Promise<CommandResult>;
  /** Starts saving the sandbox's disk under `name` (replacing a previous save of that name once the new one is ready). */
  saveSnapshot(id: string, name: string): Promise<void>;
  getSnapshot(name: string): Promise<SavedSnapshotInfo | null>;
  /** Idempotent: deleting a missing sandbox is not an error. */
  deleteSandbox(id: string): Promise<void>;
  /** Starts a command in the background (no time limit). `commandId` names its record in the provider's command history. */
  runDetached(id: string, command: string): Promise<{ processId: number; commandId?: string }>;
  /**
   * Follows a detached command's output from the given byte offsets until it ends, calling `onOutput` per chunk. Resolves with the
   * exit, or with `reconnect` when the stream must be opened again from the returned offsets (no output is lost or repeated).
   */
  attach(id: string, processId: number, offsets: { stdout: number; stderr: number }, onOutput: (stream: "stdout" | "stderr", data: string) => void): Promise<AttachResult>;
  /** Stops a detached command and what it started. Idempotent. */
  killCommand(id: string, processId: number): Promise<void>;
  /** Removes a saved snapshot. Idempotent: a missing one is not an error. */
  deleteSnapshot(name: string): Promise<void>;
}

export type AttachResult =
  | { t: "exit"; exitCode: number | null; offsets: { stdout: number; stderr: number } }
  | { t: "reconnect"; offsets: { stdout: number; stderr: number } };

export const BUILD_SANDBOX_LIFETIME_SECONDS = 2 * 3600;
