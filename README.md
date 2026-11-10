# dorks

Run coding agents (Claude Code, Codex) in your own [Boat](https://boat.dev) sandboxes and drive them from one desktop app: a chat per task, and PRs the agent keeps working on until they merge. Your sandboxes, your Boat account, your Claude or ChatGPT sign-in. Nothing is hosted for you. Site: [dorks.build](https://dorks.build).

> **Status: early.** The server, web UI and desktop shell are in the repo and tested separately. Not yet shipped: a signed `.dmg`, the wurmhol tunnel client (use your own tunnel URL for now), a bundled server binary, and a finished first-run flow. [docs/desktop.md](docs/desktop.md) lists what is missing.

## How it works

```
 Dorks.app (Tauri, macOS)                              Boat cloud
 ┌──────────────────────────────────────┐             ┌─────────────────────────────┐
 │ web UI (static SPA)                  │             │ sandbox (one per dork)      │
 │    │ HTTP + SSE, owner token         │             │  dorks-bridge ─▶ claude/    │
 │    ▼                                 │             │  codex, git, gh             │
 │ dorks-server (SQLite, timers, Boat   │◀── wss ─────│       │                     │
 │ driver, GitHub poller)               │  tunnel,    └───────┼─────────────────────┘
 │  UI port 127.0.0.1:4747              │  bridge port        │
 │  bridge port 127.0.0.1:4748          │  only               ▼
 └──────────────────────────────────────┘                  GitHub, Anthropic, OpenAI
```

- **Server** (`apps/server`): one local process with a SQLite database. It runs the lifecycle state machine (create, work, idle, sleep, wake), calls Boat, and polls GitHub for PR events.
- **Bridge** (`infra/bridge`): runs inside each sandbox, drives the agent, and connects *out* to your server over a WebSocket. Your Mac needs a public tunnel URL for that, and only the bridge port is exposed through it.
- **Web** (`apps/web`) with `packages/client`: the UI. It loads inside the desktop app, or in a browser.
- **Desktop** (`apps/desktop`): a Tauri shell that starts and supervises the server, hands the UI its token, and keeps the Mac awake while dorks work.
- **Autonomy**: a dork opens PRs, subscribes to them and keeps fixing CI failures, review comments and conflicts ([docs/autonomy.md](docs/autonomy.md)).

Read [docs/architecture.md](docs/architecture.md) for the decisions and the wire protocols, and [SECURITY.md](SECURITY.md) for the trust model.

## Quickstart from source

Needs Node 24, pnpm (version pinned in `package.json`; `corepack enable`) and [Bun](https://bun.sh).

```sh
pnpm install
pnpm dev     # real server with simulated sandboxes + the web UI; prints the URL to open
```

Open the printed URL (it carries the dev owner token), then follow setup: Boat key, base snapshot ([docs/boat.md](docs/boat.md)), agent sign-in, GitHub token. With `pnpm dev` sandboxes are simulated, so you can create and drive sessions without a Boat account.

To try the UI with no server at all: `pnpm dev:mock` serves an in-memory mock server on :4747 with a scripted fake agent.

To run the server on its own against your real data (`~/Library/Application Support/Dorks`): `pnpm --filter @dorks/server dev`, then connect the UI with the `ownerToken` from `secrets.json` in that directory (see [docs/github.md](docs/github.md#the-owner-token)).

For real sandboxes the server needs `DORKS_PUBLIC_URL`, the `https://` URL of a tunnel that forwards to the bridge port (default 4748). All variables are in [docs/env.md](docs/env.md).

## Quickstart from the app

Once a release exists: download the `.dmg` from the GitHub releases, drag Dorks to Applications, open it, and follow the setup screen. Building the app yourself: [docs/desktop.md](docs/desktop.md).

## Develop

[CONTRIBUTING.md](CONTRIBUTING.md) has the dev loop, tests and CI.

## License

[Apache-2.0](LICENSE).
