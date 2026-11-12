# Configuration

There is no `.env` file and no hosted config. The server reads a few environment variables, and everything else is a **setting** you change in the UI (Boat key, Claude token, GitHub token, CLI secrets). Settings are stored encrypted in SQLite. The desktop app sets the variables below for you when it starts the server.

## Server (`apps/server`)

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `DORKS_DATA_DIR` | `~/Library/Application Support/Dorks` on macOS, `$XDG_DATA_HOME/dorks` elsewhere | Holds `dorks.db` (SQLite, WAL) and `secrets.json` (mode 600). |
| `DORKS_UI_PORT` | `4747` (`0` picks a free port) | UI listener, bound to `127.0.0.1`. |
| `DORKS_BRIDGE_PORT` | `4748` (`0` picks a free port) | Bridge listener, bound to `127.0.0.1`. The tunnel forwards to this port and only this one. |
| `DORKS_PUBLIC_URL` | none | `https://` URL of your tunnel. Sandboxes are created with `BRIDGE_URL` set to this (as `wss://`, path `/bridge`). Creating a Boat dork fails with `onboarding_incomplete` until it is set. It must stay stable, because existing sandboxes keep the URL they were created with. |
| `DORKS_TUNNEL_SERVICE` | none | The Dorks tunnel service (`https://`), set by the desktop shell with `DORKS_TUNNEL_INSTALL_KEY` when the public URL is the install's embedded wurmhol tunnel. Each new sandbox is registered there for a ticket its bridge trades for wurmhol grants. In the shell's own environment it overrides the hosted service (default `https://tunnels.dorks.build`). |
| `DORKS_TUNNEL_INSTALL_KEY` | none | This install's key for the tunnel service (`dti_` + 64 hex). Secret; the shell keeps it in `tunnel-install-key` (0600). |
| `DORKS_OWNER_TOKEN` | generated | Bearer token for the UI API. When unset, one is generated into `secrets.json` on first run. |
| `DORKS_UI_ORIGINS` | `tauri://localhost`, `http://tauri.localhost`, `http://localhost:3000`, `http://127.0.0.1:3000` | Comma-separated browser origins allowed by CORS. |
| `BASE_SNAPSHOT_ID` | none | Default Boat base snapshot. The `baseSnapshotId` setting wins when set. |
| `BOX_PROVIDER` | `boat` | `boat`, or `sim` for the local simulator and tests. |
| `SIM_HOST_KEY` | none | Required when `BOX_PROVIDER=sim`; guards the `/sim/*` routes. |

`secrets.json` holds three keys, generated on first run: `bridgeSecretKey` (the per-dork bridge secret is `HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)`), `encryptionKey` (AES-GCM, 32 bytes, base64) and `ownerToken`. Back it up together with `dorks.db`: without `encryptionKey` the stored tokens cannot be decrypted.

On start the server prints one JSON line, for example `{"ready":true,"ui":"http://127.0.0.1:4747","bridge":"ws://127.0.0.1:4748/bridge"}`. `GET /api/health` answers `{"ok":true}` without auth.

## Settings (UI or `PUT /api/settings`)

| Setting | What it is |
|---|---|
| `boatKey`, `boatOrg` | Boat API key, and an optional organization id. See [Boat](boat.md). |
| `baseSnapshotId` | The Boat snapshot new sandboxes start from. |
| `boatEnvironment` | Name of the Boat environment that signs Codex in with your ChatGPT account. |
| `claudeToken` | A `claude setup-token` value. Sent to a sandbox only over its authenticated bridge socket. |
| `githubToken` | See [GitHub](github.md). |
| `sleepMinutes` | Idle minutes before a sandbox is paused (default 5). |
| `commentPolicy` | Whose PR comments wake a dork: `all`, or an allowlist of logins. |
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

## In-sandbox bridge (`infra/bridge`)

Set by the server when it creates the sandbox: `DORK_ID`, `BRIDGE_URL`, `BRIDGE_SECRET`. Tuning variables are listed in [infra/bridge/README.md](../infra/bridge/README.md). The `screenshot_share` tool also reads Playwright's own `PLAYWRIGHT_BROWSERS_PATH` (default `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright` on macOS) to find a Chromium when no Chrome is installed.

## Adding a variable

Read it by its exact name in `apps/server/src/config.ts` and add a row here. Prefer a setting over a variable when a user should be able to change it without restarting the server. Never put a secret behind a `VITE_` prefix: those ship to the browser.
