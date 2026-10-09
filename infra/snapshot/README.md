# Base snapshot

Every dork box is a restore of one **base snapshot** (`POST /v2/box/from-snapshot`, see [`docs/upstash-box.md`](../../docs/upstash-box.md)). It is built once by hand, and rebuilt whenever Node, the Claude Code CLI or `dorks-bridge` change. Boxes already created keep their old filesystem; only new boxes pick up a new snapshot.

The snapshot must contain:

| Needed | Why |
|---|---|
| Node.js (the `node` runtime has it) | runs the bridge and Claude Code |
| `git` | clone/branch/commit/push (the bridge sets up credentials from `bridge.ghToken`) |
| Claude Code CLI (`claude`, from `@anthropic-ai/claude-code`) | the agent the bridge drives |
| `dorks-bridge` on `PATH` | `pnpm --filter @dorks/bridge build` makes one self-contained `infra/bridge/dist/cli.mjs`; it is installed as `/usr/local/bin/dorks-bridge` (not via `npm pack`: `dist/` is gitignored and the package has a `workspace:` dependency) |

The snapshot must **not** contain secrets: no Anthropic key, GitHub token, `DORK_ID`, `BRIDGE_URL` or `BRIDGE_SECRET`. Snapshots capture the filesystem *and the box's agent configuration* ([snapshots](https://upstash.com/docs/box/overall/snapshots)), so do not configure an agent or pass `env_vars` on the build box. The per-dork env and `init_command` are passed on each restore (they are **not** inherited from the snapshot).

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
   `sudo npm install -g @anthropic-ai/claude-code && sudo install -m 755 /workspace/home/dorks-bridge.mjs /usr/local/bin/dorks-bridge` (global installs need `sudo` in the box; `git` ships with the image, verify below).
4. **Verify** with `exec`: `node --version && git --version && claude --version && command -v dorks-bridge`. If a check fails, fix it and re-run before snapshotting. Optional smoke test: `DORK_ID=x BRIDGE_URL=https://invalid.invalid BRIDGE_SECRET=x dorks-bridge` should start and fail to connect rather than crash on a missing module; then remove anything it wrote (`rm -rf ~/.dorks*`, `/tmp/dorks-*`).
5. **Snapshot**: `POST /v2/box/{id}/snapshots` `{ "name": "dorks-base-<yyyymmdd>" }`, then poll `GET /v2/box/{id}/snapshots` until that snapshot's `status` is `ready`. Its `id` (`snap_...`) is the value you want.
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
