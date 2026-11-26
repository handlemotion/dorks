import type { AgyCli } from "./lib/agyCli";
import type { BoatCli } from "./lib/boatCli";
import type { GhLogin } from "./lib/ghCli";
import type { AppError, AppErrorCode } from "@dorks/shared";
import type { BoxProvider } from "@dorks/core/box";
import type { SnapshotDriver } from "./core/snapshot";
import type { SnapshotAssets } from "./snapshot/assets";
import type { Keyring } from "@dorks/core/crypto";
import type { Db } from "./db";
import type { JwksVerifier } from "./core/jwt";

/** What changed, for live listeners (SSE clients, bridge sessions). Published after the transaction commits, never on rollback. */
export type Change =
  | { t: "dorks" }
  | { t: "dork"; dorkId: string }
  | { t: "events"; dorkId: string; seq: number }
  | { t: "subscriptions"; dorkId: string }
  | { t: "comments"; dorkId: string }
  | { t: "settings" }
  | { t: "snapshot" }
  | { t: "builds" }
  | { t: "build"; buildId: string }
  | { t: "automations" }
  | { t: "commands"; dorkId: string }
  /** Who is looking at a dork right now (services/presence.ts): a payload, not an invalidation. */
  | { t: "presence"; dorkId: string; viewers: { id: string; name: string }[] };

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
  /** `DORKS_AGY_BIN`: the Antigravity CLI for the Google sign-in; else `agy` on PATH, else one Dorks downloads. */
  agyBin?: string;
  /** `DORKS_CLOUD_URL`: the cloud relay the iPhone app reaches this server through (docs/mobile.md); unset or empty turns it off. */
  cloudUrl?: string;
  /** `DORKS_CLOUD_JWKS_URL`: the cloud's signing keys for team identity tokens (docs/cloud.md); default `<cloudUrl>/api/auth/jwks`. */
  cloudJwksUrl?: string;
  /** `DORKS_ORG_ID`: the dorks-cloud organization this server belongs to (a server Dorks runs for a Teams or Cloud org); else the one the cloud reports for its pairing. */
  orgId?: string;
  /** The folders skills on this computer are adopted from (docs/skills.md, "From this computer"); default the owner's ~/.agents/skills and ~/.claude/skills. Tests set none. */
  localSkillRoots?: string[];
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
  /** The Antigravity CLI on this computer (lib/agyCli.ts): the Google sign-in for Antigravity sessions. Tests replace it. */
  agyCli: AgyCli;
  /** The sandbox provider for the current settings. Tests replace it. */
  getBox(): Promise<BoxProvider>;
  /** The provider calls the base-snapshot build makes (services/snapshot.ts). Tests replace it. */
  getSnapshotDriver(): Promise<SnapshotDriver>;
  /** What the base snapshot is built from: the bridge bundle and the installer. Tests replace it. */
  snapshotAssets(): Promise<SnapshotAssets>;
  /** Waits; tests replace it so polling loops do not take real time. */
  sleep(ms: number): Promise<void>;
  /** The cloud's JWKS (core/jwt.ts) for team identity tokens; null when no cloud is configured. Tests replace it. */
  jwks(): JwksVerifier | null;
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
