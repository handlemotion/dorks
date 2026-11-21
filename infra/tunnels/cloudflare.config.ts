import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

// The Worker's config for `cf` (`cf dev`, `cf build`, `cf deploy`). Optional vars, unset by default: WURMHOL_SERVER (a self-hosted
// Wurmhol) and TENANT_MONTHLY_REQUESTS (a monthly request cap per install); add them under `env` with `bindings.text("...")`.
export default defineConfig({
  worker: {
    name: "dorks-tunnels",
    compatibilityDate: "2026-10-01",
    entrypoint,
    env: {
      // The Dorks application's Wurmhol integration key (`tunnels:read`, `tunnels:manage`, `subjects:manage`, `grants:issue`).
      WURMHOL_KEY: bindings.secret(),
      // 32+ random bytes that sign sandbox tickets; rotating it ends every sandbox's ticket.
      TICKET_KEY: bindings.secret(),
    },
  },
});
