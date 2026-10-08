import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { unconfiguredBox, type BoxProvider } from "../../../api/src/lib/box";
import { DORKS_NETWORK_POLICY, upstashBox } from "./upstash";

/**
 * Box seam (apps/api/src/lib/box.ts is carried over). BOX_PROVIDER=sim|upstash; anything else fails every call with a clear message.
 * Actions are stateless, so the sim keeps its "remote" state in the simBoxes table (the same way a real provider holds it remotely).
 *
 * upstash env: UPSTASH_BOX_API_KEY (required); optional UPSTASH_BOX_BASE_URL, UPSTASH_BOX_START_MODE=init|exec,
 * UPSTASH_BOX_NETWORK_POLICY=dorks (egress allow-list, see docs/upstash-box.md). CONVEX_CLOUD_URL scopes the box labels per deployment.
 */
export function getBox(ctx: ActionCtx): BoxProvider {
  if (process.env.BOX_PROVIDER === "sim") return simBox(ctx);
  if (process.env.BOX_PROVIDER === "upstash") {
    const apiKey = process.env.UPSTASH_BOX_API_KEY;
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
