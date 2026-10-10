# Customer sandbox snapshots

A **snapshot** is a saved copy of a sandbox's disk. Every dork's sandbox (an Upstash Box) is started by restoring one. Until now all dorks restored the same **base snapshot** (Node, git, Claude Code, the bridge: [`infra/snapshot/README.md`](../infra/snapshot/README.md)), then cloned their repo and installed dependencies on every start.

Under bring your own key (BYOK: each user pastes their own Upstash API key, so their sandboxes, snapshots and builds run and bill on their own Upstash account; see [`billing.md`](billing.md)) every snapshot below lives in **the user's** account, and so does the base snapshot (`workstation.provision` builds it there). This feature lets a customer save a **setup script** for a repo. We run it once in a throwaway sandbox and snapshot the result, called an **image**. New dorks of that repo then start from the image: repo already cloned, dependencies already installed, whatever the script added already there. Code: `convex/snapshots.ts` (API and build steps), `core/snapshot.ts` (rules and the scripts that run in the sandbox), `convex/lib/upstash.ts` (provider calls).

## Per-repo environments

An **environment** belongs to one repo, and is two things: its setup script (baked into an image) and its variables. There is no environment shared by all repos and no environment that floats free of a repo. The layers, most specific first:

| Layer | Holds | Stored in |
|---|---|---|
| 1. The user's Upstash account | their API key and their **base snapshot** (Node, git, Claude Code, the bridge, `gh`, gh-stack: the same for everyone, built once per account by `workstation.provision`) | `userSettings.upstashKeyEnc`, `workstationSnapshotId` |
| 2. A repo's environment | its **setup script** (image: repo cloned, dependencies installed) and the **variables** for that repo | `sandboxImages` (one row per repo), `userSecrets.repo` |
| 3. Account-wide variables | defaults every repo gets; a repo's variable of the same name wins | `userSecrets` with no `repo` |
| 4. A repo with no environment | starts from the plain base snapshot, exactly as before | none |

Why not the alternatives: one environment for all repos (Conductor) makes every repo carry the dependencies and secrets of every other and cannot be built once per repo; an environment unbound from any repo (as Claude's cloud environments are) lets the same environment drift across repos and leaves "which repo is this for?" to the user. Here the repo is the key, so a dork's sandbox is fully determined by its repo plus the account-wide defaults.

Variables: `settings.setCliSecret({ name, value, repo? })` (omit `repo` for an account-wide default), `settings.removeCliSecret({ name, repo? })`, `settings.secretList()` (name and scope, never a value). A dork of `owner/name` receives the account-wide variables plus its repo's (`pickSecrets` in `core/env.ts`); other repos' variables never reach it. Repo-scoped values are encrypted bound to their repo (AES-GCM additional data, `aad.secret`), so a stored ciphertext cannot be moved to another repo or scope. 50 variables per account in total.

Organizations: the environments belong to the user for now (so do the dorks, the GitHub installation and the Stripe subscription). Better Auth has an organizations plugin and the Convex adapter ships its test profiles, but it is not enabled in this app, and moving ownership to an organization touches every one of those at once, so it is a separate piece of work. When it happens, `userId` on `sandboxImages` and `userSecrets` becomes the organization id and the rest of the design is unchanged.

## The default we picked

| Question | Answer |
|---|---|
| What does a customer configure? | One **bash setup script** per repo (`owner/name`). Up to 16 KB, 10 images per account. |
| Where does the script run? | In a throwaway sandbox restored from the user's own base snapshot, in the user's own Upstash account, as the sandbox user (`boxuser`, with `sudo`), in `~/work/<owner>/<name>` after the repo is cloned. `set -e -o pipefail` is on. `DORKS_BUILD=1` and `DORKS_REPO` are set. |
| When does it build? | When the script is saved and differs from the last build (`put`), or on demand (`rebuild`). Saving an unchanged script builds nothing. |
| What if there is no image, or the build failed? | The dork starts from the base snapshot, exactly as before. A failed build never blocks anything and never replaces a working image. |
| Which snapshot does a new dork use? | 1. the ready image for its repo (never another repo's), 2. the user's own base, `userSettings.workstationSnapshotId`, 3. `BASE_SNAPSHOT_ID` (only for providers that are not Upstash: a snapshot of someone else's account is useless to a BYOK user). Only new sandboxes are affected; running ones keep their disk. |
| Secrets in the script? | No. See [Security](#security). Per-dork secrets still arrive at runtime through `bridge.configure`. |

A package list or Dockerfile would be easier to explain but cannot express "install pnpm, run the repo's own `pnpm install`, build once", which is most of the value. A script can, and it is the same shape as Devin's and Factory's environment setup. A structured layer (packages, env) can be added later by generating the script.

## Customer API (Convex functions in `convex/snapshots.ts`)

| Function | What it does |
|---|---|
| `snapshots.put({ repo, setupScript, timeoutMinutes?, build? })` | Create or update the image for `repo` (`owner/name`, any capitalization). Builds unless `build: false`; `build: true` forces a build even if current. Returns `{ imageId, buildId \| null }`. |
| `snapshots.list()` | The account's images: `status` (`not_built`, `building`, `ready`, `failed`), `outdated` (`script_changed` or `base_changed` while still serving), `builtAt`, and the last build (`status`, `step`, `error`, redacted `log`). |
| `snapshots.builds({ imageId })` | The last 10 builds of one image, with logs. |
| `snapshots.rebuild({ imageId })` | Build again (new dependencies, new base snapshot). |
| `snapshots.cancel({ imageId })` | Stop the running build and delete its sandbox. |
| `snapshots.remove({ imageId })` | Delete the image and, after a short grace period, its snapshot. |
| `snapshots.effective({ repo })` | Which source a new dork of `repo` would start from: `repo`, `account` (the user's own base), `base` (the deployment's, non-Upstash only) or `none`. |

Errors are the usual `AppError` codes: `invalid` (bad repo or script), `limit` (10 images, or 2 builds at once), `rate_limited` (10 builds per rolling day), `not_configured` (no base snapshot yet: add the Upstash key and build the sandbox image first), `not_found`.

`dorks.create` stores the repo with the image's capitalization when the repo has one. The sandbox file system is case-sensitive and GitHub is not, so a dork typed as `acme/widget` would otherwise look for `~/work/acme/widget` while the image cloned `~/work/Acme/Widget`.

## How a build works

A build is a chain of scheduled Convex steps, so no single action is held open (an action may run 10 minutes; a `pnpm install` can take longer). The row in `snapshotBuilds` records the current `step`; each step does one provider call, then moves the row forward compare-and-swap (a step delivered twice is harmless).

| Step | What happens |
|---|---|
| `box` | Restore a build sandbox from the user's base snapshot (in their account, with their key): no env vars, no init command, no network policy (the script may need any host). Idempotent through a label, like dork sandboxes. |
| `start` | Upload `setup.sh`, the runner `run.sh` and, if the account has the GitHub App, a read-only token limited to that one repo. Start the runner detached. The script's time limit (default 20 min, 2 to 30) starts here. |
| `wait` | Every 5 seconds read the runner's state and the last 8 KB of its log. The runner clones the repo, **deletes the token**, then runs the customer's script. |
| `verify` | Check the sandbox is still fit for an agent (below), then remove the build leftovers. |
| `snapshot` / `snapshot_wait` | Take the snapshot and wait until the provider says `ready`. |
| done | The new snapshot becomes the image's live one; the build sandbox is deleted; the superseded snapshot is deleted after `SNAPSHOT_SUPERSEDED_GRACE_SECONDS` (default 600) in case a dork is restoring from it right now. |

A failed or cancelled build deletes its sandbox and any half-made snapshot (with retries and backoff if the provider call fails) and leaves the previous image untouched. A cron (`crons.ts`, every 5 minutes) fails any build whose step stopped coming back, so nothing stays "building" or keeps a sandbox running forever.

**Verification** (`verifyScript` in `core/snapshot.ts`, run in the build sandbox): `node git claude dorks-bridge dorks gh` must resolve to the same paths as before the script ran (a script that removes or shadows them would give a sandbox whose agent never starts), no GitHub, Anthropic or private-key credential may sit in the home directory, and no cloned repo may have credentials in its git remote. Only paths are reported, never contents.

**If an image's snapshot disappears at the provider** (deleted by hand in the Upstash console, say), the next dork of that repo would fail to start from it. Upstash answers `404` for a snapshot it never knew and `400 "Snapshot is not ready"` for a deleted one, so on either error `boxes.create` asks the provider whether the snapshot really is gone (`snapshotReady`, an account-level snapshot list). Only if it is, the image is reset to "not built" and the dork starts from the base snapshot instead. A snapshot that exists but is still being made, or any other failure, is not treated as gone.

**Usage metering.** Every build row in `snapshotBuilds` keeps `createdAt` and `finishedAt` (and the account), so build-sandbox time can be billed or capped later without new bookkeeping.

If the user's base snapshot is rebuilt (new bridge, new Claude Code: `workstation.provision` again), images keep the old one until rebuilt. They are flagged `outdated: "base_changed"` and keep working. Rebuild them with `snapshots.rebuild`.

## Security

- **No secrets in images.** The clone token is read-only, scoped to the one repo, deleted before the customer's script runs (which therefore never sees it), and the clone's remote URL is clean. The scan above blocks a script that writes a credential to the home directory. The build sandbox has no env vars and no bridge secret. Build logs are redacted of GitHub and Anthropic tokens, URL credentials and key blocks before they are stored.
- **Private repos** need the GitHub App installed on them. Without a token the clone is anonymous, so private repos fail with a log line saying to check the App installation; public repos just work.
- **The customer's script is the customer's code** running in their own throwaway sandbox. It can reach the internet (the build sandbox has no network policy). A dork sandbox restored from the image gets the usual `UPSTASH_BOX_NETWORK_POLICY`.
- **Upstash writes a GitHub token into every sandbox it starts** (`~/.git-credentials` and `~/.config/gh/hosts.yml`, owner `boxuser`, rewritten at each start). Found while building this; it comes from the Upstash account's own GitHub connection, not from us. Images do not carry it (the cleanup step deletes both files before the snapshot, and the scan ignores them), but every dork sandbox has one. See [Open questions](#open-questions).
- Limits protect cost: 10 images, 10 builds per rolling day and 2 at a time per account, 16 KB scripts, 30 minute maximum. A snapshot costs storage ($0.10 per GB-month) until deleted; replaced, failed and removed images delete theirs.

## Configuration

| Variable | Meaning |
|---|---|
| `BASE_SNAPSHOT_ID` | Non-Upstash providers only: the base snapshot images are built from and dorks fall back to. With `BOX_PROVIDER=upstash` it is never read; the base is the user's own (`workstation.provision`). |
| `SNAPSHOT_SUPERSEDED_GRACE_SECONDS` | Optional. How long a replaced snapshot lives before it is deleted (default 600). Set small only in tests. |

## Verified on a real Upstash account

[`apps/convex/scripts/snapshots-e2e.mjs`](../apps/convex/scripts/snapshots-e2e.mjs) runs the product code in the local Convex backend (`scripts/dev-backend.sh`) against real Upstash Box, with no sandbox mocks, the way production works under BYOK: the deployment has no Upstash key; the test user pastes one (Doppler `dev`'s stands in for a customer's), builds their base, saves scripts, and creates dorks.

```sh
scripts/dev-backend.sh
pnpm snapshots:e2e   # 59 checks, about 12 minutes, a few cents
```

It checks, against the real provider: no dork or image build without a key and without the user's own base; a wrong key refused by Upstash; the user's base built in their account (`workstation.provision`, 23 s) with its build box deleted; validation and ownership (including `*` refused); an image build on that base (clone, install, snapshot, build box deleted); a dork created through `dorks.create` getting a sandbox that has the repo cloned with the script's dependencies and marker file, a clean remote, no credentials from us, no build leftovers, and the bridge started by the init command as the same user and `HOME` the image was built with; a dork of another repo starting from the plain base, which has Claude Code, `dorks`, the `gh` wrapper in front of the real `gh`, and gh-stack; editing the script (old image serves while the new one builds; the old snapshot is deleted after the grace period); a failing script, a script that writes a credential and a script that removes the bridge all failing the build while the previous image keeps serving; no leaked sandboxes or snapshots after failures; cancel; removing an image; an image whose snapshot was deleted at the provider degrading to the base; the user's base deleted at the provider (the dork fails cleanly with no box; rebuilding the base fixes it; images built on the old base are flagged `base_changed` yet keep serving); and per-repo variables stored with their scope and never listed with a value. Only resources the run created are deleted afterwards (the Doppler `dev` account is shared with other test runs), and the deployment's `BOX_PROVIDER` is put back.

Covered by unit tests instead (they need no provider): that a repo's variables reach only that repo's sandbox and override the account-wide ones (`bridge.configure` end to end, `test/repoEnvConfigure.test.ts`), that a different Upstash key forgets every image while the same key changes nothing, and that the deployment's `BASE_SNAPSHOT_ID` is never used with Upstash.

Behaviours of the real API this relied on, observed 2026-10-10 (also recorded in [`upstash-box.md`](upstash-box.md)): a detached process started by an `exec` call survives the call returning (UNKNOWN B2 there, now confirmed); `files/upload` works with absolute paths such as `/tmp/...` (a relative path lands somewhere unfindable); a sandbox restored from a snapshot is ready in about 9 seconds; exec answers in about 100 ms; snapshots of a small repo plus `node_modules` are ready within seconds; the sandboxes are `aarch64`.

### Behind the cloud-agent proxy

The Convex backend in Docker has to use the egress proxy and trust its CA to reach Upstash and GitHub. `scripts/dev-backend.sh` now passes `HTTPS_PROXY` and the CA bundle into the container when they are set (cloud agent VMs). Without it, every provider call from a local backend fails with `network error (TypeError)`. Recreate the container (`docker rm -f convex-local`) after pulling this change.

## Open questions

- **The GitHub token Upstash injects into every sandbox.** Its scope depends on how the Upstash account's GitHub connection was set up. If it reaches repos the customer did not choose, an agent (or a prompt-injected repo) can use it. Worth checking in the Upstash console and turning off if possible.
- **Private npm registries and private submodules** need a credential during the build. The script deliberately cannot see one yet; a later step could pass chosen user secrets to the build, with the same credential scan.
- **Snapshots across Upstash accounts.** Snapshots are assumed to belong to one account (the API docs are silent); the design works either way, but with only one key available the e2e could not show that a second account cannot restore the first one's snapshot.
- **Rebuilding images when the base snapshot changes** is manual (`outdated: "base_changed"` tells the client to offer it).
- **The bridge in a restored sandbox could not reach the local backend** in the e2e (the sandbox is on the internet; the backend is on `127.0.0.1`), so "the bridge connects and the agent becomes ready" is not part of this e2e. The bridge process starting from the image is.
- **Changing the key** leaves the old account's snapshots behind (we can no longer reach them to delete them); the user cleans them up there.
- **Clients**: there is no UI yet; the functions above (and `settings.setCliSecret` / `removeCliSecret` / `secretList` for per-repo variables) are what the web and iOS apps call.
