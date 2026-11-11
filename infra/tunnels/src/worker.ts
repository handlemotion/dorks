// Cloudflare Worker entry. Secrets (`wrangler secret put`): WURMHOL_KEY (the Dorks application's integration key, with
// `tunnels:read`, `tunnels:manage`, `subjects:manage` and `grants:issue`) and TICKET_KEY (32+ random bytes). Optional vars:
// WURMHOL_SERVER (a self-hosted Wurmhol), TENANT_MONTHLY_REQUESTS.
import { EmbedClient } from "./embed";
import { createHandler } from "./handler";

interface Env {
  WURMHOL_KEY: string;
  TICKET_KEY: string;
  WURMHOL_SERVER?: string;
  TENANT_MONTHLY_REQUESTS?: string;
}

let cached: { env: Env; handle: (req: Request) => Promise<Response> } | undefined;

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (cached?.env !== env) {
      const monthly = Number(env.TENANT_MONTHLY_REQUESTS);
      cached = {
        env,
        handle: createHandler({
          embed: new EmbedClient({ key: env.WURMHOL_KEY, server: env.WURMHOL_SERVER }),
          ticketKey: env.TICKET_KEY,
          limits: { activeTunnels: 1, ...(env.TENANT_MONTHLY_REQUESTS && Number.isFinite(monthly) ? { monthlyRequests: monthly } : {}) },
        }),
      };
    }
    return cached.handle(req);
  },
};
