# Boat sandboxes

[Boat](https://boat.dev) is the only sandbox provider. Every dork is one Boat sandbox in **your** Boat account, created from a base snapshot you build once. Dorks never sees your Claude or ChatGPT password: Claude uses a token you paste, and ChatGPT is signed in by Boat itself. The driver is `apps/server/src/lib/boat.ts`.

## Cost

Boat's `default` machine is 4 vCPU and 8 GB RAM at $0.036/hour, billed per second while running. A stopped sandbox costs no machine time and keeps its disk for at least 14 days. Prices and limits change; see [Boat pricing](https://docs.boat.dev/pricing). The free trial forces auto-stop, so Dorks needs a paid Boat plan to turn off Boat's one-hour timer and control its own sleep (`sleepMinutes`, default 5).

## Setup, in order

1. **Boat API key.** Create a [Boat API key](https://docs.boat.dev/api/v1) that can create, list, command, stop, resume and delete sandboxes and list environments. Paste it in Settings (`boatKey`). Set `boatOrg` only if you want billing pinned to one organization.
2. **Public URL.** Sandboxes reach your server through a tunnel to the bridge port. Set the tunnel's `https://` URL in Settings or as `DORKS_PUBLIC_URL`. See [architecture](architecture.md). A dork cannot be created before this is set, and the URL must stay stable, because a sandbox keeps the one it was created with.
3. **Base snapshot** (below), then enter its name or id as `baseSnapshotId`.
4. **Agent sign-in**: a Claude token and/or a ChatGPT environment (below).
5. **GitHub token** ([GitHub](github.md)).

## Build the base snapshot

Each dork starts from a [saved snapshot](https://docs.boat.dev/snapshots/templates). It holds the bridge and the tools the agent needs but **no credentials and no per-dork environment**. Boat's image already has Node, git and Claude Code. `infra/snapshot/boat-install.sh` adds the Codex CLI, the bridge (as `dorks-bridge`, with `dorks` and the `gh` shim as symlinks), a pinned `gh` and `gh stack`. It checks versions and download checksums before it exits. Details and the bump procedure: [infra/snapshot/README.md](../infra/snapshot/README.md). The build sandbox must be created with `--no-env`: do not sign in to any agent or set a token in it.

From a checkout with dependencies installed and the [Boat CLI](https://docs.boat.dev) logged in:

```sh
pnpm --filter @dorks/bridge build
boat new --type default --no-env --no-auto-stop     # prints <build-id>
boat scp infra/bridge/dist/cli.mjs <build-id>:dorks-bridge.mjs
boat scp infra/snapshot/boat-install.sh <build-id>:boat-install.sh
boat exec <build-id> -- bash boat-install.sh
boat snapshot <build-id> dorks-base-YYYYMMDD
```

Wait until the snapshot reports `ready`, record its name as `baseSnapshotId`, and check that the build sandbox holds no secrets before you save. The installer removes its copied inputs. Delete the build sandbox once the snapshot is ready so it stops billing. Rebuild when the bridge or the installed tools change: new dorks use the new snapshot, existing ones keep their disk. The installer is x86_64 only.

## Signing in an agent

**Claude.** Run `claude setup-token`, paste the value in Settings (`claudeToken`). The server stores it encrypted and returns it only to a dork's authenticated bridge socket, which hands it to the Claude process as `CLAUDE_CODE_OAUTH_TOKEN` without writing it to disk. Claude sandboxes are created with `noEnv: true`, so Boat injects nothing.

**ChatGPT (Codex).** Connect ChatGPT once per Boat account, not once per dork:

1. In Boat's **Agents & Proxying** page, use a credential profile that contains only your ChatGPT subscription and connect it with the short code. The default profile works while it contains only ChatGPT. Boat does not copy sign-ins when you copy a profile.
2. Leave the account-wide AI credentials proxy **off**, to avoid its daily and per-request charges.
3. Create a Boat environment that selects that profile with **Safe for third parties off**, **Agents credentials on**, and **GitHub, Secrets, Boat credentials and Proxy AI credentials off**.
4. Save the environment's name in Settings (`boatEnvironment`).

Before it starts a Codex sandbox, the driver checks those environment switches and that a named profile (not `default`) is selected, and refuses otherwise. It cannot see the profile's contents without a Boat admin key, so keep other AI keys out of it. Boat renews the subscription and installs the sign-in on each sandbox. Dorks never stores Codex tokens in its database or snapshot. Codex defaults to GPT-6 Sol with high reasoning and never falls back to an API key. If that model or effort is unavailable on your plan, the dork pauses and asks you to pick another from Codex's list. See [Boat credentials](https://docs.boat.dev/ai-credentials) and [environment access](https://docs.boat.dev/environments/access).

This avoids Boat's paid credentials proxy, but **code inside a sandbox can read the sign-in**. Use it for your own trusted repositories only; see [SECURITY.md](../SECURITY.md#what-a-sandbox-can-read).

## Lifecycle

- **Create** uses the snapshot with `from`, a per-installation label (a hash of this install's id and the dork id, so two Dorks installs on one Boat account never adopt each other's sandboxes), the bridge variables and `ttlSeconds: null`. A generation-scoped idempotency key protects retries, and an existing labeled sandbox is reused before another is made. The driver checks the sandbox has `flock` and `dorks-bridge`, then starts the bridge detached under `flock -n /tmp/dorks-bridge.lock`.
- **Pause** is Boat `stop`; the driver waits for `archived` so the disk is saved before the dork is marked asleep. **Resume** waits for `ready`, then starts the bridge again.
- **Delete** sends `X-Ascii-Confirm-Delete` with the exact sandbox id. A sandbox that no longer exists (deleted in Boat, or its stopped disk expired) is reported as not found, and the dork recreates it on your next message. Unpushed work and on-disk Claude session state are lost.
- Boat API errors are logged by operation and HTTP status only, never by response body.

API reference: [create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox), [list](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes), [stop](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox), [resume](https://docs.boat.dev/api/reference/sandboxes/resume-sandbox), [commands](https://docs.boat.dev/api/reference/agent/execute-sandbox-command), [delete](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data).
