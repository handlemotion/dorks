# Customer sandbox snapshots

A **snapshot** is a saved copy of a sandbox's disk. Every dork's sandbox (an Upstash Box) is started by restoring one. Until now all dorks restored the same **base snapshot** (Node, git, Claude Code, the bridge: [`infra/snapshot/README.md`](../infra/snapshot/README.md)), then cloned their repo and installed dependencies on every start.

This feature lets a customer save a **setup script** for a repo. We run it once in a throwaway sandbox and snapshot the result, called an **image**. New dorks of that repo then start from the image: repo already cloned, dependencies already installed, whatever the script added already there. Code: `convex/snapshots.ts` (API and build steps), `core/snapshot.ts` (rules and the scripts that run in the sandbox), `convex/lib/upstash.ts` (provider calls).

## The default we picked

| Question | Answer |
|---|---|
| What does a customer configure? | One **bash setup script** per repo (`owner/name`), or one for **all repos** (`*`). Up to 16 KB, 10 images per account. |
| Where does the script run? | In a throwaway sandbox restored from the base snapshot (or the account's own override snapshot), as the sandbox user (`boxuser`, with `sudo`), in `~/work/<owner>/<name>` after the repo is cloned. For `*` there is no clone and it runs in `~/work`. `set -e -o pipefail` is on. `DORKS_BUILD=1` and `DORKS_REPO` are set. |
| When does it build? | When the script is saved and differs from the last build (`put`), or on demand (`rebuild`). Saving an unchanged script builds nothing. |
| What if there is no image, or the build failed? | The dork starts from the base snapshot, exactly as before. A failed build never blocks anything and never replaces a working image. |
| Which snapshot does a new dork use? | 1. the ready image for its repo, 2. the ready `*` image, 3. the account's `userSettings.workstationSnapshotId` override, 4. `BASE_SNAPSHOT_ID`. Only new sandboxes are affected; running ones keep their disk. |
| Secrets in the script? | No. See [Security](#security). Per-dork secrets still arrive at runtime through `bridge.configure`. |

A package list or Dockerfile would be easier to explain but cannot express "install pnpm, run the repo's own `pnpm install`, build once", which is most of the value. A script can, and it is the same shape as Devin's and Factory's environment setup. A structured layer (packages, env) can be added later by generating the script.

## Customer API (Convex functions in `convex/snapshots.ts`)

| Function | What it does |
|---|---|
| `snapshots.put({ repo, setupScript, timeoutMinutes?, build? })` | Create or update the image for `repo` (`owner/name`, any capitalization) or `*`. Builds unless `build: false`; `build: true` forces a build even if current. Returns `{ imageId, buildId \| null }`. |
| `snapshots.list()` | The account's images: `status` (`not_built`, `building`, `ready`, `failed`), `outdated` (`script_changed` or `base_changed` while still serving), `builtAt`, and the last build (`status`, `step`, `error`, redacted `log`). |
| `snapshots.builds({ imageId })` | The last 10 builds of one image, with logs. |
| `snapshots.rebuild({ imageId })` | Build again (new dependencies, new base snapshot). |
| `snapshots.cancel({ imageId })` | Stop the running build and delete its sandbox. |
| `snapshots.remove({ imageId })` | Delete the image and, after a short grace period, its snapshot. |
| `snapshots.effective({ repo })` | Which source a new dork of `repo` would start from: `repo`, `default`, `account`, `base` or `none`. |

Errors are the usual `AppError` codes: `invalid` (bad repo or script), `limit` (10 images, or 2 builds at once), `rate_limited` (10 builds per rolling day), `not_configured` (no base snapshot), `not_found`.

`dorks.create` stores the repo with the image's capitalization when the repo has one. The sandbox file system is case-sensitive and GitHub is not, so a dork typed as `acme/widget` would otherwise look for `~/work/acme/widget` while the image cloned `~/work/Acme/Widget`.

## How a build works

A build is a chain of scheduled Convex steps, so no single action is held open (an action may run 10 minutes; a `pnpm install` can take longer). The row in `snapshotBuilds` records the current `step`; each step does one provider call, then moves the row forward compare-and-swap (a step delivered twice is harmless).

| Step | What happens |
|---|---|
| `box` | Restore a build sandbox from the base snapshot: no env vars, no init command, no network policy (the script may need any host). Idempotent through a label, like dork sandboxes. |
| `start` | Upload `setup.sh`, the runner `run.sh` and, if the account has the GitHub App, a read-only token limited to that one repo. Start the runner detached. The script's time limit (default 20 min, 2 to 30) starts here. |
| `wait` | Every 5 seconds read the runner's state and the last 8 KB of its log. The runner clones the repo, **deletes the token**, then runs the customer's script. |
| `verify` | Check the sandbox is still fit for an agent (below), then remove the build leftovers. |
| `snapshot` / `snapshot_wait` | Take the snapshot and wait until the provider says `ready`. |
| done | The new snapshot becomes the image's live one; the build sandbox is deleted; the superseded snapshot is deleted after `SNAPSHOT_SUPERSEDED_GRACE_SECONDS` (default 600) in case a dork is restoring from it right now. |

A failed or cancelled build deletes its sandbox and any half-made snapshot (with retries and backoff if the provider call fails) and leaves the previous image untouched. A cron (`crons.ts`, every 5 minutes) fails any build whose step stopped coming back, so nothing stays "building" or keeps a sandbox running forever.

**Verification** (`verifyScript` in `core/snapshot.ts`, run in the build sandbox): `node git claude dorks-bridge dorks gh` must resolve to the same paths as before the script ran (a script that removes or shadows them would give a sandbox whose agent never starts), no GitHub, Anthropic or private-key credential may sit in the home directory, and no cloned repo may have credentials in its git remote. Only paths are reported, never contents.

**If an image's snapshot disappears at the provider** (deleted by hand in the Upstash console, say), the next dork of that repo would fail to start from it. Upstash answers `404` for a snapshot it never knew and `400 "Snapshot is not ready"` for a deleted one, so on either error `boxes.create` asks the provider whether the snapshot really is gone (`snapshotReady`, an account-level snapshot list). Only if it is, the image is reset to "not built" and the dork starts from the base snapshot instead. A snapshot that exists but is still being made, or any other failure, is not treated as gone.

**Usage metering.** Every build row in `snapshotBuilds` keeps `createdAt` and `finishedAt` (and the account), so build-sandbox time can be billed or capped later without new bookkeeping.

If the base snapshot is rebuilt (new bridge, new Claude Code), images keep the old one until rebuilt. They are flagged `outdated: "base_changed"` and keep working. Rebuild them with `snapshots.rebuild`.

## Security

- **No secrets in images.** The clone token is read-only, scoped to the one repo, deleted before the customer's script runs (which therefore never sees it), and the clone's remote URL is clean. The scan above blocks a script that writes a credential to the home directory. The build sandbox has no env vars and no bridge secret. Build logs are redacted of GitHub and Anthropic tokens, URL credentials and key blocks before they are stored.
- **Private repos** need the GitHub App installed on them. Without a token the clone is anonymous, so private repos fail with a log line saying to check the App installation; public repos just work.
- **The customer's script is the customer's code** running in their own throwaway sandbox. It can reach the internet (the build sandbox has no network policy). A dork sandbox restored from the image gets the usual `UPSTASH_BOX_NETWORK_POLICY`.
- **Upstash writes a GitHub token into every sandbox it starts** (`~/.git-credentials` and `~/.config/gh/hosts.yml`, owner `boxuser`, rewritten at each start). Found while building this; it comes from the Upstash account's own GitHub connection, not from us. Images do not carry it (the cleanup step deletes both files before the snapshot, and the scan ignores them), but every dork sandbox has one. See [Open questions](#open-questions).
- Limits protect cost: 10 images, 10 builds per rolling day and 2 at a time per account, 16 KB scripts, 30 minute maximum. A snapshot costs storage ($0.10 per GB-month) until deleted; replaced, failed and removed images delete theirs.

## Configuration

| Variable | Meaning |
|---|---|
| `BASE_SNAPSHOT_ID` | The base snapshot images are built from and dorks fall back to. |
| `SNAPSHOT_SUPERSEDED_GRACE_SECONDS` | Optional. How long a replaced snapshot lives before it is deleted (default 600). Set small only in tests. |

## Verified on a real Upstash account

[`apps/convex/scripts/snapshots-e2e.mjs`](../apps/convex/scripts/snapshots-e2e.mjs) runs the product code in the local Convex backend (`scripts/dev-backend.sh`) against real Upstash Box, with no sandbox mocks: it signs in, saves a script for a public repo, waits for the build, then creates a dork and inspects the real sandbox it got.

```sh
scripts/dev-backend.sh
cd apps/convex && doppler run -p dorks -c dev -- node scripts/snapshots-e2e.mjs   # 40 checks, about 5 minutes, a few cents
```

It checks, against the real provider: validation and ownership; build, snapshot and build-sandbox deletion; a dork created through `dorks.create` getting a sandbox that has the repo cloned with the script's dependencies and marker file, a clean remote, no credentials from us and no build leftovers, and the bridge started by the init command as the same user and `HOME` the image was built with; a dork of another repo starting from the base snapshot; editing the script (old image serves while the new one builds; the old snapshot is deleted after the grace period); a failing script, a script that writes a credential and a script that removes the bridge all failing the build while the previous image keeps serving; no leaked sandboxes or snapshots after failures; cancel; removing an image; and an image whose snapshot was deleted at the provider degrading to the base snapshot.

Behaviours of the real API this relied on, observed 2026-10-10 (also recorded in [`upstash-box.md`](upstash-box.md)): a detached process started by an `exec` call survives the call returning (UNKNOWN B2 there, now confirmed); `files/upload` works with absolute paths such as `/tmp/...` (a relative path lands somewhere unfindable); a sandbox restored from a snapshot is ready in about 9 seconds; exec answers in about 100 ms; snapshots of a small repo plus `node_modules` are ready within seconds; the sandboxes are `aarch64`.

### Behind the cloud-agent proxy

The Convex backend in Docker has to use the egress proxy and trust its CA to reach Upstash and GitHub. `scripts/dev-backend.sh` now passes `HTTPS_PROXY` and the CA bundle into the container when they are set (cloud agent VMs). Without it, every provider call from a local backend fails with `network error (TypeError)`. Recreate the container (`docker rm -f convex-local`) after pulling this change.

## Open questions

- **The GitHub token Upstash injects into every sandbox.** Its scope depends on how the Upstash account's GitHub connection was set up. If it reaches repos the customer did not choose, an agent (or a prompt-injected repo) can use it. Worth checking in the Upstash console and turning off if possible.
- **Private npm registries and private submodules** need a credential during the build. The script deliberately cannot see one yet; a later step could pass chosen user secrets to the build, with the same credential scan.
- **Rebuilding images when the base snapshot changes** is manual (`outdated: "base_changed"` tells the client to offer it).
- **The bridge in a restored sandbox could not reach the local backend** in the e2e (the sandbox is on the internet; the backend is on `127.0.0.1`), so "the bridge connects and the agent becomes ready" is not part of this e2e. The bridge process starting from the image is.
- **Clients**: there is no UI yet; the functions above are what the web and iOS apps call.
