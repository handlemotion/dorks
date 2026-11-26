# Site agent notes

`dorks.build`: the marketing site (Astro, static) and the edge Worker `dorks-site` that serves it. The docs are `apps/docs` (Mintlify), served at `/docs` by this Worker. The relay is a separate Worker, `dorks-cloud`, on `api.dorks.build`.

- `src/pages`, `src/layouts`, `src/components`: the site. Plain Astro and CSS, no client JavaScript unless a section needs it. Follow the app's look (`DESIGN.md`): Geist at 400 and 500, the off-white plane, brand blue `#3b6be8` for the primary button only, 6px controls, hairlines instead of shadows.
- `src/worker.ts`: the edge. www redirects to the apex, `/docs`, `/_mintlify/*` and `/mintlify-assets/*` go to Mintlify (`DOCS_HOST`), the rest is `env.ASSETS`. `DOCS_PROXY` is `"true"` (Mintlify has the custom domain `dorks.build` with base path `/docs`); `"false"` would redirect `/docs` to `DOCS_HOST` instead.
- `pnpm --filter @dorks/site dev` for the site alone, `preview` to run the built site behind the Worker on `wrangler dev`, `deploy` to ship by hand (needs a Cloudflare login on the Handle account). Normally you don't: Cloudflare Workers Builds deploys `dorks-site` on every push to `main` that touches `apps/site/` or the lockfile (trigger "Deploy dorks.build from main", root `apps/site`, `pnpm run build` then `npx wrangler deploy`).
- Astro's guides: https://docs.astro.build. Run `astro dev --background` (and `astro dev stop`) when starting the dev server from an agent.
