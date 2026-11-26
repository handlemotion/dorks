// @ts-check
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Static output only: the edge Worker (src/worker.ts) serves dist/ as assets.
export default defineConfig({
  site: "https://dorks.build",
  devToolbar: { enabled: false },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
