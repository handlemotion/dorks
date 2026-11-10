import { randomUUID } from "node:crypto";
import { Hub, type App, type Config } from "./app";
import { keyringFromKey } from "./core/crypto";
import { Db } from "./db";
import { getBox, getSnapshotDriver } from "./lib/box";
import { loadAssets, makeAssets, type SnapshotAssets } from "./snapshot/assets";

export interface Overrides {
  db?: Db;
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
    hub: new Hub(),
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
