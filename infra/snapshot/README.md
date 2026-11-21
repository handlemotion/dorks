# Base snapshot

Every dork sandbox is created from one **base snapshot** in your Boat account, named by the `baseSnapshotId` setting. The app builds it with one click ("Prepare Boat", `apps/server/src/services/snapshot.ts`), which uploads the bridge bundle and `boat-install.sh` to a temporary sandbox and runs the script; the manual steps are in [docs/boat.md](../../docs/boat.md). The script also records `DORKS_BUNDLE_ID` (when set) in `/usr/local/share/dorks-bundle-id`. Rebuild the snapshot whenever Node, the Claude Code CLI, `gh` / `gh stack`, Codex or `dorks-bridge` change. Sandboxes that already exist keep their old filesystem; only new ones pick up a new snapshot.

The snapshot must contain:

| Needed | Why |
|---|---|
| Node.js ≥ 22.18 (Boat's image has it) | runs the bridge and Claude Code |
| `git` | clone/branch/commit/push (the bridge sets up credentials) |
| Claude Code CLI (`claude`) | the agent the bridge drives (Boat's image has it) |
| Codex CLI (`codex`), pinned | the OpenAI agent, signed in through a Boat environment |
| `dorks-bridge` on `PATH` | `pnpm --filter @dorks/bridge build` makes one self-contained `infra/bridge/dist/cli.mjs`, installed as `/usr/local/bin/dorks-bridge` |
| `dorks` on `PATH` | the agent's CLI (`dorks pr sub\|unsub\|list`). A symlink `/usr/local/bin/dorks → dorks-bridge`; the binary picks its role from the name it is invoked as |
| `gh` (GitHub CLI), pinned | the real one is installed at `/usr/bin/gh` |
| `gh` **shim** ahead of it | a symlink `/usr/local/bin/gh → dorks-bridge`. It supplies a GitHub token from the bridge, runs `/usr/bin/gh` with it in `GH_TOKEN`, and auto-subscribes the dork to PRs it creates ([docs/autonomy.md](../../docs/autonomy.md)). **`/usr/local/bin` must come before `/usr/bin` on the PATH of the user that runs Claude** |
| `gh stack` extension ([github/gh-stack](https://github.com/github/gh-stack)), pinned | stacked PRs. Installed by placing the release binary and a `manifest.yml` under `~/.local/share/gh/extensions/gh-stack/`; needs gh ≥ 2.90 |
| `flock` | the bridge is started under a lock |

The snapshot must **not** contain secrets: no Anthropic key, GitHub token, `DORK_ID`, `BRIDGE_URL` or `BRIDGE_SECRET`. Create the build sandbox with `--no-env` and do not sign in to any agent in it.

Extra command-line tools, variables or pre-cloned repositories for your dorks belong in a [build](../../docs/builds.md) (the **Builds** page): its own saved snapshot layered on this one, so this image stays the same for every install. Variables every session needs go under **Settings → Shared variables** (exported as environment variables inside each of your sandboxes, values never displayed). After this snapshot is rebuilt, builds made on the old one show as out of date until they are rebuilt.

## Bumping a pinned tool

Change the version and the checksum in `boat-install.sh` (`gh` publishes `gh_<v>_checksums.txt`; `gh-stack` publishes none, so hash the downloaded binary), rebuild the snapshot as described in [docs/boat.md](../../docs/boat.md), create a throwaway dork and confirm it reaches `idle`, then delete the old snapshot. Do not delete the old one first: dorks whose box was lost are re-created from whatever `BASE_SNAPSHOT_ID` points at.
