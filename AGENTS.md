# Contributor and agent notes

Start with [CONTRIBUTING.md](CONTRIBUTING.md) (layout, dev loop, tests) and [docs/architecture.md](docs/architecture.md) (the contract between server, web, bridge and desktop shell).

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Running things

Test changes against running servers, not only unit tests.

- Whole stack: `pnpm dev` runs the real server with simulated sandboxes plus the web app (data in `.dev-data`, delete it for a clean start). It prints the URL to open, with the dev owner token in it. `pnpm dev:server` runs only the server and the sandbox simulator.
- Web against an in-memory mock server: `pnpm dev:mock`. Desktop shell: `pnpm dev:desktop`.
- For a throwaway instance that cannot collide with another one, set `DORKS_DATA_DIR=<temp dir>`, `DORKS_UI_PORT=0` and `DORKS_BRIDGE_PORT=0`; the server prints one JSON `ready` line with the ports.
- `pnpm test` runs every package; `pnpm e2e` builds the compiled server and runs the server e2e (sim and real bridge, with a secret scan), then the web e2e. `pnpm e2e:server` / `pnpm e2e:web` run one of them.

## UI rules

No drop shadows, minimal borders, theme-following glass, white user bubbles. Full text and the contrast numbers: `packages/ui/README.md` ("Design rules").

- **No drop shadows, ever** (any theme, any component, including popovers, menus, dialogs, bubbles and cards). The theme resets Tailwind's shadow tokens, so `shadow-*` classes in the published shadcn / AI Elements files are no-ops: do not edit those files. Do not write `shadow-*`, `box-shadow`, `drop-shadow` or `text-shadow` yourself; `pnpm test` runs `packages/ui/scripts/check-ui-rules.mjs` and fails on them.
- **Minimal borders.** Separate surfaces with fill, spacing and glass layering. Add a border only where fill contrast truly fails (light-theme form controls, focus rings); check with `node packages/ui/scripts/contrast.mjs` (1.15:1 or more needs no border).
- **The glass tint follows the app theme**, never the OS: define every new surface token for light and dark (`packages/ui/src/glass.css`).
- **User message bubbles are white** in both themes; assistant messages are unbubbled.
- Verify UI headless (Playwright, headless Chromium); never launch a headed browser or take over the screen.
- Use the shadcn preset tokens and components (`@dorks/ui`), not bespoke CSS. The preset code and how to change it are in `packages/ui/README.md`.

## Secrets

- **Never print, log, echo or commit secret values.** The server's keys live in `<data dir>/secrets.json`; do not `cat` it. Refer to variables by name; the reference is `docs/env.md`.
- **New env var in code:** read it by its exact name in `apps/server/src/config.ts` and add a row to `docs/env.md`. Prefer a stored setting when a user should change it from the UI.
- `VITE_*` values ship to browsers: never put a real secret behind that prefix.
