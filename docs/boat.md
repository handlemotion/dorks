# Boat sandboxes

[Boat](https://boat.dev) is the only sandbox provider. Every dork is one Boat sandbox in **your** Boat account, created from a base snapshot the app builds for you in one click. Dorks never sees your Claude or ChatGPT password: Claude uses a token you paste, and ChatGPT is signed in by Boat itself. The driver is `packages/core/src/boat.ts`.

## Cost

Boat's `default` machine is 4 vCPU and 8 GB RAM at $0.036/hour, billed per second while running. A stopped sandbox costs no machine time and keeps its disk for at least 14 days. Prices and limits change; see [Boat pricing](https://docs.boat.dev/pricing). Dorks needs a paid Boat plan: the [free trial](https://docs.boat.dev/free-trial) requires auto-stop within 2 hours (`trial_auto_stop_required`) and cannot save snapshots (`trial_saved_snapshots_not_allowed`), and Dorks creates sandboxes without a timer to control its own sleep (`sleepMinutes`, default 5). The Boat step refuses a trial key for that reason.

## Setup, in order

1. **Boat account.** Connected with the Boat CLI's login, with nothing to paste (next section). Or, without the CLI, paste a key: create a [Boat API key](https://docs.boat.dev/api-keys/scopes) with the actions Dorks uses: `sandbox.create`, `sandbox.read`, `sandbox.stop`, `sandbox.resume`, `sandbox.delete`, `exec`, `file.write`, `snapshot.read`, `snapshot.write`, and `environment.read` for Codex. Add `account.read` so the app can also check your plan and wallet, and show the plan's included machine time, starts, running sandboxes and wallet in the composer's usage menu. Boat cannot report which actions a key has, so a missing one shows up when it is first used, as `api_key_action_forbidden` (the build names it). Paste the key in the app: before saving it, the server asks Boat's [`GET /limits`](https://docs.boat.dev/api/reference/account/get-boat-limits) with it, so a wrong or expired key, a free trial (`sandboxPlanKey: "trial"`), a blocked wallet (`canStart: false`) or a wrong organization is reported on that step. Without `account.read` it falls back to listing one sandbox, which proves the key but not the plan. Set `boatOrg` only to bill an organization's wallet; use its `team_…` id, because two organizations with the same name are refused as `ambiguous_org`.
2. **Base snapshot**: built for you in the background as soon as the Boat key is saved (below).
3. **Agent sign-in**: a Claude token (the default agent), a ChatGPT (Codex) environment for GPT models (below), or both.
4. **GitHub**: your GitHub CLI login ([GitHub](github.md)).

## Sign in with the Boat CLI

Dorks connects Boat the way it connects GitHub: through the owner's own CLI login (`apps/server/src/lib/boatCli.ts`, `services/boatSignIn.ts`). With no key saved:

- **Signed in** (`boat status`): the server makes itself a key, `boat api-key create Dorks --ttl never --actions …`, with exactly the actions it uses (`KEY_ACTIONS`: the sandbox, exec, file, ssh, desktop, host, snapshot and `environment.read` actions plus `account.read`; never `account.admin`). Plain `sandbox.delete`, not `sandbox.delete-own`, so a key made after a reconnect can still delete sandboxes an earlier one created. It bills the organization `boat org status` names. The key is checked like a pasted one (`GET /limits`): a trial or blocked wallet is reported on the row and the key is revoked. This happens on start, with no click.
- **Signed out**: the checklist's Sign in runs `boat login --wait --json`, opens the link it prints (GitHub sign-in in the browser; the row shows the code the page may ask for), and makes the key as soon as the sign-in finishes.
- **No key left behind**: the id of the key Dorks made is kept (`boat_key_id`); replacing or clearing the key revokes it. Clearing the key also stops connecting by itself until the owner presses Sign in again.

Which `boat`: the one on `PATH` (or `~/.ascii/bin`, where Boat's installer puts it), else the copy the desktop app bundles (`DORKS_BOAT_BIN`, downloaded and checksum-checked at build time by `apps/desktop/scripts/prepare-boat.mjs`). Both share the CLI's own login. Every call runs with `BOAT_NO_UPDATE=1`, so the CLI never updates itself inside the signed app. Simulated sandboxes (`BOX_PROVIDER=sim`) skip all of this.

## Build the base snapshot ("Prepare Boat")

Each dork starts from a [saved snapshot](https://docs.boat.dev/snapshots/templates) in your Boat account. It holds the bridge and the tools the agent needs but **no credentials and no per-dork environment**. Boat's image already has Node, git and Claude Code. `infra/snapshot/boat-install.sh` adds the Codex CLI, the bridge (as `dorks-bridge`, with `dorks` and the `gh` shim as symlinks), a pinned `gh` and `gh stack`. It checks versions and download checksums before it exits. Details and the bump procedure: [infra/snapshot/README.md](../infra/snapshot/README.md).

Snapshots belong to one Boat account, so every install builds its own. Saving your Boat key starts the build in the background when no base snapshot is set yet (and retries one that failed), and the app shows its progress; no session can be created until it is ready. You can also start or rerun it in Settings, under Base snapshot. The app:

1. creates a temporary build sandbox with none of your account's credentials and a 2 hour lifetime as a safety net,
2. uploads the bridge bundle that ships inside the app plus the installer, and checks the bundle's sha256,
3. runs the installer (about a minute),
4. saves the snapshot as `dorks-base-<8 hex>` (a name unique to this install, so two installs on one Boat account never replace each other's image) and sets it as your base snapshot,
5. deletes the build sandbox, also when something fails. If Boat refuses the delete, the app keeps retrying in the background, and a build interrupted by a crash or restart is cleaned up and run again on the next start.

Progress shows step by step, and a failure shows its reason with a **Retry** button. A failed rebuild leaves your current snapshot in use. The build adds one [saved snapshot](https://docs.boat.dev/snapshots/templates#saved-snapshot-pricing) to your account: Boat includes 10 per $20 of plan, and each one above that costs $0.056 a day from the wallet (a free trial cannot save snapshots at all, and an empty wallet fails the save with 402 `credit_required`).

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

## Builds

A [build](builds.md) is a named machine setup on top of the base snapshot: its own saved snapshot (`dorks-b-<install>-<build>`), made by
running the build's setup script in a sandbox created `from` the base, at the build's size (`small`, `default`, `large`, `xlarge`). Each
build adds one saved snapshot to the account (the same pricing as the base snapshot above) plus the minutes its runs take. Dorks on a
build start from its image at its size. Building needs no new key action: runs use `sandbox.create`, `exec`, `file.write`, `snapshot.write`
and `sandbox.delete`, like the base snapshot.

## Signing in an agent

**Claude.** Run `claude setup-token`, paste the value in Settings (`claudeToken`). The server stores it encrypted and returns it only to a dork's authenticated bridge socket, which hands it to the Claude process as `CLAUDE_CODE_OAUTH_TOKEN` without writing it to disk. Claude sandboxes are created with `noEnv: true`, so Boat injects nothing.

*Could Claude use a Boat environment too?* Boat documents it: a credential profile can hold a `claude-subscription` ([AI credentials](https://docs.boat.dev/ai-credentials)), and an environment with **Agents credentials** on passes the provider logins, including `CLAUDE_CODE_OAUTH_TOKEN` and `~/.claude/.credentials.json` ([environment access](https://docs.boat.dev/environments/access), [keys and subscriptions](https://docs.boat.dev/integrated-agents/keys)). Nothing here has run against a real Boat account yet, and a profile with both Claude and ChatGPT would hand both logins to every dork (the Codex check above assumes a ChatGPT-only profile). So the pasted token stays until one real run confirms the bridge's Claude process picks the login up from the sandbox, and then the token path can go.

**Antigravity (Gemini), optional.** The bridge drives Google's `agy` CLI itself, in its documented streaming headless mode (`agy --input-format stream-json --output-format stream-json`), so the agent is the CLI the subscription covers, with Dorks as the adapter around it ([infra/bridge/src/antigravity.ts](../infra/bridge/src/antigravity.ts)). It signs in with a shared secret:

- **Your subscription (Sign in with Google):** one button in the setup checklist, onboarding or Settings → Agents. The server runs agy's own sign-in, `agy acp`'s `authenticate` (no terminal; Dorks never calls Google's OAuth itself): agy produces Google's consent link, the app opens it, and agy catches the redirect on a localhost port of its own. It runs in a throwaway home with the keyring out of reach (an unreachable D-Bus on Linux; on macOS `sandbox-exec` denying `/usr/bin/security`, which would otherwise stop on a "Keychain Not Found" dialog), so agy keeps its token file, which the server stores encrypted like the Claude token and hands to each Antigravity sandbox as `ANTIGRAVITY_OAUTH_TOKEN`. With no `agy` on the server's computer (`DORKS_AGY_BIN`, `PATH`, `~/.local/bin`), the server downloads Google's current build into its data dir, checksum-verified, in the background. A browser on another computer cannot load agy's localhost redirect: "Other computer" takes the address it ended on, and the server opens it locally.
- **Or a shared secret:** `ANTIGRAVITY_OAUTH_TOKEN` (agy's token file, base64 or plain) wins over the Google sign-in when both are saved.
- **Or a Gemini API key:** the shared secret `GEMINI_API_KEY`; the bridge sets agy's `modelProvider` to `gemini` when no token is saved.

The models are what `agy models` lists for the account (the effort is part of the slug). The done gate, PR subscriptions and the briefing run from the bridge on agy's event stream, the dorks MCP server and yours go in `~/.gemini/config/mcp_config.json`, the crew and final-answer guidance is an always-on rule, and skills are the synced Claude skills folder. Attached images reach agy as a text note: its stream input takes text only.

**ChatGPT (Codex).** Claude Code is the default for new sessions; Codex (GPT models) appears as a choice once a Boat ChatGPT environment is configured. Connect ChatGPT once per Boat account, not once per dork:

1. In Boat's **Agents & Proxying** page, use a credential profile that contains only your ChatGPT subscription and connect it with the short code. The default profile works while it contains only ChatGPT. Boat does not copy sign-ins when you copy a profile.
2. Leave the account-wide AI credentials proxy **off**, to avoid its daily and per-request charges.
3. Create a Boat environment that selects that profile with **Safe for third parties off**, **Agents credentials on**, and **GitHub, Secrets, Boat credentials and Proxy AI credentials off**.
4. Save the environment's name in Settings (`boatEnvironment`).

Before it starts a Codex sandbox, the driver checks those environment switches and that a named profile (not `default`) is selected, and refuses otherwise. It cannot see the profile's contents without a Boat admin key, so keep other AI keys out of it. Boat renews the subscription and installs the sign-in on each sandbox. Dorks never stores Codex tokens in its database or snapshot. Codex defaults to GPT-6 Sol with high reasoning and never falls back to an API key. If that model or effort is unavailable on your plan, the dork pauses and asks you to pick another from Codex's list. See [Boat credentials](https://docs.boat.dev/ai-credentials) and [environment access](https://docs.boat.dev/environments/access).

This avoids Boat's paid credentials proxy, but **code inside a sandbox can read the sign-in**. Use it for your own trusted repositories only; see [SECURITY.md](../SECURITY.md#what-a-sandbox-can-read).

## Computer use

Every Boat sandbox, ours included, has a Linux desktop with Chrome, Boat's `computer` MCP server for the agent (registered in `~/.claude.json`, so Claude Code loads it beside our `dorks` server) and a live stream that the Computer tab embeds. Nothing extra to install or pay: it runs on the sandbox's own time. Details, the spike results and the limits: [computer use](computer-use.md).

## Lifecycle

- **Create** uses the snapshot with `from` (the dork's build image, else the base snapshot; and the build's `type`), a per-installation label (a hash of this install's id and the dork id, so two Dorks installs on one Boat account never adopt each other's sandboxes), the bridge variables (`DORK_ID`, `BRIDGE_PORT`, `BRIDGE_SECRET`) and `ttlSeconds: null`. A generation-scoped idempotency key protects retries, and an existing labeled sandbox is reused before another is made. The driver checks the sandbox has `flock` and `dorks-bridge`, then starts the bridge detached under `flock -n /tmp/dorks-bridge.lock`.
- **Bridge connection.** The bridge listens on `127.0.0.1:4748` in the box. The server hosts that port as a protected URL (`POST /sandboxes/{id}/host` with `{port: 4748, public: false, localhost: true}`) and dials it as `wss://<sandbox subdomain>-4748.on.boat.dev/`, sending Boat's `_token` as the `_port_auth` cookie; the token is never stored or logged. Your machine needs no inbound port or public URL. Details: [architecture](architecture.md#bridge-protocol-websocket-dialed-by-the-server).
- **Pause** is Boat `stop`; the driver waits for `archived` so the disk is saved before the dork is marked asleep. **Resume** waits for `ready`, then starts the bridge again. A resume whose bridge the server has not reached when the watchdog fires (the box is stuck, or was made for an older bridge) is not tried again: the dork deletes that box and starts a fresh one from the snapshot, once, and the waiting message goes there. Unpushed work and the agent's session on the old box are lost; a fresh box that also times out ends in `error` as usual.
- **Delete** sends `X-Ascii-Confirm-Delete` with the exact sandbox id. A sandbox that no longer exists (deleted in Boat, or its stopped disk expired) is reported as not found, and the dork recreates it on your next message. Unpushed work and on-disk Claude session state are lost.
- **Hosted ports**: see below.
- Boat API errors are logged by operation and HTTP status only, never by response body.

## Hosted ports

When its dev server is up, the agent calls the `preview_show` MCP tool with the port (`infra/bridge/src/mcp.ts`). The bridge forwards it as `show_preview`, and the driver calls `POST /sandboxes/{id}/host` with `{port, public: true, title?, localhost?}`. Boat answers `https://<sandbox subdomain>-<port>.on.boat.dev`, the same URL on every call. The server stores it on the dork, and Chat details' Artifacts shows the page as a running preview. See [hosting](https://docs.boat.dev/hosting).

- **Why public.** A protected URL carries a `_token` and then sets a `_port_auth` cookie. Inside a running preview's iframe that cookie is third-party, and the desktop shell's WebKit blocks it, so the frame would stay blank. A proxy through the server is not used either: it would have to rewrite every root-relative asset and HMR socket of an unknown dev server. So while the port is hosted, anyone who knows the sandbox's subdomain and the port can open the page. The tool's description tells the agent not to show servers that expose secrets. The driver drops any query or fragment from Boat's answer, so a token is never stored.
- `localhost: true` makes Boat relay a server that listens only on `127.0.0.1` or `::1`. Do not use it for a server on `0.0.0.0`, because the relay then holds the port.
- What Boat hosts is normally the bridge's preview proxy in front of the dev server, not the dev server itself: it listens on `127.0.0.1`, so it is always hosted with `localhost: true`. It adds the element picker's overlay to pages and makes requests look local, so Vite needs no `allowedHosts` setting ([architecture](architecture.md#preview-proxy)).
- Boat uses ports 22, 6080, 8090, 8911 and 47984 to 48010 itself, and the bridge uses 4748. The server refuses them.
- The URL survives a pause and resume, but the dev server does not: the agent starts it again and can call the tool again. A recreated box gets a new subdomain, so the stored previews are cleared with the old box id.
- Under `BOX_PROVIDER=sim` the box runs on this machine, so the stand-in answers `http://localhost:<port>/`.

API reference: [create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox), [list](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes), [stop](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox), [resume](https://docs.boat.dev/api/reference/sandboxes/resume-sandbox), [commands](https://docs.boat.dev/api/reference/agent/execute-sandbox-command), [delete](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data).
