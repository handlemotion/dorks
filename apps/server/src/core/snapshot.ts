import { Effect } from "effect";

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
  /** The same calls as Effects, when the driver is written in Effect (Boat): interrupting one cancels its request. */
  readonly effect?: SnapshotOps;
}

type Calls = Omit<SnapshotDriver, "effect">;

/** The driver's calls as Effects. A call fails with what the provider threw (a `BoatError` from Boat). */
export type SnapshotOps = {
  [K in keyof Calls]: Calls[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Effect.Effect<R, unknown> : never;
};

const CALLS = [
  "listBuildSandboxes",
  "createBuildSandbox",
  "waitReady",
  "writeFile",
  "run",
  "saveSnapshot",
  "getSnapshot",
  "deleteSandbox",
  "runDetached",
  "attach",
  "killCommand",
  "deleteSnapshot",
] as const satisfies readonly (keyof Calls)[];

/** The Effect form of a driver: its own when it has one, else each Promise call wrapped (interrupting abandons the call). */
export function snapshotOps(d: SnapshotDriver): SnapshotOps {
  if (d.effect) return d.effect;
  const wrap =
    (call: (...args: any[]) => Promise<unknown>) =>
    (...args: any[]) =>
      Effect.tryPromise({ try: () => call(...args), catch: (e) => e });
  return Object.fromEntries(CALLS.map((k) => [k, wrap(d[k].bind(d) as (...args: any[]) => Promise<unknown>)])) as unknown as SnapshotOps;
}

/** The Promise form of Effect calls, for the code that still awaits a driver. `Effect.runPromise` rejects with the original error. */
export function promiseDriver(ops: SnapshotOps): SnapshotDriver {
  const wrap =
    (call: (...args: any[]) => Effect.Effect<unknown, unknown>) =>
    (...args: any[]) =>
      Effect.runPromise(call(...args));
  return { ...(Object.fromEntries(CALLS.map((k) => [k, wrap(ops[k] as (...args: any[]) => Effect.Effect<unknown, unknown>)])) as unknown as Calls), effect: ops };
}

export type AttachResult = { t: "exit"; exitCode: number | null; offsets: { stdout: number; stderr: number } } | { t: "reconnect"; offsets: { stdout: number; stderr: number } };

export const BUILD_SANDBOX_LIFETIME_SECONDS = 2 * 3600;
