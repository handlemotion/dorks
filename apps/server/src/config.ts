import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./app";

interface Secrets {
  bridgeSecretKey: string;
  encryptionKey: string;
  ownerToken: string;
}

export function defaultDataDir(env: Record<string, string | undefined>, platform = process.platform): string {
  if (env.DORKS_DATA_DIR) return env.DORKS_DATA_DIR;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Dorks");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "dorks");
}

/** Reads `<dataDir>/secrets.json`, generating any missing key on first run (mode 600). Values are never logged. */
export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, "secrets.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const have: Partial<Secrets> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const next: Secrets = {
    bridgeSecretKey: have.bridgeSecretKey || randomBytes(32).toString("hex"),
    encryptionKey: have.encryptionKey || randomBytes(32).toString("base64"),
    ownerToken: have.ownerToken || randomBytes(32).toString("hex"),
  };
  if (JSON.stringify(have) !== JSON.stringify(next)) {
    writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return next;
}

const port = (v: string | undefined, d: number) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${v}`);
  return n;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = defaultDataDir(env);
  const secrets = loadSecrets(dataDir);
  const boxProvider = (env.BOX_PROVIDER || "boat") as Config["boxProvider"];
  if (boxProvider !== "boat" && boxProvider !== "sim") throw new Error(`unknown BOX_PROVIDER: ${boxProvider}`);
  if (boxProvider === "sim" && !env.SIM_HOST_KEY) throw new Error("SIM_HOST_KEY is required when BOX_PROVIDER=sim");
  const publicUrl = env.DORKS_PUBLIC_URL?.replace(/\/+$/, "");
  if (publicUrl && !/^https:\/\//.test(publicUrl)) throw new Error("DORKS_PUBLIC_URL must be an https:// URL");
  const tunnelKey = env.DORKS_TUNNEL_KEY || undefined;
  if (tunnelKey && !/^[A-Za-z0-9_-]{32,128}$/.test(tunnelKey)) throw new Error("DORKS_TUNNEL_KEY must be 32 to 128 letters, digits, - or _");
  return {
    dataDir,
    uiPort: port(env.DORKS_UI_PORT, 4747),
    bridgePort: port(env.DORKS_BRIDGE_PORT, 4748),
    publicUrl,
    tunnelKey,
    ownerToken: env.DORKS_OWNER_TOKEN || secrets.ownerToken,
    bridgeSecretKey: secrets.bridgeSecretKey,
    encryptionKey: secrets.encryptionKey,
    boxProvider,
    simHostKey: env.SIM_HOST_KEY,
    uiOrigins: (env.DORKS_UI_ORIGINS ?? "tauri://localhost,http://tauri.localhost,http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim()).filter(Boolean),
    baseSnapshotId: env.BASE_SNAPSHOT_ID || undefined,
  };
}
