import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// What goes into the base snapshot: the bridge bundle (infra/bridge) and the installer script (infra/snapshot/boat-install.sh).
// The compiled sidecar embeds both (./embedded.bun.ts, resolved when `bun build --compile` runs); from source they are read from
// the repository. `bundleId` identifies the pair, so a snapshot built from older assets can be recognised as stale.

export interface SnapshotAssets {
  bridge: Uint8Array;
  installer: string;
  /** First 12 hex characters of sha256(bridge, 0x00, installer). */
  bundleId: string;
  bridgeSha256: string;
}

export function makeAssets(bridge: Uint8Array, installer: string): SnapshotAssets {
  const bridgeSha256 = createHash("sha256").update(bridge).digest("hex");
  const bundleId = createHash("sha256").update(bridge).update("\0").update(installer).digest("hex").slice(0, 12);
  return { bridge, installer, bundleId, bridgeSha256 };
}

const repoFile = (rel: string) => new URL(`../../../../${rel}`, import.meta.url);

const MISSING = "The bridge bundle is not available. Build it with `pnpm --filter @dorks/bridge build`, or use a release build of the app.";

export async function loadAssets(env: Record<string, string | undefined> = process.env): Promise<SnapshotAssets> {
  if (env.DORKS_BRIDGE_BUNDLE) {
    // Explicit override (development): a bundle on disk, and optionally another installer.
    const installer = env.DORKS_SNAPSHOT_INSTALLER ? readFileSync(env.DORKS_SNAPSHOT_INSTALLER, "utf8") : readFileSync(repoFile("infra/snapshot/boat-install.sh"), "utf8");
    return makeAssets(readFileSync(env.DORKS_BRIDGE_BUNDLE), installer);
  }
  if (process.versions.bun) {
    try {
      const embedded = await import("./embedded.bun");
      return makeAssets(embedded.bridge, embedded.installer);
    } catch {
      // Not compiled with the assets (plain `bun run`): fall through to the repository files.
    }
  }
  try {
    return makeAssets(readFileSync(repoFile("infra/bridge/dist/cli.mjs")), readFileSync(repoFile("infra/snapshot/boat-install.sh"), "utf8"));
  } catch {
    throw new Error(MISSING);
  }
}
