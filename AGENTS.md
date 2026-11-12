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
- `pnpm check` lints the workspace (Vite+, `vp check`); `pnpm test` runs every package; `pnpm e2e` builds the compiled server and runs the server e2e (sim and real bridge, with a secret scan).

## Credentials and cloud sessions

Live credentials are in Doppler, project `dorks`, config `dev_live`: `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `BOAT_API_KEY`, `BOAT_ORG`. Cloud sessions have `DOPPLER_TOKEN` set but no `doppler` CLI, so read one value with the API and pipe it straight where it goes, never into the transcript:

```sh
curl -sS -u "$DOPPLER_TOKEN:" "https://api.doppler.com/v3/configs/config/secret?project=dorks&config=dev_live&name=CLAUDE_CODE_OAUTH_TOKEN" \
  | python3 -c 'import json,sys; print(json.dumps({"claudeToken": json.load(sys.stdin)["value"]["raw"]}))' \
  | curl -sS -X PUT "$UI/api/settings" -H "Authorization: Bearer dev-owner-token" -H "Content-Type: application/json" --data-binary @-
```

Real Claude through the whole stack in a cloud container (verified): the container runs as root, so add an unprivileged user (`useradd -m dorkrun`), drop the session's own Claude variables from the server's env (`ANTHROPIC_BASE_URL`, `SESSION_INGRESS_URL`, every `CLAUDE_CODE_*`) so the bridge's child CLI only sees the token you saved, then:

```sh
BRIDGE_IMPL=real CLAUDE_BIN="$(command -v claude)" CLAUDE_RUN_AS=dorkrun DORKS_E2E_ROOT=/tmp/de \
  DORKS_DATA_DIR=<temp dir> DORKS_UI_PORT=0 DORKS_BRIDGE_PORT=0 node scripts/dev.mjs --only server
```

Save the token as above, then drive it with `POST /api/dorks` and `GET /api/dorks/:id/events` ([docs/architecture.md](docs/architecture.md)).

Real Boat sandboxes from a cloud session: a Boat box dials back to the bridge, so give the bridge port a public URL with an embedded [Wurmhol](https://wurmhol.com/docs) tunnel from the Dorks tunnel service, the same way the desktop shell does ([docs/desktop.md](docs/desktop.md), "Tunnel: wurmhol"). It needs the service deployed (`infra/tunnels`) and only an outbound WebSocket through the proxy. Not yet run end to end: the access-key pipe this replaced was.

```sh
SVC=https://tunnels.dorks.build
KEY=dti_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')   # this session's install key; keep it out of the transcript
curl -s -X POST $SVC/v1/tunnel -H "authorization: Bearer $KEY" > /tmp/tunnel.json   # {tunnel: {url}, connector: {connector}}
WURMHOL_TOKEN=$(jq -r .connector.connector /tmp/tunnel.json) npx -y wurmhol@0.8 4748 --json   # prints {"url": ...} and returns
DORKS_PUBLIC_URL=$(jq -r .tunnel.url /tmp/tunnel.json) DORKS_TUNNEL_SERVICE=$SVC DORKS_TUNNEL_INSTALL_KEY=$KEY \
  DORKS_BRIDGE_PORT=4748 DORKS_UI_PORT=0 DORKS_OWNER_TOKEN=dev-owner-token DORKS_DATA_DIR=<temp dir> bun run apps/server/src/main.ts
```

Then `PUT /api/settings` with `boatKey`, `boatOrg`, `claudeToken` and `githubToken` from Doppler (one piped JSON body, as above). Saving the Boat key builds the base snapshot on Boat (about a minute); poll `GET /api/snapshot` until `ready`, then create a dork on a real repo. This spends Boat credit: `DELETE /api/dorks/:id` when done (it destroys the box), and `npx wurmhol stop 4748`.

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
