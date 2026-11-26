import { defineConfig } from "vite-plus";

// pack: `vp pack` builds dist/ for npm, one module per source file (unbundled, so `@dorks/core/machine` pulls in no Effect), for no
// particular runtime: the Dorks Cloud Worker, Node and Bun all import it. testTimeout: the machine fuzz test runs 3000 sequences.
export default defineConfig({
  pack: { entry: ["src/*.ts"], platform: "neutral", unbundle: true, dts: true, clean: true },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000, clearMocks: false },
});
