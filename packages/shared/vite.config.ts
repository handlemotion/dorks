import { defineConfig } from "vite-plus";

// pack: `vp pack` builds dist/ for npm (one module per source file), for no particular runtime: the Dorks Cloud Worker imports it too.
export default defineConfig({
  pack: { entry: ["src/index.ts"], platform: "neutral", unbundle: true, dts: true, clean: true },
});
