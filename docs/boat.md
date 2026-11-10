# Boat sandboxes

Boat is the recommended sandbox driver for dorks. `BOX_PROVIDER=boat` selects it, and it is the default when `BOX_PROVIDER` is unset. Local development and CI still use `BOX_PROVIDER=sim`; `BOX_PROVIDER=upstash` remains available for existing deployments. The implementation is `apps/convex/convex/lib/boat.ts`.

Boat's `default` machine is 4 vCPU and 8 GB RAM at $0.036/hour, billed per second while running. A stopped sandbox costs no machine time and retains its disk for at least 14 days. Plans, start limits, storage retention and prices can change; see [Boat pricing](https://docs.boat.dev/pricing).
The free trial requires auto-stop, so this driver needs a paid Boat plan to disable Boat's one-hour timer and let dorks control its own sleep.

## Build the base snapshot

Each dork is created from a [saved snapshot](https://docs.boat.dev/snapshots/templates) named by `BASE_SNAPSHOT_ID`. The snapshot contains the bridge and team tools, but **no credentials or per-dork environment**. Boat already includes Node, git and Claude Code. `infra/snapshot/boat-install.sh` adds Codex CLI, the bridge (`dorks` and the `gh` shim), pinned `gh` and `gh stack`, Doppler, and `cf`. It checks versions and download checksums before exiting. The build box is created with `--no-env`; do not log in to any agent or set a token in it.

From a checkout with dependencies installed and a Boat API key configured for the Boat CLI:

```sh
pnpm --filter @dorks/bridge build
boat new --type default --no-env --no-auto-stop
```

Save the id printed by `boat new` as `<build-id>`, then:

```sh
boat scp infra/bridge/dist/cli.mjs <build-id>:dorks-bridge.mjs
boat scp infra/snapshot/boat-install.sh <build-id>:boat-install.sh
boat exec <build-id> -- bash boat-install.sh
boat snapshot <build-id> dorks-base-YYYYMMDD
```

Wait until the saved snapshot reports `ready` (`boat snapshot` or the dashboard). Record the snapshot name, for example `dorks-base-YYYYMMDD`, in `BASE_SNAPSHOT_ID`. Check that the build box contains no secrets before saving; do not use a user's sandbox as the source. The installer removes its copied inputs. Stop or delete the build box after the saved snapshot is ready so it stops billing. Rebuild the snapshot when the bridge or installed tools change. New dorks use the new snapshot; existing ones retain their disk.

Connect ChatGPT **once per Boat account**, not once per dork. Use a Boat credential profile containing only the ChatGPT subscription, then connect it with its short code in Boat's **Agents & Proxying** page. The default profile works while it contains only ChatGPT; do not add other AI keys to it if Dorks uses it. Boat does not copy sign-ins when you copy a profile, so moving to a different profile later requires a new sign-in. Leave the account-wide AI credentials proxy **off** to avoid its daily and per-request charges. Create a Boat environment that selects that profile and sets **Safe for third parties off**, **Agents credentials on**, and **GitHub, Secrets, Boat credentials, and Proxy AI credentials off**. Save that environment's name in Dorks Settings under **ChatGPT for Codex**. New Codex dorks use it automatically; Dorks checks those environment switches and that a named profile is selected before starting a box. The selected profile must contain only ChatGPT; Dorks cannot verify the contents without a Boat account-admin key. Boat renews the subscription and installs the sign-in on each box. Dorks never stores Codex access or refresh tokens in Convex or the base snapshot. See [Boat credentials](https://docs.boat.dev/ai-credentials) and [Boat environment access](https://docs.boat.dev/environments/access).

This direct account connection avoids Boat's paid credentials proxy, but the sign-in **can be read by code inside each box**. Use it only for this single-owner setup with trusted repositories. Linux permissions inside the box do not protect the sign-in from arbitrary code with `sudo`. Do not enable this mode for another user's code: future multi-user access requires approved per-user ChatGPT sign-in or a protected proxy.

Existing Codex boxes created before this change keep their per-box sign-in and **Reconnect ChatGPT** button. Changing the account setting does not rewrite a running box's environment. New boxes use the account-level connection, and no per-box code is offered if Boat's connection is missing. Codex requires Boat for cloud boxes (`sim` keeps device-code tests locally). It uses GPT-6 Sol with high reasoning by default and never falls back to an API key. If that model or effort is unavailable on the connected plan, the box pauses and the thread asks you to choose one from Codex's available list before it continues.

The personal Boat deployment requires `DORKS_OWNER_EMAIL` on the Convex deployment. Set it to the only email allowed to sign in. An unset value blocks sign-in and app queries; `BOX_PROVIDER=sim` bypasses this check for local development. To run with more users later, replace this gate with the approved hosted sign-in arrangement rather than copying a Codex sign-in from another box.

## Configure Convex

Create a [Boat API key](https://docs.boat.dev/api/v1) that can create, list, use and delete sandboxes and list environments for the safety check. Store it in Doppler `dorks` under `BOAT_API_KEY`; never commit or log it. Set the Convex deployment env:

| Name | Value |
| --- | --- |
| `BOX_PROVIDER` | `boat` (or leave unset for the default). Keep `sim` for local development and CI. |
| `BOAT_API_KEY` | Account key with sandbox create, list, command, stop, resume, delete and environment list access. |
| `BOAT_ORG` | Optional organization id to pin billing and list requests to one wallet. Leave unset for a personal account. |
| `BASE_SNAPSHOT_ID` | Name or id of the ready saved snapshot. |

The existing Convex env sync uses the Doppler `dev` config for local deployments; production values are managed in the `prd` dashboard. See [the secret inventory](secrets/inventory.md). Do not switch a deployment with live Upstash dorks directly: stored `boxId` values belong to Upstash. Plan a drain or migration of those dorks before changing `BOX_PROVIDER` on that deployment. This change does not modify production configuration.

## Lifecycle and security

- `createFromSnapshot` creates a sandbox with `from`, a deployment-scoped dork label, per-dork bridge variables, and `ttlSeconds: null`. Claude and older Codex boxes keep `noEnv: true`. New Codex boxes attach their account's named Boat environment only if it passes agent credentials from a named profile and disables the other credential sources. The app's own sleep timer stops it; Boat's one-hour default must not stop an active dork. A generation-scoped idempotency key protects create retries. The driver looks up an existing labeled sandbox before creating another.
- `pause` maps to Boat `stop` and waits for `archived` so the disk is saved before dorks marks the box asleep. `resume` waits for `ready`/`idle`/`running`, then starts the bridge. The bridge is a detached, lock-guarded command. On a quick resume it is still running; after a cold resume it is started once. The only values in the command are the executable and lock path; the per-dork bridge secret is injected via `env`, not command arguments.
- `delete` sends `X-Ascii-Confirm-Delete` for the exact sandbox id. A missing box on resume is reported as `BoxNotFoundError` so the existing lifecycle clears its stale id and recreates it on the next message. Expired stopped-disk data is treated the same way. It loses unpushed work and on-disk Claude session state.
- Boat API errors are logged by operation and HTTP status only, not by response message. Users' Claude and GitHub credentials still arrive through the bridge; new Codex boxes also receive the personal Boat account's ChatGPT sign-in through their selected environment.

API details: [create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox), [list](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes), [stop](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox), [resume](https://docs.boat.dev/api/reference/sandboxes/resume-sandbox), [commands](https://docs.boat.dev/api/reference/agent/execute-sandbox-command), [delete](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data).
