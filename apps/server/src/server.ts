import { randomUUID } from "node:crypto";
import { Hub, type App, type Config } from "./app";
import { keyringFromKey } from "./core/crypto";
import { Db } from "./db";
import { getBox } from "./lib/box";

export interface Overrides {
  db?: Db;
  now?: () => number;
  fetch?: typeof fetch;
  getBox?: App["getBox"];
}

/** Wires the pieces. Everything a test needs to control (clock, network, sandbox provider, database) is an override. */
export function createApp(cfg: Config, o: Overrides = {}): App {
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
  };
  return app;
}
