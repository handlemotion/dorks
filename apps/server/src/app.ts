import type { BoatCli } from "./lib/boatCli";
import type { GhLogin } from "./lib/ghCli";
import type { AppError, AppErrorCode } from "@dorks/shared";
import type { BoxProvider } from "./core/box";
import type { SnapshotDriver } from "./core/snapshot";
import type { SnapshotAssets } from "./snapshot/assets";
import type { Keyring } from "./core/crypto";
import type { Db } from "./db";

/** What changed, for live listeners (SSE clients, bridge sessions). Published after the transaction commits, never on rollback. */
export type Change =
  | { t: "dorks" }
  | { t: "dork"; dorkId: string }
  | { t: "events"; dorkId: string; seq: number }
  | { t: "subscriptions"; dorkId: string }
  | { t: "settings" }
  | { t: "snapshot" }
  | { t: "builds" }
  | { t: "build"; buildId: string }
  | { t: "automations" }
  | { t: "commands"; dorkId: string };

export class Hub {
  private readonly listeners = new Set<(c: Change) => void>();
  on(fn: (c: Change) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  emit(c: Change) {
    for (const l of [...this.listeners]) {
      try {
        l(c);
      } catch (e) {
        console.error("live listener failed", e instanceof Error ? e.message : "unknown");
      }
    }
  }
}

export interface Config {
  dataDir: string;
  uiPort: number;
  ownerToken: string;
  /** HMAC key for per-dork bridge secrets. */
  bridgeSecretKey: string;
  /** base64, 32 bytes. */
  encryptionKey: string;
  boxProvider: "boat" | "sim";
  simHostKey?: string;
  uiOrigins: string[];
  /** Base snapshot used when settings do not name one (dev and tests). */
  baseSnapshotId?: string;
  /** `GH_TOKEN`, else `GITHUB_TOKEN`: overrides the GitHub CLI's login the way `gh` itself does (development and the e2e). */
  githubEnvToken?: string;
  /** `DORKS_BOAT_BIN`: the Boat CLI bundled with the desktop app, used when there is no `boat` on PATH. */
  boatBin?: string;
}

export interface SchedulerLike {
  wake(): void;
}

export interface App {
  db: Db;
  cfg: Config;
  hub: Hub;
  ring: Keyring;
  scheduler?: SchedulerLike;
  now(): number;
  uuid(): string;
  fetch: typeof fetch;
  /** The GitHub CLI's login (lib/ghCli.ts), read fresh on every call: callers go through services/github.ts, which caches it. Tests replace it. */
  ghLogin(): Promise<GhLogin>;
  /** The Boat CLI on this computer (lib/boatCli.ts): connecting Boat without a pasted key. Tests replace it. */
  boatCli: BoatCli;
  /** The sandbox provider for the current settings. Tests replace it. */
  getBox(): Promise<BoxProvider>;
  /** The provider calls the base-snapshot build makes (services/snapshot.ts). Tests replace it. */
  getSnapshotDriver(): Promise<SnapshotDriver>;
  /** What the base snapshot is built from: the bridge bundle and the installer. Tests replace it. */
  snapshotAssets(): Promise<SnapshotAssets>;
  /** Waits; tests replace it so polling loops do not take real time. */
  sleep(ms: number): Promise<void>;
}

export const touch = (app: App, c: Change) => app.db.afterCommit(() => app.hub.emit(c));

/** Thrown by any service function; rolls its transaction back. `error` is safe to show the user. */
export class AppFail extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
    this.name = "AppFail";
  }
}

export function fail(code: AppErrorCode, message: string): never {
  throw new AppFail({ code, message } as AppError);
}

export const OWNER = "owner"; // the one user; additional data in encrypted columns binds to it
