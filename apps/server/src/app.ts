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
  bridgePort: number;
  /** `https://` URL of the tunnel that forwards to the bridge listener. */
  publicUrl?: string;
  /**
   * The Dorks tunnel service (infra/tunnels) and this install's key for it, when the public URL is this install's embedded
   * Wurmhol tunnel. Each new sandbox is registered there and gets a ticket its bridge trades for short-lived Wurmhol grants.
   */
  tunnelService?: { url: string; installKey: string };
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
  /** The sandbox provider for the current settings. Tests replace it. */
  getBox(): Promise<BoxProvider>;
  /** Where a freshly created sandbox's bridge connects. */
  bridgeUrl(): string | undefined;
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
