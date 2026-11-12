import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { Hub, type App, type Config } from "./app";
import { keyringFromKey } from "./core/crypto";
import { loadConfig } from "./config";
import { Db } from "./db";
import { AppEnv } from "./http/route";
import { getBox, getSnapshotDriver } from "./lib/box";
import { loadAssets, makeAssets, type SnapshotAssets } from "./snapshot/assets";

export interface Overrides {
  db?: Db;
  hub?: Hub;
  now?: () => number;
  fetch?: typeof fetch;
  getBox?: App["getBox"];
  getSnapshotDriver?: App["getSnapshotDriver"];
  snapshotAssets?: App["snapshotAssets"];
  sleep?: App["sleep"];
}

/** Wires the pieces. Everything a test needs to control (clock, network, sandbox provider, database) is an override. */
export function createApp(cfg: Config, o: Overrides = {}): App {
  let assets: Promise<SnapshotAssets> | undefined;
  const app: App = {
    db: o.db ?? new Db(`${cfg.dataDir}/dorks.db`),
    cfg,
    hub: o.hub ?? new Hub(),
    ring: keyringFromKey(cfg.encryptionKey),
    now: o.now ?? Date.now,
    uuid: () => randomUUID(),
    fetch: o.fetch ?? fetch,
    getBox: () => (o.getBox ?? (() => getBox(app)))(),
    bridgeUrl: () => (cfg.publicUrl ? `${cfg.publicUrl.replace(/^https:/, "wss:")}/bridge` : cfg.boxProvider === "sim" ? `ws://127.0.0.1:${cfg.bridgePort}/bridge` : undefined),
    getSnapshotDriver: () => (o.getSnapshotDriver ?? (() => getSnapshotDriver(app)))(),
    // Read once per process (about 1 MB). The simulator may run without the bridge bundle built, so it falls back to stand-ins.
    snapshotAssets: () =>
      o.snapshotAssets?.() ??
      (assets ??= loadAssets().catch((e) => {
        if (cfg.boxProvider === "sim") return makeAssets(new TextEncoder().encode("sim-bridge"), "sim-installer");
        assets = undefined; // let a later request retry once the bundle exists
        throw e;
      })),
    sleep: o.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  return app;
}

// The app as Layers (main.ts). Acquired in dependency order and released in reverse, so whatever is built on the database (the
// listeners, the scheduler) is gone before the database closes.

export class ServerConfig extends Context.Service<ServerConfig, Config>()("dorks/server/ServerConfig") {
  static readonly layer = Layer.sync(ServerConfig, loadConfig);
}

export class Database extends Context.Service<Database, Db>()("dorks/server/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.acquireRelease(
      ServerConfig.use((cfg) => Effect.sync(() => new Db(`${cfg.dataDir}/dorks.db`))),
      (db) => Effect.sync(() => db.close()),
    ),
  );
}

export class LiveHub extends Context.Service<LiveHub, Hub>()("dorks/server/LiveHub") {
  static readonly layer = Layer.sync(LiveHub, () => new Hub());
}

/** The wired app on the config, database and hub layers. */
export const appLayer = Layer.effect(
  AppEnv,
  Effect.gen(function* () {
    return createApp(yield* ServerConfig, { db: yield* Database, hub: yield* LiveHub });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(Database.layer, LiveHub.layer)), Layer.provideMerge(ServerConfig.layer));
