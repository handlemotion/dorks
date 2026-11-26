// @ts-check
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/** astro dev's half of src/worker.ts's /invite/<id> rewrite: every invitation id gets the one /invite page. */
function invitePages() {
  return {
    name: "dorks-invite-pages",
    /** @param {import("vite").ViteDevServer} server */
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/invite\/[^/?]+\/?(\?|$)/.test(req.url)) req.url = "/invite/";
        next();
      });
    },
  };
}

// Static output only: the edge Worker (src/worker.ts) serves dist/ as assets.
export default defineConfig({
  site: "https://dorks.build",
  devToolbar: { enabled: false },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss(), invitePages()],
  },
});
