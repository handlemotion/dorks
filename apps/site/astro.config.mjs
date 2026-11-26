// @ts-check
import { defineConfig } from "astro/config";

// Static output only: the edge Worker (src/worker.ts) serves dist/ as assets.
export default defineConfig({
  site: "https://dorks.build",
});
