import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { unconfiguredBox, type BoxProvider } from "../../core/box";
import { aad, decrypt, keyringFromEnv } from "../../core/crypto";
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
  if (process.env.BOX_PROVIDER === "upstash") {
    const apiKey = await userUpstashKey(ctx, userId);
    if (!apiKey) return unconfiguredBox;
    return upstashBox({
      apiKey,
      labelScope: process.env.CONVEX_CLOUD_URL ?? "",
      baseUrl: process.env.UPSTASH_BOX_BASE_URL || undefined,
      startMode: process.env.UPSTASH_BOX_START_MODE === "exec" ? "exec" : "init",
      networkPolicy: process.env.UPSTASH_BOX_NETWORK_POLICY === "dorks" ? DORKS_NETWORK_POLICY : undefined,
    });
  }
  return unconfiguredBox;
}

/** The user's own Upstash API key, decrypted, or null if they have not added one. Only ever held in an action's memory. */
export async function userUpstashKey(ctx: ActionCtx, userId: string): Promise<string | null> {
  const enc = await ctx.runQuery(internal.settings.upstashKeyEnc, { userId });
  if (!enc) return null;
  return decrypt(keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! }), enc, aad.upstashKey(userId));
}

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
