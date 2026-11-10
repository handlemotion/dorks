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
| `DORKS_TUNNEL_KEY` | access key of the wurmhol pipe, when the tunnel is a wurmhol pipe (not for a user URL) |
| `DORKS_PARENT_PID` | the shell's pid. The server should exit if it disappears (optional; the shell also reaps orphans) |

## What the UI gets

`window.__DORKS__` is set before any page script runs: `{ apiUrl, uiPort, bridgePort, publicUrl, ownerToken, dataDir, version, tunnel: { kind, state, error, approvalUrl, tokenSet }, bootError, chrome }` (`chrome` is described under "Window chrome"). `tunnel.state` is `ready`, `error` (could not start; `error` says why) or `lost` (it was up and went away; the shell restarts it after 30 s, then `publicUrl` is set again). Call the API with `Authorization: Bearer <ownerToken>` against `apiUrl`. If the server could not be set up, only `bootError` is present. `window.__DORKS__` is replaced when the config changes, and the event `dorks://runtime-config` fires; `dorks://server-status` carries `{ state: "starting" | "running" | "restarting" | "failed" | "stopped", ... }`.

Commands (`invoke` from `@tauri-apps/api/core`, or `window.__TAURI__.core.invoke`):

| Command | Does |
|---|---|
| `runtime_config()` / `server_status()` | current config / status |
| `restart_server()` | restart now, reset the failure history |
| `set_public_url(url \| null)` | validate (https, or http for localhost), save, restart tunnel and server |
| `open_tunnel_approval()` | open the pending wurmhol approval link (`tunnel.approvalUrl`) in the browser; takes no URL |
| `set_wurmhol_token(token \| null)` | save (0600 file, never returned to the UI) or remove the wurmhol token, restart tunnel and server |
| `tunnel_status()` | `{ kind, state, error, approvalUrl, tokenSet }`; `state` is `ready`, `approval`, `error` or `lost` |
| `open_data_dir()` | reveal the app directory in Finder |
| `gh_status()` | `{ installed, loggedIn }` for the GitHub CLI |
| `read_gh_token()` | **asks the user in a native dialog**, then returns `gh auth token`, or `null` if gh is missing or logged out; `"consent_denied"` if declined. The UI then stores it with `PUT /api/settings { githubToken }` |
| `set_keep_awake(active)` | tell the shell dorks are (not) working; returns whether the assertion is held |
| `keep_awake_mode()` / `set_keep_awake_mode(mode)` | the setting |
| `set_window_mode("onboarding" \| "app")` | switch the window chrome (see "Window chrome" below); remembered for the next launch. Returns the new `chrome` |
| `set_window_theme("light" \| "dark" \| "system")` | the window appearance, hence the material behind the page; remembered. Returns the new `chrome` |
| `window_chrome()` | the current `chrome` (`window.__DORKS__.chrome` is the same value at load time) |
| `install_update()` | check for and install an update (release builds only) |

The window only ever shows the bundled UI; other `http(s)` links open in the browser.

## Window chrome

The window is transparent, with a native material behind the page: **Liquid Glass** (`NSGlassEffectView`) on macOS 26 and later, classic **vibrancy** (`NSVisualEffectView`, the Sidebar material, kept active when the window is not key) before that, and an opaque window if neither can be drawn. Both come from the `window-vibrancy` crate, which Tauri already links. This needs Tauri's `macos-private-api` (`app.macOSPrivateApi` in `tauri.conf.json`), which rules out the Mac App Store; this app ships as a notarized dmg. `chrome.effect` is what was actually applied (`"liquid-glass"`, `"vibrancy"` or `"none"`). `DORKS_WINDOW_EFFECT=vibrancy|none` caps it (it can lower the effect, never ask for one the OS cannot draw).

**For the page**, to let the material show through: `html, body, #root { background: transparent }` whenever `html[data-window-effect]` is `liquid-glass` or `vibrancy`; paint your own background only when it is `none`. Surfaces that should read as glass use translucent fills; a white user bubble stays opaque white.

`window.__DORKS__.chrome` is `{ mode, effect, trafficLights, titlebarInsetLeft, titlebarHeight, theme }`. The shell also mirrors it onto `<html>` before the page's scripts run, and again after every change:

| On `<html>` | Value |
|---|---|
| `data-window-mode` | `onboarding` or `app` |
| `data-window-effect` | `liquid-glass`, `vibrancy` or `none` |
| `data-window-theme` | the theme the app asked for: `light`, `dark` or `system` |
| `data-traffic-lights` | `true` in `app` mode, `false` in `onboarding` |
| `--titlebar-inset-left` | px to keep free at the left of the header for the traffic lights (84px in `app`, 0 in `onboarding`) |
| `--titlebar-height` | px of header strip to reserve at the top (52px in `app`, 0 in `onboarding`) |

The title bar is an overlay: the page extends under it, so there is no native title bar to drag. Make the header a drag region with `data-tauri-drag-region` on the element (not on its interactive children), sized with `var(--titlebar-height)`, and start the header's own content at `var(--titlebar-inset-left)`. Double-clicking the region zooms the window. The permissions this needs (`core:window:allow-start-dragging`, `allow-internal-toggle-maximize`, `allow-toggle-maximize`) are in `capabilities/default.json`.

**Modes.** Call `set_window_mode` as soon as the app knows which it is in (at boot, and again if setup completes or is undone):

| Mode | Traffic lights | Size | Position |
|---|---|---|---|
| `onboarding` | hidden (the three buttons are hidden, the window keeps its native rounded corners) | fixed 920 x 680, not resizable | centred in the screen's usable area |
| `app` | visible over the content, inset as above | 1200 x 800 by default, resizable, minimum 900 x 600 | the remembered frame if it is still on a screen, else centred |

The shell remembers the last mode and the app-mode frame (`windowMode`, `windowFrame` in `settings.json`, logical points, saved a moment after the last move or resize and on close and quit) and opens the window already in that mode, so there is no flash of the wrong chrome. A fresh install has no mode and starts in `onboarding`; an install from before this existed also starts there until the page calls `set_window_mode("app")`. The shell does not ask the server whether setup is done: the page already knows, and one owner of that decision is simpler.

**Theme.** The material follows the window appearance, so the app must report its own theme or a light UI would sit on a dark dim. Call `set_window_theme` whenever the app theme changes (`"system"` while the user has not picked one). With no call, the window follows macOS, including when macOS switches by itself at sunset. The page's `prefers-color-scheme` follows the same setting. Remembered as `windowTheme`. Note that Tauri applies this app-wide, which is fine for a one-window app.

**Shadow and border.** The window has no drop shadow (`shadow(false)`, re-asserted after the material is attached). Onboarding has a 1 px border using the theme's `--border` token, drawn as a click-through overlay inside the window with 16 px rounded corners (`packages/ui/src/glass.css`). It does not affect the page layout and disappears in app mode. The shell draws no border or outline of its own.

### Checking the chrome without taking the screen

`DORKS_WINDOW_NOFOCUS=1` is for automated checks only. The app then runs without a Dock icon (accessory activation policy), the window never takes focus, sits below every other window, and is parked so that all but a 40 pt corner of it is off the screen. Nothing is covered and nothing is interrupted. Check it in two ways that do not need the screen:

- **The shell's log** says what AppKit has for the window after every change, e.g. `dorks: window mode app: shadow=false opaque=false buttons_hidden=Some(false)/Some(false)/Some(false) appearance=NSAppearanceNameDarkAqua frame=...` (`opaque=false` is the transparent window; `buttons_hidden` is close/minimise/zoom; `appearance` is what the theme resolved to).
- **`screencapture -x -o -l <window id>`** renders that one window only (it never captures the desktop). Find the id with `CGWindowListCopyWindowInfo(.optionAll, ...)`; the window is listed even while it is off screen. Such a capture has no backdrop, so it cannot show how translucent the glass looks, only the chrome, the buttons, the sizes, the corners and the page.

Launch the binary directly (`DORKS_WINDOW_NOFOCUS=1 Dorks.app/Contents/MacOS/dorks-desktop`) or with `open -g`; never `open -a` or an activating AppleScript. Quit with `tell application "Dorks" to quit`, which does not activate the app. Judging the translucency itself (how the glass looks over what is behind it) needs a look at the real screen; do that by hand.

## Tunnel: wurmhol

Boat sandboxes connect *out* to the server, so the bridge port needs a public URL. `crates/shell-core/src/wurmhol.rs` runs the wurmhol client (`packages/cli` of handlemotion/wurmhol, MIT) as `wurmhol <bridge port> --json --name dorks-<id>` and reads `{"url","port","id"}` (plus `"approval": true` while it waits for a login) from its first stdout line. The client stays a separate executable: it needs Node 20+ and the `wurmhol` package on the Mac (`npm i -g wurmhol`, or `$WURMHOL_BIN`).

- **Registration needs no token paste.** With no saved token the client starts its device login (ADR 0026) and prints an approval link. The shell reports `tunnel.state = "approval"` with `tunnel.approvalUrl`; the onboarding step's "Approve this Mac" button calls `open_tunnel_approval`, which opens that link (and only that link). The client's daemon saves the token it is granted in its own credentials file. The shell polls `wurmhol ls --json` and, once the share stops waiting, restarts tunnel and server so the pipe URL reaches both. Pasting a token (`set_wurmhol_token`) still works: it is stored in `wurmhol-token` (0600) and reaches the client only as `WURMHOL_TOKEN`, never as an argument or in `settings.json`.
- **Stable URL.** The name `dorks-<10 hex>` is made once (`wurmhol-name`) and passed as `--name`, so the same install gets the same URL every time (ADR 0009, 0024, 0025 of wurmhol). The sandbox's `BRIDGE_URL` is fixed when it is created, so this must not change. A `--name` in `settings.json`'s `wurmholArgs` wins.
- **Access key.** A key is made once (`wurmhol-access-key`, 0600, 64 hex characters) and reaches the client as `WURMHOL_ACCESS_KEY` in its environment. The shell also gives it to the server as `DORKS_TUNNEL_KEY`; the server puts it in each sandbox's environment, and the bridge sends it as `x-wurmhol-key` when it opens its WebSocket. The relay then lets that non-browser client through without a sign-in. The key is not the authentication: the per-dork HMAC is (see SECURITY.md). It is only handed out for a wurmhol pipe, never for a URL you supply. `settings.json` may hold `wurmholServer` (a self-hosted install, `WURMHOL_URL`) and `wurmholArgs` (extra arguments after `<port> --json`).
- **Finding the client:** `$WURMHOL_BIN`, else `wurmhol` next to the app, else `PATH` plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` (a menu-bar app starts with a minimal PATH).
- **Both client shapes work.** Today's client prints and exits while a daemon keeps the pipe: health is `wurmhol ls --json` still listing the id, stop is `wurmhol stop <id>`. A client that stays in the foreground is supervised as a process and stopped with SIGTERM.
- **Lost pipe:** reported once; the shell marks `tunnel.state = "lost"`, waits 30 s, then restarts tunnel and server (new `DORKS_PUBLIC_URL`, `dorks://runtime-config` to the UI). A pipe is capped at 12 hours by default (`expired`); the same restart reopens it, and the name keeps the URL.
- The client's stderr goes to `logs/wurmhol.log`.

### Why the server does not embed wurmhol's `openPipe`

Tried and rejected: the package's `openPipe` runs in-process, but it takes the share's URL from the WebSocket `upgrade` event, which Bun's `ws` shim does not implement (it prints "ws.WebSocket 'upgrade' event is not implemented in bun"), and a failed connection ends in an unhandled `ErrorEvent` that kills the process. Embedding needs either a Bun-compatible wurmhol client or running the Node client as a child; the latter is what the shell does.

### Wurmhol requirements and what is left

Stable names (`--name`), device-code registration (RFC 8628, ADR 0020 and 0026), reconnects and the per-pipe access key (ADR 0028) are all live on the hosted relay, and the licence question is settled (ADR 0029: the wire protocol is MIT, the relay AGPL-3.0).

1. **The `wurmhol` client must be 0.7.0 or newer.** Older clients ignore `WURMHOL_ACCESS_KEY`, so the sandbox's bridge would get `401 sign in to view this pipe`. Install it with `npm i -g wurmhol` (or point `WURMHOL_BIN` at it).
2. **12 hours per pipe.** The relay operator sets `LIMIT_SHARE_SECONDS`; the shell reopens the pipe when it ends.

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
- The app icon's source is `src-tauri/icons/source.svg`: a `#fafafa` tile with onboarding's grey ring (`BrandCircle`, 1.2454x the width, hanging from the top edge and cut off by the tile). Render it to `source.png` at 1024px, then run `pnpm tauri icon src-tauri/icons/source.png` and keep the files `tauri.conf.json` lists. The web favicon is `apps/web/public/favicon.svg`, the same drawing full-bleed with a darker ring so it reads at 16px. The menu-bar `tray.png` still comes from `scripts/make-icons.mjs`.

## Release

One-time signing setup: `apps/desktop/scripts/release-setup.sh csr` makes a key and a certificate request to upload to Apple, and `release-setup.sh secrets` (after Apple issues the certificate) builds the `.p12` and sets the secrets and the updater public key below with your own `gh` login. Key material stays in `~/.dorks-release`, never in the repo.

`.github/workflows/desktop-release.yml` builds a universal (Apple silicon + Intel) app, signs it with a Developer ID certificate, notarizes it, and attaches the `.dmg`, the updater bundle and `latest.json` to a **draft** GitHub release. Push a tag `desktop-v<version>` (matching `version` in `src-tauri/tauri.conf.json`), or run it by hand (`unsigned` makes a test build).

One-time setup, in the repository settings. Nothing secret is in the repo.

1. Apple: a Developer ID Application certificate exported as `.p12`. Secrets `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
2. Updater: `pnpm --filter @dorks/desktop tauri signer generate -w ~/.tauri/dorks.key`. Secrets `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), variable `TAURI_UPDATER_PUBKEY` (the public key). The workflow writes the updater config at build time, so no key is committed, and local builds have no updater (the `updater` cargo feature is off).
3. Nothing to configure for the server or the UI: the workflow installs Bun, compiles `apps/server` for both architectures and builds `apps/web` (`prepare-sidecar`, `prepare-ui`), and neither can fall back to a stub or a placeholder.

The sidecar is signed with the app's identity and the hardened runtime. `src-tauri/Entitlements.plist` grants the JIT entitlements a Bun binary needs.

## Not done yet

- Deploying the wurmhol access-key support (see "What is left on wurmhol's side"), and bundling its client; until then a sandbox cannot use the hosted relay and you set `DORKS_PUBLIC_URL`.
- The window was run with the real server and the real SPA (first-run setup renders and talks to the sidecar); the wurmhol token field and the tunnel state are not in the web app's Settings yet.
- Real icons.
- The release workflow has not run: it needs the secrets above.
- Window chrome was verified on macOS 26 only (Liquid Glass). The classic vibrancy fallback (macOS 12 to 25) is code-complete but has not been seen on a real older Mac; neither has a second monitor or a changed screen layout for the remembered frame (the placement rules are unit-tested).
- How the translucency looks over a real backdrop in the light and dark system appearances was looked at by hand once, before the no-screen rule, and measured as clearly light for the light theme and clearly dark for the dark one; it is not covered by an automated check (see "Checking the chrome without taking the screen").
