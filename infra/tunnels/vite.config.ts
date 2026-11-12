import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";

// `cf dev` and `cf build` bundle the Worker with Vite (Vite+); the plugin reads cloudflare.config.ts.
export default defineConfig({
  plugins: [cloudflare()],
  test: { include: ["test/**/*.test.ts"] },
});
