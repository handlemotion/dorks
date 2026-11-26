# Desktop app (macOS)

`apps/desktop` is a [Tauri 2](https://tauri.app) shell. It is the whole product on a Mac: it runs the `dorks-server` sidecar (Bun, Hono, SQLite; `apps/server`), shows the static web UI, and gives the UI a few native abilities. Architecture of the server and the bridge protocol: [architecture.md](architecture.md).

```
Dorks.app
 ├─ dorks-desktop        Tauri shell (Rust): supervision, tray, commands
 ├─ dorks-server         sidecar, supervised by the shell
 ├─ boat                 the Boat CLI, for signing in to Boat without a pasted key
 └─ UI                   static SPA from apps/web, in a webview (tauri://localhost)
```

## What the shell does

- **First run:** creates `~/Library/Application Support/Dorks` (0700; override with `DORKS_APP_DIR`), generates the owner token (`owner-token`, 0600), picks the UI port (tries 4747, then a free one, and remembers it in `settings.json`).
- **Supervises the server:** spawns it with the environment below, polls `GET /api/health`, restarts it when it exits or stops answering (exponential backoff, gives up after 5 failures in 2 minutes and shows "failed" until you choose Restart Server), stops it with SIGTERM and then SIGKILL after 5 s on quit. Its output goes to `logs/server.log`. A server orphaned by a killed shell is stopped on the next start (`server.pid`).
- **Menu bar:** server status, Open Dorks, Open Data Folder, Open Server Log, Restart Server, Quit. Closing the window leaves the app running in the menu bar.
- **Sandboxes:** the shell starts only the server, which listens on the UI port on loopback and nothing else. Sandboxes are reached by the server dialing out to each box's bridge ([architecture.md](architecture.md#bridge-protocol-websocket-dialed-by-the-server)), so the Mac opens no inbound port and needs no public URL. On start the shell deletes files left by the removed tunnel: `tunnel-install-key`, `wurmhol-connector`, `wurmhol-token`, `wurmhol-access-key`, `wurmhol-name` and `logs/wurmhol.log`.
- **Updates:** checks GitHub Releases shortly after launch and every 15 minutes, offers a newer version in the sidebar and the menu bar, and installs it in place (see [Updates](#updates)).
- **Keep awake:** a power assertion (`caffeinate -i -w <pid>`, released automatically if the app dies) while the UI reports active dorks: a session starting or working, or an active automation with a schedule (the server runs on the Mac, so a scheduled run starts on time only if the Mac is awake; the assertion stops idle sleep, not a closed lid on battery). Setting: `whileActive` (default), `always`, `never`. While the assertion is held the app also holds an `NSProcessInfo` activity (user-initiated, idle sleep allowed), so App Nap does not throttle the shell behind a hidden window.
- **Open at login:** the server runs only while the app does, so while an active automation has a schedule (`set_keep_awake`'s `scheduled`) the app registers itself as a login item (`SMAppService.mainApp`, macOS 13+), and removes the login item it added once no schedule is left. It adds it once per stretch of schedules (`loginItemRegistered` in the settings), so turning it off in System Settings → Login Items sticks. Setting `openAtLogin`: `whileScheduled` (default), `never` (removes one it added). A quit app, a closed lid or a shut-down Mac still miss the time; the run then starts late and says so ([automations](automations.md)).

## Contract with the server

Defined in one file, `crates/shell-core/src/contract.rs`. The server gets this environment (and only this plus `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `USER`, `LOGNAME`, and `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` so the server's `gh auth token` finds the GitHub CLI's login):

| Variable | Value |
|---|---|
| `DORKS_DATA_DIR` | `<app dir>/server` |
| `DORKS_OWNER_TOKEN` | the owner token |
| `DORKS_UI_PORT` | the loopback UI port |
| `DORKS_PARENT_PID` | the shell's pid. The server should exit if it disappears (optional; the shell also reaps orphans) |

## What the UI gets

`window.__DORKS__` is set before any page script runs: `{ apiUrl, uiPort, ownerToken, dataDir, version, bootError, chrome }` (`chrome` is described under "Window chrome"). Call the API with `Authorization: Bearer <ownerToken>` against `apiUrl`. If the server could not be set up, only `bootError` is present. `window.__DORKS__` is replaced when the config changes, and the event `dorks://runtime-config` fires; `dorks://server-status` carries `{ state: "starting" | "running" | "restarting" | "failed" | "stopped", ... }`.

Commands (`invoke` from `@tauri-apps/api/core`, or `window.__TAURI__.core.invoke`):

| Command | Does |
|---|---|
| `runtime_config()` / `server_status()` | current config / status |
| `restart_server()` | restart now, reset the failure history |
| `open_data_dir()` | reveal the app directory in Finder |
| `set_keep_awake(active, scheduled?)` | tell the shell dorks are (not) working, and whether an active automation has a schedule (omitted until known); returns whether the assertion is held |
| `keep_awake_mode()` / `set_keep_awake_mode(mode)` | the setting |
| `set_window_mode("onboarding" \| "app")` | switch the window chrome (see "Window chrome" below); remembered for the next launch. Returns the new `chrome` |
| `set_window_theme("light" \| "dark" \| "system")` | the window appearance, hence the material behind the page; remembered. Returns the new `chrome` |
| `window_chrome()` | the current `chrome` (`window.__DORKS__.chrome` is the same value at load time) |
| `update_status()` | where the in-app update stands (see "Updates"); `dorks://update` carries every change |
| `check_for_update()` | ask GitHub for a newer version now; returns the new status |
| `install_update()` | download and install the offered update, stop the server and relaunch; returns only if it failed |

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
| `--titlebar-inset-left` | px to keep free at the left of the header for the traffic lights (78px in `app`, 0 in `onboarding`) |
| `--titlebar-height` | px of header strip to reserve at the top (52px in `app`, 0 in `onboarding`) |

The title bar is an overlay: the page extends under it, so there is no native title bar to drag. Make the header a drag region with `data-tauri-drag-region` on the element (not on its interactive children), sized with `var(--titlebar-height)`, and start the header's own content at `var(--titlebar-inset-left)`. Double-clicking the region zooms the window. The permissions this needs (`core:window:allow-start-dragging`, `allow-internal-toggle-maximize`, `allow-toggle-maximize`) are in `capabilities/default.json`.

**Modes.** Call `set_window_mode` as soon as the app knows which it is in (at boot, and again if setup completes or is undone):

| Mode | Traffic lights | Size | Position |
|---|---|---|---|
| `onboarding` | hidden (the three buttons are hidden, the window keeps its native rounded corners) | fixed 920 x 680, not resizable | centred in the screen's usable area |
| `app` | visible over the content, inset as above | 1200 x 800 by default, resizable, minimum 900 x 600 | the remembered frame if it is still on a screen, else centred |

The shell remembers the last mode and the app-mode frame (`windowMode`, `windowFrame` in `settings.json`, logical points, saved a moment after the last move or resize and on close and quit) and opens the window already in that mode, so there is no flash of the wrong chrome. A fresh install has no mode and starts in `onboarding`; an install from before this existed also starts there until the page calls `set_window_mode("app")`. The shell does not ask the server whether setup is done: the page already knows, and one owner of that decision is simpler.

**Theme.** The material follows the window appearance, so the app must report its own theme or a light UI would sit on a dark dim. Call `set_window_theme` whenever the app theme changes (`"system"` while the user has not picked one). With no call, the window follows macOS, including when macOS switches by itself at sunset. The page's `prefers-color-scheme` follows the same setting. Remembered as `windowTheme`. Note that Tauri applies this app-wide, which is fine for a one-window app.

**Shadow and border.** The window keeps macOS's native drop shadow (`shadow(true)`, re-asserted after the material is attached); the no-shadow rule is for the page, not the window. Onboarding has a 1 px border using the theme's `--border` token, drawn as a click-through overlay inside the window with 16 px rounded corners (`packages/ui/src/glass.css`). It does not affect the page layout and disappears in app mode. The shell draws no border or outline of its own.

### Checking the chrome without taking the screen

`DORKS_WINDOW_NOFOCUS=1` is for automated checks only. The app then runs without a Dock icon (accessory activation policy), the window never takes focus, sits below every other window, and is parked so that all but a 40 pt corner of it is off the screen. Nothing is covered and nothing is interrupted. Check it in two ways that do not need the screen:

- **The shell's log** says what AppKit has for the window after every change, e.g. `dorks: window mode app: shadow=false opaque=false buttons_hidden=Some(false)/Some(false)/Some(false) appearance=NSAppearanceNameDarkAqua frame=...` (`opaque=false` is the transparent window; `buttons_hidden` is close/minimise/zoom; `appearance` is what the theme resolved to).
- **`screencapture -x -o -l <window id>`** renders that one window only (it never captures the desktop). Find the id with `CGWindowListCopyWindowInfo(.optionAll, ...)`; the window is listed even while it is off screen. Such a capture has no backdrop, so it cannot show how translucent the glass looks, only the chrome, the buttons, the sizes, the corners and the page.

Launch the binary directly (`DORKS_WINDOW_NOFOCUS=1 Dorks.app/Contents/MacOS/dorks-desktop`) or with `open -g`; never `open -a` or an activating AppleScript. Quit with `tell application "Dorks" to quit`, which does not activate the app. Judging the translucency itself (how the glass looks over what is behind it) needs a look at the real screen; do that by hand.

## Links

The app opens `dorks://` links (`tauri-plugin-deep-link`; the scheme is registered in the app bundle from `tauri.conf.json`, so it
works once the built app is in Applications, not under `pnpm dev:desktop`). `shell-core`'s `deep_link::route_for` maps each URL to a route of
the UI and refuses everything else:

| Link | Opens |
|---|---|
| `dorks://invite/<id>` (a Dorks Cloud invitation email) | `#/invite/<id>`: Join or Decline |
| `dorks://pair?code=...` (a phone pairing code opened on the Mac) | Settings, Phone |
| `dorks://auth?code=...&state=...` (the website, after a Dorks Cloud sign-in) | `#/auth`: the local server redeems the code ([mobile](mobile.md), "Desktop: Dorks Cloud") |
| `dorks://github?from=settings\|new` (Dorks Cloud, after a cloud org's GitHub App install) | Settings, Organization (`from=settings`), else a new session; the app reads the org's GitHub connection again |

The shell keeps the route until the UI takes it (`take_open_route`, called once the UI has loaded, so a link that launched the app is
not lost) and also sends it as `dorks://open-route` to a UI already open; either way it shows the window. The UI navigates there
(`onOpenRoute` in `apps/web/src/lib/desktop.ts`).

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
- **Boat CLI:** `prepare:sidecar` also runs `scripts/prepare-boat.mjs`, which puts `boat-<target triple>` (a second externalBin, about 8 MB per architecture) in `src-tauri/binaries`: downloaded from Boat's installer endpoint and checked against the SHA-256 list Boat publishes beside it, reused in development, fetched fresh with `--release`. The shell hands its path to the server as `DORKS_BOAT_BIN`; the server prefers a `boat` on `PATH` and uses this one only when there is none. It connects Boat with the owner's Boat login ([Boat](boat.md#sign-in-with-the-boat-cli)).
- Use a throwaway data directory when trying things: `DORKS_APP_DIR=/tmp/dorks-test`.
- The app icon's source is `src-tauri/icons/source.svg`: a `#f2f2f2` tile with a thin grey ring after onboarding's (`BrandCircle`): 1.1x the tile's width, its top 10% down, its sides and bottom cut off by the tile. Render it to `source.png` at 1024px, then run `pnpm tauri icon src-tauri/icons/source.png` and keep the files `tauri.conf.json` lists. The web favicon is `apps/web/public/favicon.svg`, the same drawing full-bleed. The menu-bar `tray.png` still comes from `scripts/make-icons.mjs`.

## Updates

Release builds update themselves from GitHub Releases with Tauri's updater (`src/updater.rs`). Local and unsigned builds do not have the `updater` cargo feature: their status is `unsupported` and nothing about updates shows.

- **Check.** 10 seconds after launch, then every 15 minutes, the shell fetches `https://github.com/handlemotion/dorks/releases/latest/download/latest.json` (the endpoint the release workflow bakes in) and compares its version with the app's (`version` in `tauri.conf.json`). A failed check (offline, GitHub down) is logged and shows nothing.
- **Status**, from `update_status()` and every `dorks://update` event, tagged by `state`:

  | `state` | Fields | Shown |
  |---|---|---|
  | `unsupported` | | nothing (a build that cannot update, or a plain browser) |
  | `idle` | `checking` | nothing |
  | `available` | `version`, `notes` | the sidebar prompt with Update; the menu bar's "Update to Dorks x…" |
  | `downloading` | `version`, `downloaded`, `total` | the prompt with a progress bar; "Downloading Update… n%" |
  | `installing` | `version` | "Installing update, Dorks will restart" |
  | `failed` | `version`, `message` | "Update failed" with Try again (the message is the prompt's tooltip) |

- **Install.** Update in the sidebar (`UpdatePrompt`, a solid brand-blue block above Settings) or in the menu bar downloads the bundle, checks its signature against the public key baked into the app, replaces `Dorks.app`, stops the server like Quit does, and relaunches. On macOS the relaunch waits for the old process to exit and then opens `Dorks.app` normally; Tauri's own restart runs `open -n` while the old process is alive, which leaves a second Dorks icon in the Dock. The menu bar item reads "Check for Updates…" otherwise, and says "Dorks Is Up to Date" for a few seconds after a check it started finds nothing.
- **Trying the prompt without a release:** the web app's `UpdatePromptView` takes a status as a prop; in a browser, a stand-in `window.__TAURI__` whose `invoke('update_status')` returns one of the states above shows it.

Ship an update: merge the **Release Dorks** PR ([releasing.md](releasing.md)). The release workflow builds, signs and publishes it, and installed apps pick it up within 15 minutes. The version must be newer than the installed one, or the updater never offers it; Changesets only ever bumps it up.

## Release

One-time signing setup: `apps/desktop/scripts/release-setup.sh csr` makes a key and a certificate request to upload to Apple, and `release-setup.sh secrets` (after Apple issues the certificate) builds the `.p12` and sets the secrets and the updater public key below with your own `gh` login. Key material stays in `~/.dorks-release`, never in the repo.

`.github/workflows/desktop-release.yml` builds the app for Apple silicon (no Intel build for now), signs it with a Developer ID certificate, notarizes it, uploads the `.dmg`, the updater bundle and `latest.json` to the release `desktop-v<version>` and publishes it. `release.yml` calls it when a merged release PR puts a new version on `main` ([releasing.md](releasing.md)); run it by hand to retry, or with `unsigned` for a test build.

One-time setup, in the repository settings. Nothing secret is in the repo.

1. Apple: a Developer ID Application certificate exported as `.p12`. Secrets `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
2. Updater: `pnpm --filter @dorks/desktop tauri signer generate -w ~/.tauri/dorks.key`. Secrets `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), variable `TAURI_UPDATER_PUBKEY` (the public key). The workflow writes the updater config at build time, so no key is committed, and local builds have no updater (the `updater` cargo feature is off).
3. Nothing to configure for the server or the UI: the workflow installs Bun, compiles `apps/server` and builds `apps/web` (`prepare-sidecar`, `prepare-ui`), and neither can fall back to a stub or a placeholder.

The sidecar is signed with the app's identity and the hardened runtime. `src-tauri/Entitlements.plist` grants the JIT entitlements a Bun binary needs.

## Not done yet

- The window was run with the real server and the real SPA (first-run setup renders and talks to the sidecar).
- Real icons.
- The update path from one signed release to the next has not been run end to end yet: 0.0.1 predates the update prompt (it has the updater but no check), so 0.0.1 users install 0.1.0 by hand once, and the first real in-app update is 0.1.0 to the next release.
- No Intel build: releases are Apple silicon only. `prepare-sidecar --target universal-apple-darwin` still works locally.
- Window chrome was verified on macOS 26 only (Liquid Glass). The classic vibrancy fallback (macOS 12 to 25) is code-complete but has not been seen on a real older Mac; neither has a second monitor or a changed screen layout for the remembered frame (the placement rules are unit-tested).
- How the translucency looks over a real backdrop in the light and dark system appearances was looked at by hand once, before the no-screen rule, and measured as clearly light for the light theme and clearly dark for the dark one; it is not covered by an automated check (see "Checking the chrome without taking the screen").
