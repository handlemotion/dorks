# Desktop app (macOS)

`apps/desktop` is a [Tauri 2](https://tauri.app) shell. It is the whole product on a Mac: it runs the `dorks-server` sidecar (Bun, Hono, SQLite; `apps/server`), shows the static web UI, and gives the UI a few native abilities. Architecture of the server and the bridge protocol: [architecture.md](architecture.md).

```
Dorks.app
 ├─ dorks-desktop        Tauri shell (Rust): supervision, tray, commands
 ├─ dorks-server         sidecar, supervised by the shell
 └─ UI                   static SPA from apps/web, in a webview (tauri://localhost)
```

## What the shell does

- **First run:** creates `~/Library/Application Support/Dorks` (0700; override with `DORKS_APP_DIR`), generates the owner token (`owner-token`, 0600), picks ports (tries 4747 and 4748, then free ones, and remembers them in `settings.json`).
- **Supervises the server:** spawns it with the environment below, polls `GET /api/health`, restarts it when it exits or stops answering (exponential backoff, gives up after 5 failures in 2 minutes and shows "failed" until you choose Restart Server), stops it with SIGTERM and then SIGKILL after 5 s on quit. Its output goes to `logs/server.log`. A server orphaned by a killed shell is stopped on the next start (`server.pid`).
- **Menu bar:** server and tunnel status, Open Dorks, Open Data Folder, Open Server Log, Restart Server, Quit. Closing the window leaves the app running in the menu bar.
- **Tunnel:** the interface lives in `crates/shell-core/src/tunnel.rs`. Today: a user-supplied public URL (`DORKS_PUBLIC_URL` in the environment, or saved from the UI with `set_public_url`), or the wurmhol client, which is a stub that reports "not implemented". Only the bridge port is ever exposed.
- **Keep awake:** a power assertion (`caffeinate -i -w <pid>`, released automatically if the app dies) while the UI reports active dorks. Setting: `whileActive` (default), `always`, `never`.

## Contract with the server

Defined in one file, `crates/shell-core/src/contract.rs`. The server gets this environment (and only this plus `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`):

| Variable | Value |
|---|---|
| `DORKS_DATA_DIR` | `<app dir>/server` |
| `DORKS_OWNER_TOKEN` | the owner token |
| `DORKS_UI_PORT`, `DORKS_BRIDGE_PORT` | loopback ports |
| `DORKS_PUBLIC_URL` | `https://` URL of the bridge port, when a tunnel or user URL is available |
| `DORKS_PARENT_PID` | the shell's pid. The server should exit if it disappears (optional; the shell also reaps orphans) |

## What the UI gets

`window.__DORKS__` is set before any page script runs: `{ apiUrl, uiPort, bridgePort, publicUrl, ownerToken, dataDir, version, tunnel: { kind, state, error }, bootError }`. Call the API with `Authorization: Bearer <ownerToken>` against `apiUrl`. If the server could not be set up, only `bootError` is present. `window.__DORKS__` is replaced when the config changes, and the event `dorks://runtime-config` fires; `dorks://server-status` carries `{ state: "starting" | "running" | "restarting" | "failed" | "stopped", ... }`.

Commands (`invoke` from `@tauri-apps/api/core`, or `window.__TAURI__.core.invoke`):

| Command | Does |
|---|---|
| `runtime_config()` / `server_status()` | current config / status |
| `restart_server()` | restart now, reset the failure history |
| `set_public_url(url \| null)` | validate (https, or http for localhost), save, restart tunnel and server |
| `open_data_dir()` | reveal the app directory in Finder |
| `gh_status()` | `{ installed, loggedIn }` for the GitHub CLI |
| `read_gh_token()` | **asks the user in a native dialog**, then returns `gh auth token`, or `null` if gh is missing or logged out; `"consent_denied"` if declined. The UI then stores it with `PUT /api/settings { githubToken }` |
| `set_keep_awake(active)` | tell the shell dorks are (not) working; returns whether the assertion is held |
| `keep_awake_mode()` / `set_keep_awake_mode(mode)` | the setting |
| `install_update()` | check for and install an update (release builds only) |

The window only ever shows the bundled UI; other `http(s)` links open in the browser.

## Develop

Needs Rust ([rustup](https://rustup.rs)) and Xcode command line tools.

```sh
pnpm install
pnpm --filter @dorks/desktop dev          # builds a stub sidecar, copies the UI, runs the app
pnpm --filter @dorks/desktop build:dev    # unsigned debug Dorks.app in src-tauri/target/debug/bundle/macos
pnpm --filter @dorks/desktop test         # shell-core tests (also run in CI by `pnpm test`)
pnpm --filter @dorks/desktop check:app    # clippy + tests for the whole workspace (macOS)
```

- Point at a real server: `DORKS_SERVER_DIST=<dir with dorks-server-<target triple>>` for `prepare:sidecar` (default `apps/server/dist`), or `DORKS_SERVER_BIN=/path/to/dorks-server` at run time.
- Point at the built web SPA: `DORKS_WEB_DIST` for `prepare:ui` (default `apps/web/dist/client`). Until `apps/web` builds a static SPA with an `index.html`, a placeholder page in `ui/` is used; it shows the status and exercises the commands.
- Use a throwaway data directory when trying things: `DORKS_APP_DIR=/tmp/dorks-test`.
- Icons are placeholders drawn by `scripts/make-icons.mjs`; replace the art and run `pnpm tauri icon src-tauri/icons/source.png`.

Until `apps/server` exists the sidecar is `dorks-server-stub` (`crates/shell-core/src/bin`), which speaks the contract and nothing else.

## Release

`.github/workflows/desktop-release.yml` builds a universal (Apple silicon + Intel) app, signs it with a Developer ID certificate, notarizes it, and attaches the `.dmg`, the updater bundle and `latest.json` to a **draft** GitHub release. Push a tag `desktop-v<version>` (matching `version` in `src-tauri/tauri.conf.json`), or run it by hand (`unsigned` makes a test build).

One-time setup, in the repository settings. Nothing secret is in the repo.

1. Apple: a Developer ID Application certificate exported as `.p12`. Secrets `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
2. Updater: `pnpm --filter @dorks/desktop tauri signer generate -w ~/.tauri/dorks.key`. Secrets `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), variable `TAURI_UPDATER_PUBKEY` (the public key). The workflow writes the updater config at build time, so no key is committed, and local builds have no updater (the `updater` cargo feature is off).
3. The server: `apps/server` `build` writes `dorks-server-aarch64-apple-darwin` and `dorks-server-x86_64-apple-darwin` into `apps/server/dist`. The release refuses to fall back to the stub.

The sidecar is signed with the app's identity and the hardened runtime. `src-tauri/Entitlements.plist` grants the JIT entitlements a Bun binary needs.

## Not done yet

- The wurmhol tunnel client (the trait and stub exist).
- The real web SPA in the window (placeholder page until `apps/web` has a static build), and the first-run onboarding in it (Boat key, snapshot, GitHub token via `read_gh_token`).
- Real icons.
- The release workflow has not run: it needs the secrets above and `apps/server`.
