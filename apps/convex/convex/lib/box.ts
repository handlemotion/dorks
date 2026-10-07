import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { unconfiguredBox, type BoxProvider } from "../../../api/src/lib/box";

/**
 * Box seam (apps/api/src/lib/box.ts is carried over unchanged). The real Upstash provider plugs in here.
 * Actions are stateless, so the sim keeps its "remote" state in the simBoxes table (the same way a real provider holds it remotely).
 */
export function getBox(ctx: ActionCtx): BoxProvider {
  if (process.env.BOX_PROVIDER === "sim") return simBox(ctx);
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
