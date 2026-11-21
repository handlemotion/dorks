# ADR: Computer use

Status: accepted (2026-11-10). Built on Boat's native desktop; verified by a spike on a sandbox made from our base snapshot (results below). Live playback of the WebRTC stream inside the app and an agent turn that drives the desktop have not been run end to end yet.

## Context

The agent should drive a computer of its own (a desktop with a browser), and the owner should watch it live in the Computer tab of Chat details and take over when needed. Fast, cheap, no new account.

Each dork is a Boat sandbox ([boat.md](boat.md)), an x86_64 Linux VM at $0.036/hour. The agent is the Claude Code CLI, started by the bridge with `--mcp-config` for our `dorks` MCP server (`infra/bridge/src/mcp.ts`).

## What Boat ships

Boat has native computer use ([computer use](https://docs.boat.dev/integrated-agents/computer-use), [machine tools](https://docs.boat.dev/machines/tools)):

- **A desktop on every sandbox**: Xorg `:0` at 1920x1080 (LightDM), Google Chrome, `xdotool`, `wmctrl`, `ffmpeg`.
- **Agent tools.**
  - The Cua Driver runs as the systemd user service `cua-driver.service`.
  - A small proxy (`~/.config/ascii/computer-mcp.py`) exposes it as the MCP server `computer`, registered in `~/.claude.json`.
  - It has 55 tools, among them:
    - `get_desktop_state` (a full-screen screenshot) and `get_window_state` (a window's accessibility elements plus a screenshot)
    - click, type, hotkey, drag and scroll
    - `launch_app` and `list_windows`
    - `browser_navigate`, `browser_click`, `browser_type` and `get_browser_state` (CDP on Chrome)
    - `zoom`, clipboard, and trajectory recording (`start_recording`, `stop_recording`)
  - Input is sent with XSendEvent to a target window, with a synthetic agent cursor. It does not move the user's pointer or steal focus.
- **A live view.**
  - `POST /sandboxes/{id}/desktop?theme=light|dark` returns a `desktopUrl` at once: WebRTC, 1080p, 60 fps. It is interactive.
  - `?vnc=1` gives noVNC instead. Its first call answers `provisioning: true`, so ask again.
  - `POST /sandboxes/{id}/browser` streams Chrome alone ([streaming URL](https://docs.boat.dev/api/reference/agent/get-desktop-streaming-url), [browser only](https://docs.boat.dev/desktop-streaming/browser-only)).
- **Limits** ([URLs and security](https://docs.boat.dev/desktop-streaming/urls-and-security)):
  - A URL must be opened within 10 minutes, and its token sits in the `#fragment`.
  - The stream ends when the sandbox stops, and desktop apps do not survive a resume.
  - There is one screen per sandbox.
  - A second browser-only viewer takes the stream over from the first.
- **Price**: nothing beyond the sandbox's own time.

## Options considered

| Option | Gives | Live view | Price/hour | Verdict |
|---|---|---|---|---|
| **Boat native** | full Linux desktop and Chrome, in the agent's own sandbox | iframe, interactive | $0.036 (already paid) | **chosen** |
| Browser Use Cloud | headless browser | live view | ~$0.02 | browser only, a second vendor, cannot reach the sandbox's dev server without a public URL |
| Steel.dev | browser, CDP, self-hostable | live view | $0.08–0.10 | 15 min sessions on the entry plan; same second-vendor cost |
| Browserbase | browser, CDP | iframe | $0.10–0.12 | same |
| Kernel | browser on a microVM | live view | $0.06 headless, $0.48 headful | same |
| E2B Desktop, Daytona, Cua cloud | full desktop | VNC or stream URL | ~$0.17 | a second sandbox beside the one we already run |
| Our own Xvfb + noVNC/KasmVNC | full desktop | via Boat `/host` ports | $0.036 | redoes what Boat ships |
| Claude Code's computer use / `--chrome` | — | — | — | macOS-only and interactive, or needs the Chrome extension and a claude.ai login; neither works headless with a `setup-token` |

The outside browser vendors each add:
- a second machine, a second bill and a second key,
- a split between the agent's code (on Boat) and its browser (elsewhere),
- a tunnel back to reach the dev server.

Boat's desktop sits next to the code, so `localhost:3000` just works in its Chrome.

## Spike (2026-11-10, a sandbox from `dorks-base-…`, `--no-env`)

1. **Desktop and driver: present.**
   - Xorg `:0` is running, `cua-driver.service` is active, and Chrome and `xdotool` are installed.
   - Our saved snapshot keeps all of it, because Boat starts these services on boot.
2. **Agent tools: present without changes.**
   - In that sandbox, `claude mcp list` reports `computer: … ✔ Connected`.
   - The bridge passes `--mcp-config` without `--strict-mcp-config`, so the user-scope server loads beside `dorks`.
   - The driver socket (`/run/ascii-cua/driver.sock`) is mode 600 for `user`. Under `CLAUDE_RUN_AS` (not used on Boat), the tools would not work.
3. **Live view: embeddable.**
   - `/desktop` answered at once with a `desktopUrl`.
   - The stream page sends no `X-Frame-Options` or `frame-ancestors`.
   - The noVNC variant answered `provisioning` first.
   - Not yet checked: that WebRTC actually plays inside the Tauri webview.
4. **API key**: a key with the actions in [boat.md](boat.md) could mint the URL. No new action had to be added.
5. **Owner and agent input**: the agent's input goes to a target window through XSendEvent, with its own cursor, so a watching owner does not disturb it. Two hands clicking at once is still confusing, so the tab stays view-only until the owner takes over.

## Decision

Use Boat's native desktop for both halves.

### What was built

- **Driver** (`apps/server/src/lib/boat.ts`):
  - `desktopUrl(id, {theme})` calls `/desktop`. Boat's browser-only `/browser` stream is not used: the desktop already shows Chrome, it misses every other app, and a second viewer takes it over.
  - It waits out `provisioning` for up to 30 s, then fails with the retryable code `provisioning`.
  - It accepts only `https://` URLs and adds `overlay=0` before the fragment, which hides Boat's viewer chrome.
  - It is an optional method on the `BoxProvider` seam (`core/box.ts`).
  - The sim returns the path of a stand-in page (`GET /sim/desktop`). The mock server returns a `data:` page.
- **UI API**: `POST /api/dorks/:id/desktop` → `{url}` with `Cache-Control: no-store` ([architecture](architecture.md)).
  - Answers `sleeping` unless the dork is `working` or `idle`. It never wakes a dork.
  - Never stores or logs the URL.
- **Bridge** (`infra/bridge/src/claude.ts`):
  - Boat's own `computer` server is used as is.
  - When `/opt/ascii/cua-driver/cua-driver` exists, the CLI gets one `--append-system-prompt` paragraph. It says the desktop exists, that the owner watches it, and to use it to check what the agent builds.
- **Web** (`apps/web/src/components/ComputerView.tsx`):
  - The Computer tab shows the screen at its own 16:9, floating in the panel with 24px around it, and a bar with Take over, Reload and Open in a window.
  - It mints a URL whenever the theme or the dork's awake state changes.
  - It is view-only by default (`pointer-events: none` on the frame).
  - Take over interrupts a running turn, then hands the pointer and keyboard to the owner. Pressing it again hands control back.
  - The tab opens by itself the first time an `mcp__computer__*` tool runs while the chat is open.
  - Empty states: "No computer in use" for a dork that never used it while asleep, and "Computer asleep" for one that did.

### Security

- The stream URL is a bearer credential to a live, interactive desktop. It is returned only over the owner-authenticated UI API and never logged or stored. The iframe sends no referrer.
- Code in the sandbox can drive the desktop and read the screen, including anything the owner types while in control. This is the same trust model as before ([SECURITY.md](../SECURITY.md)).

### Screenshots in the chat

The computer tools' screenshots reach only the model. To show the owner its work, the agent calls the `dorks` MCP tool `screenshot_share`
(`infra/bridge/src/mcp.ts`): `url` renders a page in headless Chrome (a throwaway profile, 1440x900 at scale 2 by default, `dark` for
prefers-color-scheme dark; Chrome, Chromium or a Playwright-downloaded Chromium), `path` shares an image file, and neither grabs the whole
desktop (`ffmpeg -f x11grab`). The bridge sends the bytes to the server (`share_image`), which stores them in `images` and serves them at
`GET /images/:id` (the 128-bit id is the capability, so a plain `<img>` loads it). The tool returns `![caption](dorks-image:<id>)` and the
image itself, so the agent can check it; the web resolves the id to the server URL, and the Artifacts tab lists the dork's screenshots.
The standing guidance (`guidance.ts`) tells every agent to verify visual work this way and put the images in its final answer.

Images the owner attaches to a message use the same store: `POST /api/images`, named in the message the same way, claimed by the dork when
the message is sent, and handed to Claude as image blocks (the bridge loads them with `get_image`).

## Next

- **Run one real turn.**
  - Check the WebRTC stream plays inside the desktop app.
  - Ask a dork to "open the dev server in Chrome and screenshot it" and confirm the tab follows.
  - Use `--type small` sandboxes for checks that build nothing.
- **Previews through Boat's hosted ports**: done. The agent's `preview_show` tool hosts a port and Artifacts shows it as a running preview; see [Boat](boat.md#hosted-ports).
- **Recordings as artifacts**: the driver's `start_recording` and `stop_recording`, or `ascii-record-desktop`, saved per turn into Artifacts.
- **Codex**: give the Codex CLI the same MCP server. Deprioritized, per AGENTS.md.

## Consequences

- No new vendor, key or bill. Computer use costs only the sandbox's running time.
- We depend on Boat's desktop and stream. If Boat drops them, the way out is our own Xvfb + noVNC exposed through `/host`. The UI contract (`POST /desktop` → `{url}`) stays the same.
