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
- **Tunnel:** the interface lives in `crates/shell-core/src/tunnel.rs`. A user-supplied public URL (`DORKS_PUBLIC_URL` in the environment, or saved from the UI with `set_public_url`) always wins and starts nothing. Otherwise the [wurmhol provider](#tunnel-wurmhol) runs the wurmhol client against the bridge port. Only the bridge port is ever exposed; the UI port stays on loopback.
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

`window.__DORKS__` is set before any page script runs: `{ apiUrl, uiPort, bridgePort, publicUrl, ownerToken, dataDir, version, tunnel: { kind, state, error, tokenSet }, bootError }`. `tunnel.state` is `ready`, `error` (could not start; `error` says why) or `lost` (it was up and went away; the shell restarts it after 30 s, then `publicUrl` is set again). Call the API with `Authorization: Bearer <ownerToken>` against `apiUrl`. If the server could not be set up, only `bootError` is present. `window.__DORKS__` is replaced when the config changes, and the event `dorks://runtime-config` fires; `dorks://server-status` carries `{ state: "starting" | "running" | "restarting" | "failed" | "stopped", ... }`.

Commands (`invoke` from `@tauri-apps/api/core`, or `window.__TAURI__.core.invoke`):

| Command | Does |
|---|---|
| `runtime_config()` / `server_status()` | current config / status |
| `restart_server()` | restart now, reset the failure history |
| `set_public_url(url \| null)` | validate (https, or http for localhost), save, restart tunnel and server |
| `set_wurmhol_token(token \| null)` | save (0600 file, never returned to the UI) or remove the wurmhol token, restart tunnel and server |
| `tunnel_status()` | `{ kind, state, error, tokenSet }` |
| `open_data_dir()` | reveal the app directory in Finder |
| `gh_status()` | `{ installed, loggedIn }` for the GitHub CLI |
| `read_gh_token()` | **asks the user in a native dialog**, then returns `gh auth token`, or `null` if gh is missing or logged out; `"consent_denied"` if declined. The UI then stores it with `PUT /api/settings { githubToken }` |
| `set_keep_awake(active)` | tell the shell dorks are (not) working; returns whether the assertion is held |
| `keep_awake_mode()` / `set_keep_awake_mode(mode)` | the setting |
| `install_update()` | check for and install an update (release builds only) |

The window only ever shows the bundled UI; other `http(s)` links open in the browser.

## Tunnel: wurmhol

Boat sandboxes connect *out* to the server, so the bridge port needs a public URL. `crates/shell-core/src/wurmhol.rs` runs the wurmhol client (`packages/cli` of handlemotion/wurmhol, MIT) as `wurmhol <bridge port> --json` and reads `{"url","port","id"}` from its first stdout line:

- **Token:** the user creates one at dirt.wurmhol.com (menu, Tokens) and pastes it in Settings (`set_wurmhol_token`). It is stored in `wurmhol-token` (0600) and reaches the client only as `WURMHOL_TOKEN` in its environment, never as an argument or in `settings.json`. `settings.json` may hold `wurmholServer` (a self-hosted install, passed as `WURMHOL_URL`) and `wurmholArgs` (extra arguments after `<port> --json`, so a flag the relay learns later needs no shell change).
- **Finding the client:** `$WURMHOL_BIN`, else `wurmhol` next to the app, else `PATH` plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` (a menu-bar app starts with a minimal PATH and the client runs on node). It is not bundled yet (see gap 5).
- **Both client shapes work.** Today's client prints the URL and exits while a daemon keeps the pipe: health is `wurmhol ls --json` still listing the id, stop is `wurmhol stop <id>`. A client that stays in the foreground (proposed below) is supervised as a process and stopped with SIGTERM.
- **Lost pipe:** reported once; the shell marks `tunnel.state = "lost"`, waits 30 s, then restarts tunnel and server so the new URL reaches the server (`DORKS_PUBLIC_URL`) and the UI (`dorks://runtime-config`).
- The client's stderr goes to `logs/wurmhol.log`.

### What the hosted relay cannot do yet

Read from handlemotion/wurmhol (`docs/spec/v1.md`, ADRs 0003 and 0006, `packages/cli`, `apps/worker/src/{viewer,routes/connect}.ts`). WebSocket passthrough is fine: the protocol multiplexes browser WebSockets (`ws-open`, `ws-message`) and sends a 20 s heartbeat. The rest blocks the bridge:

1. **Machine access (blocker).** Every request to `<id>.pipe.wurmhol.com` needs the `__Host-wurmhol` cookie from an org member's browser sign-in; a request without it gets 401 `sign in to view this pipe`. A bridge in a Boat sandbox is a Node WebSocket client with no browser session, so it cannot connect through a pipe today. *Proposal:* a per-pipe access key. `wurmhol <port> --access key` makes the relay accept requests carrying `Authorization: Bearer <key>` (or `x-wurmhol-key`), strip it before forwarding, and still apply org billing and limits; `--json` then also prints `key`. Dorks passes the key to the server, which gives it to each sandbox so the bridge's WebSocket sends it; the per-dork HMAC remains the real authentication. (`--public` pipes are a worse fit: the spec rules out public links for abuse reasons.)
2. **No stable hostname (blocker).** Pipe ids are random, never reused (spec section 6), and a dropped client keeps its id for only 60 s. The bridge URL is baked into a sandbox when it is created and a paused sandbox resumes days later, so the URL must survive restarts and sleep. *Proposal:* `wurmhol <port> --name dorks` reserves `<name>-<org hash>.pipe.<domain>` for the token's org, so the same name always returns the same URL and reconnects at any time (`409` if it is live from another machine).
3. **12-hour cap per pipe** (`LIMIT_SHARE_SECONDS`, default 12 h), plus 5 active pipes and 100 GB a month per org. *Proposal:* reserved names are exempt from the 12 h cap (or the cap is per token).
4. **No non-interactive registration.** Tokens are made by a signed-in person in the console. Interim: paste the token (done). *Proposal:* a device-code flow (`POST` a code, the console approves it, the client polls) that the app can start with one button.
5. **The client cannot be bundled.** It needs Node 20+ on the user's Mac, and it detaches by spawning `process.execPath` on its own script, which breaks inside a single compiled binary. *Proposal:* a `--foreground` flag (no detaching; print the JSON line, stay running) and the `Tunnel` class exported from the package, so Dorks can compile the client into a sidecar or run it inside the Bun server.
6. **Licensing to settle before bundling:** the client is MIT, but `@wurmhol/protocol`, which it embeds, sits with the AGPL-3.0 packages. Same owner, so it is a decision, not a blocker.

Until 1 and 2 are fixed, the hosted relay carries a pipe but a sandbox bridge cannot use it: set a public URL yourself (`DORKS_PUBLIC_URL` or `set_public_url`), for example a Cloudflare tunnel, a reverse proxy or your own wurmhol install.

## Develop

Needs Rust ([rustup](https://rustup.rs)), Xcode command line tools and [Bun](https://bun.sh) (it compiles the server).

```sh
pnpm install
pnpm --filter @dorks/desktop dev          # builds the real server and the web SPA, runs the app
pnpm --filter @dorks/desktop build:dev    # unsigned debug Dorks.app in src-tauri/target/debug/bundle/macos
pnpm --filter @dorks/desktop test         # shell-core tests (also run in CI by `pnpm test`)
pnpm --filter @dorks/desktop check:app    # clippy + tests for the whole workspace (macOS; needs `prepare:all` once)
pnpm --filter @dorks/desktop prepare:stub # stand-in server + placeholder page, to work on the shell without Bun
```

- **Sidecar:** `prepare:sidecar` (run by `dev` and `build`) puts `dorks-server-<target triple>` in `src-tauri/binaries`. It takes the server from `apps/server/dist` (`DORKS_SERVER_DIST`) and rebuilds it first when it is missing or older than `apps/server/src`: with the server's `build` script once it has one, otherwise `bun build --compile --target=bun-darwin-arm64|x64`. About 60 MB per architecture. There is no silent fallback to the stub: `--stub` has to be asked for.
- **UI:** `prepare:ui` builds `apps/web` (`pnpm --filter @dorks/web build`) and copies `apps/web/dist/client` (`DORKS_WEB_DIST`) into `dist`. `--no-build` reuses an existing build; `--placeholder` copies the status page in `ui/`.
- At run time `DORKS_SERVER_BIN=/path/to/dorks-server` overrides the bundled sidecar.
- Use a throwaway data directory when trying things: `DORKS_APP_DIR=/tmp/dorks-test`.
- Icons are placeholders drawn by `scripts/make-icons.mjs`; replace the art and run `pnpm tauri icon src-tauri/icons/source.png`.

## Release

`.github/workflows/desktop-release.yml` builds a universal (Apple silicon + Intel) app, signs it with a Developer ID certificate, notarizes it, and attaches the `.dmg`, the updater bundle and `latest.json` to a **draft** GitHub release. Push a tag `desktop-v<version>` (matching `version` in `src-tauri/tauri.conf.json`), or run it by hand (`unsigned` makes a test build).

One-time setup, in the repository settings. Nothing secret is in the repo.

1. Apple: a Developer ID Application certificate exported as `.p12`. Secrets `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
2. Updater: `pnpm --filter @dorks/desktop tauri signer generate -w ~/.tauri/dorks.key`. Secrets `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), variable `TAURI_UPDATER_PUBKEY` (the public key). The workflow writes the updater config at build time, so no key is committed, and local builds have no updater (the `updater` cargo feature is off).
3. Nothing to configure for the server or the UI: the workflow installs Bun, compiles `apps/server` for both architectures and builds `apps/web` (`prepare-sidecar`, `prepare-ui`), and neither can fall back to a stub or a placeholder.

The sidecar is signed with the app's identity and the hardened runtime. `src-tauri/Entitlements.plist` grants the JIT entitlements a Bun binary needs.

## Not done yet

- A wurmhol relay that a sandbox bridge can use (access key, reserved names; see the gaps above), and bundling its client.
- The window was run with the real server and the real SPA (first-run setup renders and talks to the sidecar); the wurmhol token field and the tunnel state are not in the web app's Settings yet.
- Real icons.
- The release workflow has not run: it needs the secrets above.
