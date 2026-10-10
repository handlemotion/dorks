import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { unconfiguredBox, type BoxProvider } from "../../core/box";
import { aad, decrypt, keyringFromEnv } from "../../core/crypto";
import { unconfiguredBuilder, type SnapshotBuilder } from "../../core/snapshot";
import { DORKS_NETWORK_POLICY, upstashBox } from "./upstash";

/**
 * Box seam (core/box.ts). BOX_PROVIDER=sim|upstash; anything else fails every call with a clear message.
 * Actions are stateless, so the sim keeps its "remote" state in the simBoxes table (the same way a real provider holds it remotely).
 *
 * upstash: bring your own key. Every user's boxes live in THEIR Upstash account, so the key is the user's (settings.setUpstashKey, stored
 * encrypted) and the platform pays for no compute. Optional env: UPSTASH_BOX_BASE_URL, UPSTASH_BOX_START_MODE=init|exec,
 * UPSTASH_BOX_NETWORK_POLICY=dorks (egress allow-list, see docs/upstash-box.md). CONVEX_CLOUD_URL scopes the box labels per deployment.
 */
export async function getBox(ctx: ActionCtx, userId: string): Promise<BoxProvider> {
  if (process.env.BOX_PROVIDER === "sim") return simBox(ctx);
  return (await upstashFor(ctx, userId)) ?? unconfiguredBox;
}

/** Snapshot builds (core/snapshot.ts) in the user's own Upstash account. The sim "builds" instantly and runs nothing. */
export async function getBuilder(ctx: ActionCtx, userId: string): Promise<SnapshotBuilder> {
  if (process.env.BOX_PROVIDER === "sim") return simBuilder;
  return (await upstashFor(ctx, userId)) ?? unconfiguredBuilder;
}

async function upstashFor(ctx: ActionCtx, userId: string) {
  if (process.env.BOX_PROVIDER !== "upstash") return null;
  const apiKey = await userUpstashKey(ctx, userId);
  if (!apiKey) return null;
  return upstashBox({
    apiKey,
    labelScope: process.env.CONVEX_CLOUD_URL ?? "",
    baseUrl: process.env.UPSTASH_BOX_BASE_URL || undefined,
    startMode: process.env.UPSTASH_BOX_START_MODE === "exec" ? "exec" : "init",
    networkPolicy: process.env.UPSTASH_BOX_NETWORK_POLICY === "dorks" ? DORKS_NETWORK_POLICY : undefined,
  });
}

/** The user's own Upstash API key, decrypted, or null if they have not added one. Only ever held in an action's memory. */
export async function userUpstashKey(ctx: ActionCtx, userId: string): Promise<string | null> {
  const enc = await ctx.runQuery(internal.settings.upstashKeyEnc, { userId });
  if (!enc) return null;
  return decrypt(keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! }), enc, aad.upstashKey(userId));
}

/** BOX_PROVIDER=sim: no real box to run a script in, so a build succeeds at once with a synthetic snapshot id (docs/snapshots.md). */
const simBuilder: SnapshotBuilder = {
  async createBuildBox(_base, { name }) {
    return { id: `sim-build-${name}` };
  },
  async findBuildBox() {
    return null;
  },
  async putFiles() {},
  async startRunner() {},
  async pollRunner() {
    return { state: "done", exitCode: 0, log: "(sim) the setup script was not run: BOX_PROVIDER=sim has no sandbox\n" };
  },
  async check() {
    return { exitCode: 0, output: "" };
  },
  async startSnapshot(boxId, name) {
    return { id: `sim-snap-${name}-${boxId}` };
  },
  async snapshotStatus() {
    return "ready";
  },
  async deleteSnapshot() {},
  async snapshotReady() {
    return true;
  },
};

function simBox(ctx: ActionCtx): BoxProvider {
  return {
    async createFromSnapshot(_snap, opts) {
      return { id: await ctx.runMutation(internal.simbox.create, { name: opts.name }) };
    },
    async resume(id) {
      await ctx.runMutation(internal.simbox.setRunning, { id, running: true });
    },
    async pause(id) {
      await ctx.runMutation(internal.simbox.setRunning, { id, running: false });
    },
    async delete(id) {
      await ctx.runMutation(internal.simbox.remove, { id });
    },
  };
}
