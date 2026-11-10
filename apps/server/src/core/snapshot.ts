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
  listBuildSandboxes(label: string): Promise<{ id: string }[]>;
  /** Idempotent on `key`. The sandbox gets none of the account's credentials and a lifetime limit as a safety net. */
  createBuildSandbox(o: { name: string; label: string; key: string }): Promise<{ id: string }>;
  waitReady(id: string): Promise<void>;
  writeFile(id: string, path: string, content: string, encoding: "utf8" | "base64"): Promise<void>;
  run(id: string, command: string, timeoutSeconds: number): Promise<CommandResult>;
  /** Starts saving the sandbox's disk under `name` (replacing a previous save of that name once the new one is ready). */
  saveSnapshot(id: string, name: string): Promise<void>;
  getSnapshot(name: string): Promise<SavedSnapshotInfo | null>;
  /** Idempotent: deleting a missing sandbox is not an error. */
  deleteSandbox(id: string): Promise<void>;
}

export const BUILD_SANDBOX_LIFETIME_SECONDS = 2 * 3600;
