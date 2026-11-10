# Boat sandboxes

[Boat](https://boat.dev) is the only sandbox provider. Every dork is one Boat sandbox in **your** Boat account, created from a base snapshot the app builds for you in one click. Dorks never sees your Claude or ChatGPT password: Claude uses a token you paste, and ChatGPT is signed in by Boat itself. The driver is `apps/server/src/lib/boat.ts`.

## Cost

Boat's `default` machine is 4 vCPU and 8 GB RAM at $0.036/hour, billed per second while running. A stopped sandbox costs no machine time and keeps its disk for at least 14 days. Prices and limits change; see [Boat pricing](https://docs.boat.dev/pricing). The free trial forces auto-stop, so Dorks needs a paid Boat plan to turn off Boat's one-hour timer and control its own sleep (`sleepMinutes`, default 5).

## Setup, in order

1. **Boat API key.** Create a [Boat API key](https://docs.boat.dev/api/v1) that can create, list, command, stop, resume and delete sandboxes and list environments. Paste it in the app: the server asks Boat for one sandbox with it first (`POST /api/boat/check`) and saves it only if Boat accepts it, so a wrong key, a missing organization or an empty wallet is reported on that step. Set `boatOrg` only if you want billing pinned to one organization.
2. **Public URL.** Sandboxes reach your server through a tunnel to the bridge port. Set the tunnel's `https://` URL in Settings or as `DORKS_PUBLIC_URL`. See [architecture](architecture.md). A dork cannot be created before this is set, and the URL must stay stable, because a sandbox keeps the one it was created with.
3. **Base snapshot**: click **Prepare Boat** (below).
4. **Agent sign-in**: a Claude token (the default and the recommended agent); a ChatGPT (Codex) environment is optional (below).
5. **GitHub token** ([GitHub](github.md)).

## Build the base snapshot ("Prepare Boat")

Each dork starts from a [saved snapshot](https://docs.boat.dev/snapshots/templates) in your Boat account. It holds the bridge and the tools the agent needs but **no credentials and no per-dork environment**. Boat's image already has Node, git and Claude Code. `infra/snapshot/boat-install.sh` adds the Codex CLI, the bridge (as `dorks-bridge`, with `dorks` and the `gh` shim as symlinks), a pinned `gh` and `gh stack`. It checks versions and download checksums before it exits. Details and the bump procedure: [infra/snapshot/README.md](../infra/snapshot/README.md).

Snapshots belong to one Boat account, so every install builds its own. Once your Boat key is saved, click **Prepare Boat** in the setup guide (or in Settings, under Base snapshot). The app:

1. creates a temporary build sandbox with none of your account's credentials and a 2 hour lifetime as a safety net,
2. uploads the bridge bundle that ships inside the app plus the installer, and checks the bundle's sha256,
3. runs the installer (about a minute),
4. saves the snapshot as `dorks-base-<8 hex>` (a name unique to this install, so two installs on one Boat account never replace each other's image) and sets it as your base snapshot,
5. deletes the build sandbox, also when something fails. If Boat refuses the delete, the app keeps retrying in the background, and a build interrupted by a crash or restart is cleaned up and run again on the next start.

Progress shows step by step, and a failure shows its reason with a **Retry** button. A failed rebuild leaves your current snapshot in use. The build adds one [saved snapshot](https://docs.boat.dev/snapshots/templates#saved-snapshot-pricing) to your account: Boat includes 10 per $20 of plan, and each one above that costs $0.056 a day from the wallet (a free trial cannot save snapshots at all, and an empty wallet fails the save with `credit_required`).

When an app update ships a newer bridge, Settings shows "An update is available" for the snapshot: click **Update snapshot**. New dorks use the new image, existing ones keep their disk. The installer is x86_64 only, which is what every Boat sandbox is ([base image](https://docs.boat.dev/machines/tools)).

**Do it by hand instead.** A snapshot you build yourself works if it matches the table in [infra/snapshot/README.md](../infra/snapshot/README.md). Enter its name under "Use a snapshot I built myself" (or `baseSnapshotId`). From a checkout with the [Boat CLI](https://docs.boat.dev) logged in:

```sh
pnpm --filter @dorks/bridge build
boat new --type default --no-env --no-auto-stop     # prints <build-id>
boat scp infra/bridge/dist/cli.mjs <build-id>:dorks-bridge.mjs
boat scp infra/snapshot/boat-install.sh <build-id>:boat-install.sh
boat exec <build-id> -- bash boat-install.sh
boat snapshot <build-id> dorks-base-YYYYMMDD
```

Wait until the snapshot reports `ready`, and check that the build sandbox holds no secrets before you save. Delete the build sandbox once the snapshot is ready so it stops billing. A hand-entered name is never judged stale.

**Share codes.** Boat can [share a saved snapshot](https://docs.boat.dev/snapshots/templates#share-a-saved-snapshot-with-another-account) with another account through a `bsh_` code, and `baseSnapshotId` accepts one. Dorks does not ship one: your agent tokens and every sandbox you create would run inside an image someone else built, so build your own.

## Signing in an agent

**Claude.** Run `claude setup-token`, paste the value in Settings (`claudeToken`). The server stores it encrypted and returns it only to a dork's authenticated bridge socket, which hands it to the Claude process as `CLAUDE_CODE_OAUTH_TOKEN` without writing it to disk. Claude sandboxes are created with `noEnv: true`, so Boat injects nothing.

*Could Claude use a Boat environment too?* Boat documents it: a credential profile can hold a `claude-subscription` ([AI credentials](https://docs.boat.dev/ai-credentials)), and an environment with **Agents credentials** on passes the provider logins, including `CLAUDE_CODE_OAUTH_TOKEN` and `~/.claude/.credentials.json` ([environment access](https://docs.boat.dev/environments/access), [keys and subscriptions](https://docs.boat.dev/integrated-agents/keys)). Nothing here has run against a real Boat account yet, and a profile with both Claude and ChatGPT would hand both logins to every dork (the Codex check above assumes a ChatGPT-only profile). So the pasted token stays until one real run confirms the bridge's Claude process picks the login up from the sandbox, and then the token path can go.

**ChatGPT (Codex), optional.** Claude Code is the priority and the default for new sessions; Codex only appears as a choice once a Boat ChatGPT environment is configured. Connect ChatGPT once per Boat account, not once per dork:

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
