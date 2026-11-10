# Contributor and agent notes

Start with [docs/development.md](docs/development.md) (layout, dev loop, tests) and [docs/architecture.md](docs/architecture.md) (the contract between server, web, bridge and desktop shell). For any UI work, read [DESIGN.md](DESIGN.md) first: the layout, spacing, components and checks the app's design follows.

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Running things

Test changes against running servers, not only unit tests.

- Whole stack: `pnpm dev` runs the real server with simulated sandboxes plus the web app (data in `.dev-data`, delete it for a clean start). It prints the URL to open, with the dev owner token in it. `pnpm dev:server` runs only the server and the sandbox simulator.
- Web against an in-memory mock server: `pnpm dev:mock`. Desktop shell: `pnpm dev:desktop`.
- For a throwaway instance that cannot collide with another one, set `DORKS_DATA_DIR=<temp dir>`, `DORKS_UI_PORT=0` and `DORKS_BRIDGE_PORT=0`; the server prints one JSON `ready` line with the ports.
- `pnpm test` runs every package; `pnpm e2e` builds the compiled server and runs the server e2e (sim and real bridge, with a secret scan).

## Testing

The product intentionally has few tests. Do not add or run tests by reflex.

- **Claude is the only provider we test for real right now.** Codex is aggressively deprioritized: keep it compiling and its fake-Codex tests passing, but do not spend time on live Codex runs, Codex-only polish or new Codex coverage. Validate live behaviour with Claude (the `CLAUDE_CODE_OAUTH_TOKEN` in Doppler, `dorks` / `dev_live`).

- **Only real tests on real business logic**: the lifecycle state machine and timers, the Boat driver, the PR poller, crypto, the bridge protocol, the server e2e. Each must be light, high value and able to catch a real bug.
- **No low-signal tests**: no UI snapshot or screenshot tests, no tests that restate the implementation, no mocks of the thing under test, no tests for markup, styling or copy that will change within a day.
- **No unnecessary runs.** Do not run the full suite or `pnpm e2e` to confirm a UI tweak; typecheck and a look in a headless browser are enough. Run the tests that cover the logic you changed.
- **Never launch the desktop app or a headed browser to check a change** unless the change is native window behaviour, and then only unfocused. Do not take over the user's screen.
- When a test is flaky, slow or has not caught a bug, delete it instead of maintaining it.

## UI rules

No drop shadows (dropdown menus excepted), minimal borders, a flat off-white app (onboarding keeps the `#f2f2f2` fill), light grey user bubbles, 6px controls. Full text and the contrast numbers: `packages/ui/README.md` ("Design rules").

- **No drop shadows, except dropdown menus** (any theme, any other component: popovers, dialogs, bubbles, cards). The one shadow is the soft one in `packages/ui/src/components/ui/dropdown-menu.tsx`; don't add another. The theme resets Tailwind's shadow tokens, so `shadow-*` classes in the published shadcn / AI Elements files are no-ops: do not edit those files. Do not write `shadow-*`, `box-shadow`, `drop-shadow` or `text-shadow` yourself; `pnpm test` runs `packages/ui/scripts/check-ui-rules.mjs` and fails on them.
- **Minimal borders.** Separate surfaces with fill and spacing. Add a border only where fill contrast truly fails (light-theme form controls, focus rings); check with `node packages/ui/scripts/contrast.mjs` (1.15:1 or more needs no border).
- **The app is opaque and flat**: `--app` behind everything, `--surface` for what is raised on it, nothing translucent or blurred. Tokens follow the app theme, never the OS: define every new surface token for light and dark (`packages/ui/src/glass.css`).
- **User message bubbles** are the composer's light grey in light and white in dark; assistant messages are unbubbled.
- **Buttons and inputs are 6px** (`--control-radius`), not pills. Only onboarding's step buttons are pills.
- Verify UI headless (Playwright, headless Chromium); never launch a headed browser or take over the screen.
- Use the shadcn preset tokens and components (`@dorks/ui`), not bespoke CSS. The preset code and how to change it are in `packages/ui/README.md`.
- **Empty states** all use `EmptyState` (`apps/web/src/components/EmptyState.tsx`, on shadcn's `Empty`), top to bottom:
  1. a small figure from `@lucasmarkes/hairline` (an object shown holding nothing: a bare drawer, a laptop with a blank screen), never an icon or a sad face. Pick one of its 33 figures and add it to `FIGURES`; when none fits, make one with `/hairline-create`;
  2. one or two lines: a short title (`No artifacts yet`), and a one-sentence description only when it says what will show up or how;
  3. the actions, only when there is something to do: one or two small outline buttons (`size="sm"`), in plain verbs (`Ask for a screenshot`). No action is better than one that does nothing.
  No bare "Nothing here" paragraphs, no second paragraph, no links instead of buttons.

## Secrets

- **Never print, log, echo or commit secret values.** The server's keys live in `<data dir>/secrets.json`; do not `cat` it. Refer to variables by name; the reference is `docs/env.md`.
- **New env var in code:** read it by its exact name in `apps/server/src/config.ts` and add a row to `docs/env.md`. Prefer a stored setting when a user should change it from the UI.
- `VITE_*` values ship to browsers: never put a real secret behind that prefix.
