# Configuration

There is no `.env` file and no hosted config. The server reads a few environment variables, and everything else is a **setting** you change in the UI (Boat key, Claude token, connecting GitHub, CLI secrets). Settings are stored encrypted in SQLite. The desktop app sets the variables below for you when it starts the server.

## Server (`apps/server`)

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `DORKS_DATA_DIR` | `~/Library/Application Support/Dorks` on macOS, `$XDG_DATA_HOME/dorks` elsewhere | Holds `dorks.db` (SQLite, WAL) and `secrets.json` (mode 600). |
| `DORKS_UI_PORT` | `4747` (`0` picks a free port) | UI listener, bound to `127.0.0.1`. The server's only listener: it dials out to sandboxes, so nothing listens for them. |
| `DORKS_OWNER_TOKEN` | generated | Bearer token for the UI API. When unset, one is generated into `secrets.json` on first run. |
| `DORKS_UI_ORIGINS` | `tauri://localhost`, `http://tauri.localhost`, `http://localhost:3000`, `http://127.0.0.1:3000` | Comma-separated browser origins allowed by CORS. |
| `BASE_SNAPSHOT_ID` | none | Default Boat base snapshot. The `baseSnapshotId` setting wins when set. |
| `BOX_PROVIDER` | `boat` | The cloud provider: `boat`, or `sim` for the local simulator and tests. Local dorks always run on this computer ([local dorks](local-dorks.md)). |
| `DORKS_LOCAL` | on | `0` turns local dorks off. A server with `DORKS_ORG_ID` never offers them. |
| `DORKS_NODE_BIN` | `node` on the owner's login PATH | The Node.js (22 or later) local dorks' bridges run with. |
| `DORKS_GIT_BASE_URL` | `https://github.com` | Where local dorks clone repositories from (`<base>/<owner>/<name>.git`); development points it at local remotes (`file://…`). |
| `SIM_HOST_KEY` | none | Required when `BOX_PROVIDER=sim`; guards the `/sim/*` routes. |
| `DORKS_AGY_BIN` | none | The Antigravity CLI for the Google sign-in when there is no `agy` on `PATH` (or in `~/.local/bin`); without one, Dorks downloads Google's current build into the data dir, checksum-verified. See [Boat](boat.md). |
| `DORKS_BOAT_BIN` | none | The Boat CLI to use when there is no `boat` on `PATH` (or in `~/.ascii/bin`). The desktop app sets it to the copy it bundles. See [Boat](boat.md#sign-in-with-the-boat-cli). |
| `DORKS_CLOUD_URL` | `https://api.dorks.build` | The cloud relay the iPhone app reaches this server through ([mobile](mobile.md)). Empty turns the phone link off. |
| `DORKS_SITE_URL` | `https://dorks.build` | The website the app opens to sign in to Dorks Cloud; it hands the sign-in back with a `dorks://auth` link ([mobile](mobile.md)). |
| `DORKS_CLOUD_JWKS_URL` | `<DORKS_CLOUD_URL>/api/auth/jwks` | The cloud's keys for teammates' identity tokens ([cloud](cloud.md)). Tokens must also name `DORKS_CLOUD_URL` as `iss` and `aud`. |
| `DORKS_ORG_ID` | the org the cloud reports for this server's pairing | The dorks-cloud organization this server belongs to; the server Dorks runs for a Teams or Cloud org is started with it. Relayed tokens for any other org are refused. |
| `GH_TOKEN`, then `GITHUB_TOKEN` | none (the GitHub CLI's login) | Secret. Overrides the GitHub CLI's login, the way `gh` itself resolves them, for development and the e2e. GitHub must still be connected (`githubConnected`). The desktop app never passes them. See [GitHub](github.md). |

`secrets.json` holds three keys, generated on first run: `bridgeSecretKey` (the per-dork bridge secret is `HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)`), `encryptionKey` (AES-GCM, 32 bytes, base64) and `ownerToken`. Back it up together with `dorks.db`: without `encryptionKey` the stored tokens cannot be decrypted.

On start the server prints one JSON line, for example `{"ready":true,"ui":"http://127.0.0.1:4747","bridge":"ws://127.0.0.1:4748/bridge"}`. `GET /api/health` answers `{"ok":true}` without auth.

## Settings (UI or `PUT /api/settings`)

| Setting | What it is |
|---|---|
| `boatKey`, `boatOrg` | Boat API key, and an optional organization id. See [Boat](boat.md). |
| `baseSnapshotId` | The Boat snapshot new sandboxes start from. |
| `boatEnvironment` | Name of the Boat environment that signs Codex in with your ChatGPT account. |
| `claudeToken` | A `claude setup-token` value. Sent to a sandbox only over its authenticated bridge socket. |
| `githubConnected` | Act as the GitHub CLI's login. See [GitHub](github.md). |
| `sleepMinutes` | Idle minutes before a sandbox is paused (default 5). |
| `commentPolicy` | Whose PR comments wake a dork: `all`, or an allowlist of logins. |
| `defaultLocation` | Where new sessions start: `cloud` (default) or `local`, the composer's remembered Cloud / Local choice. Only the owner on this computer can change it. |
| Secrets (`PUT /api/secrets/:name`) | Environment variables exported inside every sandbox (for example a deploy token). Names match `^[A-Z][A-Z0-9_]{0,63}$`, values are at most 16 KB, and they are never shown again. |

Token settings are write-only: reads return booleans, and an empty string clears one.

## Desktop app (`apps/desktop`)

| Variable | Purpose |
|---|---|
| `DORKS_APP_DIR` | App support directory (default `~/Library/Application Support/Dorks`). Use a throwaway one when testing. |
| `DORKS_SERVER_BIN` | Run this server binary instead of the bundled sidecar. |
| `DORKS_SERVER_DIST`, `DORKS_WEB_DIST` | Build-time inputs for `prepare:sidecar` and `prepare:ui`. See [desktop.md](desktop.md). |

## Web (`apps/web`)

No build-time variables. In `vp dev` only, `?server=<url>&token=<token>` skips the connect screen. The mock server reads `MOCK_PORT`, `MOCK_TOKEN`, `MOCK_CONFIGURED` and `MOCK_TICK`.

## iPhone app (`apps/mobile`)

Read at build time; `EXPO_PUBLIC_*` values ship inside the app, so never put a secret behind that prefix. See [apps/mobile/README.md](../apps/mobile/README.md).

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_CLOUD_URL` | The relay's origin (default `https://api.dorks.build`). |
| `EXPO_PUBLIC_DEV_PASSWORD` | `1` adds an email and password sign-in, for the simulator. Never set it for a TestFlight build. |
| `EAS_PROJECT_ID` | The EAS project (or `extra.eas.projectId`); turns on EAS Update. |

## In-sandbox bridge (`infra/bridge`)

Set by the server when it creates the sandbox: `DORK_ID`, `BRIDGE_PORT` (the loopback port the bridge listens on, `4748`) and `BRIDGE_SECRET`. A local dork's bridge also gets `DORKS_LOCAL_BOX=1` (its agent is told it runs on the owner's computer) and `DORKS_PARENT_PID` (it exits when the server does), with `BRIDGE_SECRET_FILE` instead of `BRIDGE_SECRET` ([local dorks](local-dorks.md)). A cloud org's sandbox instead gets `DORKS_TRANSPORT=s2` and `DORKS_WORKER_URL` (the Worker's base URL): the bridge then reaches s2 and the Worker itself and listens on no port ([architecture](architecture.md), "Cloud sessions"). Tuning variables are listed in [infra/bridge/README.md](../infra/bridge/README.md). The `screenshot_share` tool also reads Playwright's own `PLAYWRIGHT_BROWSERS_PATH` (default `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright` on macOS) to find a Chromium when no Chrome is installed.

## Adding a variable

Read it by its exact name in `apps/server/src/config.ts` and add a row here. Prefer a setting over a variable when a user should be able to change it without restarting the server. Never put a secret behind a `VITE_` prefix: those ship to the browser.
