# Site agent notes

`dorks.build`: the marketing site (Astro, static) and the edge Worker `dorks-site` that serves it. The docs are `apps/docs` (Mintlify), served at `/docs` by this Worker. The relay is a separate Worker, `dorks-cloud`, on `api.dorks.build`.

- `src/pages`, `src/layouts`, `src/components`: the site. Plain Astro and CSS, no client JavaScript unless a section needs it. Follow the app's look (`DESIGN.md`): Geist at 400 and 500, the off-white plane, brand blue `#3b6be8` for the primary button only, 6px controls, hairlines instead of shadows.
- `src/worker.ts`: the edge. www redirects to the apex, `/docs`, `/_mintlify/*` and `/mintlify-assets/*` go to Mintlify (`DOCS_HOST`), the rest is `env.ASSETS`. `DOCS_PROXY` is `"false"` until Mintlify has the `dorks.build/docs` custom domain; then `/docs` is proxied instead of redirected.
- `pnpm --filter @dorks/site dev` for the site alone, `preview` to run the built site behind the Worker on `wrangler dev`, `deploy` to ship (needs a Cloudflare login on the Handle account).
- Astro's guides: https://docs.astro.build. Run `astro dev --background` (and `astro dev stop`) when starting the dev server from an agent.
