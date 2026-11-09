import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { unconfiguredBox, type BoxProvider } from "../../core/box";
import { boatBox } from "./boat";
import { DORKS_NETWORK_POLICY, upstashBox } from "./upstash";

/**
 * Box seam (core/box.ts). BOX_PROVIDER=boat (default)|sim|upstash; anything else fails every call with a clear message.
 * Actions are stateless, so the sim keeps its "remote" state in the simBoxes table (the same way a real provider holds it remotely).
 *
 * boat env: BOAT_API_KEY (required). upstash env: UPSTASH_BOX_API_KEY (required); optional UPSTASH_BOX_BASE_URL, UPSTASH_BOX_START_MODE=init|exec,
 * UPSTASH_BOX_NETWORK_POLICY=dorks (egress allow-list, see docs/upstash-box.md). CONVEX_CLOUD_URL scopes the box labels per deployment.
 */
export function getBox(ctx: ActionCtx): BoxProvider {
  if (process.env.BOX_PROVIDER === "sim") return simBox(ctx);
  if (!process.env.BOX_PROVIDER || process.env.BOX_PROVIDER === "boat") {
    const apiKey = process.env.BOAT_API_KEY;
    if (!apiKey || apiKey.startsWith("REPLACE_ME__")) return unconfiguredBox("box provider not configured (BOAT_API_KEY)");
    return boatBox({ apiKey, scope: process.env.CONVEX_CLOUD_URL ?? "", org: process.env.BOAT_ORG || undefined });
  }
  if (process.env.BOX_PROVIDER === "upstash") {
    const apiKey = process.env.UPSTASH_BOX_API_KEY;
    if (!apiKey || apiKey.startsWith("REPLACE_ME__")) return unconfiguredBox("box provider not configured (UPSTASH_BOX_API_KEY)");
    return upstashBox({
      apiKey,
      labelScope: process.env.CONVEX_CLOUD_URL ?? "",
      baseUrl: process.env.UPSTASH_BOX_BASE_URL || undefined,
      startMode: process.env.UPSTASH_BOX_START_MODE === "exec" ? "exec" : "init",
      networkPolicy: process.env.UPSTASH_BOX_NETWORK_POLICY === "dorks" ? DORKS_NETWORK_POLICY : undefined,
    });
  }
  return unconfiguredBox(`unknown box provider: ${process.env.BOX_PROVIDER}`);
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
