# Local dorks

A dork runs either in the **cloud** (its own Boat sandbox, the default, unchanged) or **locally**: on the owner's own computer, with the
agent CLIs installed there (`claude`, `codex`, …) working in a git worktree of the repository. The choice is per dork, made when it
starts, and fixed for its life.

## Using it

- The new-session composer has a compact **Cloud / Local** menu next to the repository picker (`apps/web/src/components/LocationMenu.tsx`).
  It appears only when the server says this client may start local dorks (`GET /api/settings` `local.available`). The last pick is
  remembered as `settings.defaultLocation`, which Settings → Sessions → "Where sessions run" also switches.
- Repositories come from the connected GitHub account, the same picker as for the cloud. There is no "choose a folder" step: Dorks never
  works in a checkout of the owner's own.
- The menu says it once: local agents run **unsandboxed, as the owner**. The agent is told the same (`LOCAL_GUIDANCE`,
  `infra/bridge/src/guidance.ts`) and asked to stay inside its worktree.
- A local session needs GitHub and the agent's CLI on this computer, plus Node.js 22 or later (the bridge is a Node script). It needs no
  Boat key and no base snapshot, so it can start before Boat is set up. Claude still runs with the Claude token saved in Dorks (the
  same `configure` path as a sandbox), not the CLI's own login.
- A local chat shows a laptop mark and its repository in the composer's bar; its Computer tab says it has no screen of its own.

## Checkouts: one clone per repository, one worktree per dork

`apps/server/src/lib/localGit.ts`, under `<data dir>/local/`:

```
local/
  repos/<owner>/<name>.git          one bare clone per repository (from GitHub; fetched before every use)
  boxes/<dork id>/
    work/<owner>/<name>             the dork's git worktree, on its own branch (agent/xxxxxxxx)
    state/  claude/  bin/            the bridge's state, CLAUDE_CONFIG_DIR (sessions, skills), the dorks and gh shims
    gitconfig                        GIT_CONFIG_GLOBAL for the dork: the owner's user.name/email, the bridge's credential helper
    bridge.log
  bridge/dorks-bridge-<sha>.mjs     the bridge bundle this server carries
```

- **Start**: the clone is made the first time (`git init --bare`, fetch into `refs/remotes/origin/*`, `remote set-head --auto`) and
  fetched every time after; then `git worktree add` makes the dork's worktree on a new branch off `origin/HEAD`. Git runs here with no
  user or system config and the GitHub token only in its environment, never in a URL. Operations on one clone are serialized.
- **Archive** removes the worktree (`git worktree remove --force`, then `git worktree prune`). Commits stay on the branch in the
  clone (and on GitHub once pushed); **uncommitted changes in the worktree are discarded**. An awake dork's archive pauses its box and
  the pause removes the worktree; a dork that already sleeps gets a `box:retire` job that does the same.
- **Unarchive** changes nothing on disk; the next message wakes the dork and the worktree is added again: from the clone's branch
  (fast-forwarded to the pushed branch when that is ahead), else from the pushed branch, else from the default branch. The agent resumes
  its session (transcripts live in the box's `claude/`, at the same worktree path).
- **Delete** stops the bridge, removes the worktree and the dork's branch in the clone (never on GitHub), and the box directory. Clones
  stay for the next dork on that repository.

## The local box provider

`apps/server/src/lib/localBox.ts` implements `BoxProvider` (`packages/core/src/box.ts`). A box is `local-<dork id>`; its row in
`local_boxes` holds the bridge's loopback port and whether it should run.

| Box call | Local |
|---|---|
| `createFromSnapshot` | clone/fetch, worktree, then the bridge (the snapshot is ignored) |
| `resume` | worktree again if it was removed, then the bridge |
| `pause` | SIGTERM to the bridge's process group (the agent and whatever it started), SIGKILL after 5 s; archived: remove the worktree |
| `delete` | as above, plus the branch and the box directory |
| `retire` | archived while asleep: remove the worktree |
| `bridgeEndpoint` | `ws://127.0.0.1:<port>/`; starts the bridge first if the box should run and it does not (after a server restart) |
| `hostPort` | `http://localhost:<port>/`: previews are the dev server on this computer |
| `desktopUrl` | none: `POST /api/dorks/:id/desktop` answers `not_configured` |

The bridge is the real one (`infra/bridge`), run with the owner's Node.js as a child of the server in its own process group, with
`DORKS_LOCAL_BOX=1` and `DORKS_PARENT_PID` (it exits within 2 s of the server going away, so nothing is left running after the app
quits). Its environment is what a box gives a bridge plus this computer's PATH: the owner's login-shell PATH (read once; a Finder-launched
app has a minimal one) and the usual install directories, with `bin/` (`dorks` and `gh` shims, as in a sandbox) first. `HOME` is the
owner's, so CLIs find their own installs; `CLAUDE_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` are the box's, so Dorks never writes to
`~/.claude` or `~/.gitconfig`. The bridge secret goes in a 0400 file it unlinks on read. A bridge that exits by itself while its box
should run is started again after 2 s, at most five times in a row within a minute.

## Routing and the lifecycle

The lifecycle machine (`packages/core/src/machine.ts`) does not know about locations. Each dork stores `location` (`dorks.location`,
`cloud` by default for every existing row) and the server asks `app.getBox(location)` for its provider: box jobs
(`lifecycle/jobs.ts`), bridge links (`http/bridgeLinks.ts`), previews and the desktop. `BOX_PROVIDER` (`boat` or `sim`) still picks
the cloud provider only; a local dork uses the local provider under either. An orphaned box is routed by its id (`local-…`). A
coordinator's workers run where it does.

## Who may use it

Local dorks run code on the owner's computer, so:

- Only the **local actor** (the owner token on loopback: the desktop app, or the dev web app on this computer) may create one, change
  `defaultLocation`, or drive one. A relayed client (the iPhone app, a teammate through the cloud relay) gets `local.available: false`,
  `defaultLocation: "cloud"`, and `forbidden` for `location: "local"`; it can **read** a local dork (list, transcript, files) but not
  send or queue messages, comment on its previews, answer its input requests or write its files.
- A server that runs in the cloud for an organization (`DORKS_ORG_ID`) never offers local; `DORKS_LOCAL=0` turns it off anywhere.
- The iPhone app never offers Local; local dorks show there like any other, read-only. Their previews are `localhost` URLs, which only
  open on the computer itself.

## Not supported locally (yet)

- Builds and machine-setup sessions (they are cloud images); Codex's Boat ChatGPT environment (a local Codex uses the CLI's own login,
  untested); the Computer tab; "Move to cloud" for a local dork.
- Uncommitted work does not survive an archive; committed work does.
- Codex and the other agents get the local PATH but not `LOCAL_GUIDANCE` (Claude only for now).
- The onboarding checklist still asks for Boat even if the owner only wants local sessions.
