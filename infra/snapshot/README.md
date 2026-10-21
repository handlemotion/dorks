# Base snapshot

Every dork box is a restore of one **base snapshot** (`POST /v2/box/from-snapshot`, see [`docs/upstash-box.md`](../../docs/upstash-box.md)). It is built once by hand, and rebuilt whenever Node, the Claude Code CLI, `gh` / `gh stack`, Doppler, `cf` or `dorks-bridge` change. It is the team's one environment preset: every user and every dork gets the same snapshot (per-user `workstationSnapshotId` exists, but nothing builds a different one). Boxes already created keep their old filesystem; only new boxes pick up a new snapshot.

The snapshot must contain:

| Needed | Why |
|---|---|
| Node.js (the `node` runtime has it) | runs the bridge and Claude Code |
| `git` | clone/branch/commit/push (the bridge sets up credentials from `bridge.ghToken`) |
| Claude Code CLI (`claude`, from `@anthropic-ai/claude-code`) | the agent the bridge drives |
| `dorks-bridge` on `PATH` | `pnpm --filter @dorks/bridge build` makes one self-contained `infra/bridge/dist/cli.mjs`, installed as `/usr/local/bin/dorks-bridge` (not via `npm pack`: `dist/` is gitignored and the package has a `workspace:` dependency) |
| `dorks` on `PATH` | the agent's CLI (`dorks pr sub\|unsub\|list`). Not a second program: a symlink `/usr/local/bin/dorks → dorks-bridge`; the binary picks its role from the name it is invoked as |
| `gh` (GitHub CLI), pinned: v2.102.0 | the real one is installed at `/usr/bin/gh` |
| `gh` **shim** ahead of it | a symlink `/usr/local/bin/gh → dorks-bridge`. It gets a fresh installation token from the bridge, runs `/usr/bin/gh` with it in `GH_TOKEN`, and auto-subscribes the dork to PRs it creates ([`docs/autonomy.md`](../../docs/autonomy.md)). **`/usr/local/bin` must come before `/usr/bin` on the PATH of the user that runs Claude**; step 4 checks it (`DORKS_REAL_GH` overrides the real gh's location) |
| `gh stack` extension ([github/gh-stack](https://github.com/github/gh-stack)), pinned: v0.2.0 | stacked PRs. Installed by placing the release binary and a `manifest.yml` under `~/.local/share/gh/extensions/gh-stack/` of the box user (what `gh extension install` does, without needing a GitHub login at build time); do it as the user that runs Claude (`CLAUDE_RUN_AS`) if that is not the user of the build box. Needs gh ≥ 2.90 |
| Doppler CLI (`doppler`), pinned: v3.77.0 | team secrets. Release tarball, checksum-verified, at `/usr/local/bin/doppler`. Authenticates from `DOPPLER_TOKEN` (see below) |
| Cloudflare CLI (`cf`, npm `cf`), pinned: 0.15.0 | deploys. Installed with `npm install -g`; needs Node ≥ 22.18, which step 4 checks. Authenticates from `CLOUDFLARE_API_TOKEN`, or from Doppler: `doppler run -p dorks -c dev -- cf ...` |

The snapshot must **not** contain secrets (no Doppler or Cloudflare token either): no Anthropic key, GitHub token, `DORK_ID`, `BRIDGE_URL` or `BRIDGE_SECRET`. Snapshots capture the filesystem *and the box's agent configuration* ([snapshots](https://upstash.com/docs/box/overall/snapshots)), so do not configure an agent or pass `env_vars` on the build box. The per-dork env and `init_command` are passed on each restore (they are **not** inherited from the snapshot).

### Credentials for the team CLIs

The snapshot only has the binaries. Each user adds the tokens once in the web app under **Settings → CLI secrets** (exported as environment variables inside every one of their sandboxes, values never displayed): a Doppler service token as `DOPPLER_TOKEN` (`doppler` then works with no login, and `doppler run -- cf ...` gives `cf` its Cloudflare credentials), or `CLOUDFLARE_API_TOKEN` for `cf` directly. `gh` needs nothing: the shim gets a GitHub token from the bridge.

## Build it

`./print-build-plan.sh` prints every API call below as ready-to-run `curl` commands (it only prints, it executes nothing and reads no credentials). Do it from a trusted machine with `UPSTASH_BOX_API_KEY` set:

```sh
./infra/snapshot/print-build-plan.sh > /tmp/build-snapshot.sh   # review it
less /tmp/build-snapshot.sh
UPSTASH_BOX_API_KEY=... bash /tmp/build-snapshot.sh              # runs it, interactively confirm each step if you like
```

Steps (the same as in the script):

1. **Build the bridge bundle** locally: `pnpm --filter @dorks/bridge build` (produces `infra/bridge/dist/cli.mjs`).
2. **Create the build box**: `POST /v2/box` `{ "name": "dorks-base-build", "runtime": "node", "labels": ["dorks-base"] }`, and poll `GET /v2/box/{id}` until `status` is not `creating`. No `init_command`, no `env_vars`, no agent.
3. **Install**: upload the bundle (`POST /v2/box/{id}/files/upload`, multipart) and `exec`:
   - `sudo npm install -g @anthropic-ai/claude-code`, then install the bundle as `/usr/local/bin/dorks-bridge` with symlinks `dorks` and `gh` next to it (global installs need `sudo` in the box; `git` ships with the image, verify below);
   - `cf` is installed by the same `npm install -g`, at its pinned version;
   - download the pinned `gh` release, the pinned Doppler release and the pinned `gh-stack` binary for the box's architecture (amd64 and arm64 are in the script), verify their SHA-256, put `gh` at `/usr/bin/gh`, `doppler` at `/usr/local/bin/doppler` and the extension under `~/.local/share/gh/extensions/gh-stack/`. To bump a version, change the version and both checksums in `print-build-plan.sh` (gh publishes `gh_<v>_checksums.txt`, Doppler `checksums.txt` on its GitHub release; gh-stack publishes none, so hash the downloaded binary). `cf` is bumped by changing its npm version.
4. **Verify** with `exec`: Node ≥ 22.18 (for `cf`), `git --version && claude --version && command -v dorks-bridge && command -v dorks`, that `command -v gh` is `/usr/local/bin/gh` (the shim) while `/usr/bin/gh --version` works, `gh stack --help`, `doppler --version` and `cf --version`. If a check fails, fix it and re-run before snapshotting. Optional smoke test: `DORK_ID=x BRIDGE_URL=https://invalid.invalid BRIDGE_SECRET=x dorks-bridge` should start and fail to connect rather than crash on a missing module; then remove anything it wrote (`rm -rf ~/.dorks*`, `/tmp/dorks-*`).
5. **Snapshot**: `POST /v2/box/{id}/snapshots` `{ "name": "dorks-base-<yyyymmdd>" }`, then poll `GET /v2/box/{id}/snapshots` until that snapshot's `status` is `ready`. Its `id` (a UUID, e.g. `12caffe1-…`) is the value you want.
6. **Delete the build box** (`DELETE /v2/box/{id}`); the snapshot is independent of it ([snapshots](https://upstash.com/docs/box/overall/snapshots)).

Storage is billed at $0.10/GB-month including snapshots ([pricing](https://upstash.com/docs/box/overall/pricing)), so delete superseded snapshots once no dork needs them: `DELETE /v2/box/snapshots` with body `{"ids":["snap_..."]}` (explicit ids only; never `?all=true`, which deletes every snapshot on the account), or the console.

## Point dorks at it

The snapshot id is read in `convex/lifecycle.ts` `boxInfo`: the per-user `userSettings.workstationSnapshotId` if set, else the Convex env var `BASE_SNAPSHOT_ID`. Without either, every create fails with "No base snapshot configured".

```sh
cd apps/convex
npx convex env set BOX_PROVIDER upstash
npx convex env set UPSTASH_BOX_API_KEY <key>          # from console.upstash.com -> Box -> API keys
npx convex env set BASE_SNAPSHOT_ID snap_xxxxxxxx
# optional, after docs/upstash-box.md section (e) is verified:
# npx convex env set UPSTASH_BOX_NETWORK_POLICY dorks
```

Use `--prod` (or the deployment selector you normally use) for a cloud deployment. Setting `BASE_SNAPSHOT_ID` only affects **new** boxes; to roll back, set it to the previous id.

## Rebuilding

Build a new snapshot, set `BASE_SNAPSHOT_ID` to it, create a throwaway dork and confirm it reaches `idle` (bridge connected), then delete the old snapshot. Do not delete the old one first: dorks whose box was lost re-create from whatever `BASE_SNAPSHOT_ID` points at.
