# Builds

Status: **proposed, for review**. Nothing here is implemented yet.

A **build** is a named machine setup, separate from repos: the tools a dork's sandbox has installed, the environment variables it gets
and the repositories already cloned into it. A dork starts on a build, so its machine is ready the moment it boots instead of the agent
spending its first minutes installing things.

Today every dork starts from one base snapshot per install (`apps/server/src/services/snapshot.ts`, `infra/snapshot/boat-install.sh`),
gets the global CLI secrets in its `configure` frame and clones its one repo at start. Builds keep all of that and add an optional layer
on top.

## Decisions

| # | Decision |
|---|---|
| 1 | **A build is a Boat saved snapshot layered on the base snapshot.** Building runs the build's setup in a fresh sandbox created `from` the base snapshot, then saves it under one name per build. No Dockerfile: Boat has none, a saved snapshot is its image ([choose](https://docs.boat.dev/environments/choose)). |
| 2 | **Setup runs once, at build time**, never at every dork start. Slow installs belong in the image (Boat's own rule). Dorks wake from their own disk, as today. |
| 3 | **Variables and secrets reach the dork through `configure`**, as CLI secrets do today, not through Boat environments. Reasons under "Why not Boat environments". |
| 4 | **Per-repo setup scripts: yes. Per-repo variables: no.** A repo entry has an optional script run in its clone at build time (Boat's repository setup script, same shape). Variables are process-wide; a variable "for one repo" is a global one with a worse UI. |
| 5 | **The base snapshot stays.** "Prepare Boat" builds it exactly as today. A dork on no build starts from it. Builds are opt-in, so nothing migrates by force. |
| 6 | **Agents edit a draft, never the build.** Any Claude dork gets five deferred MCP tools scoped to its own build: read it, edit a draft, run the draft in a throwaway sandbox, read the logs, submit the draft. Only the owner turns a draft into the build. |
| 7 | **No image from a spec the owner has not seen, and no secret value in a script the owner has not seen.** Every spec has a hash. Saving an image and injecting build-time secrets both require the owner to have approved that hash. Trial runs (no save, no secrets) do not. |
| 8 | **"Set up a machine" is an ordinary dork**, opened from a build's page, with no repo required. It is not a special environment: the tools in decision 6 are the same in every dork, so a dork working on a repo can also say "I installed X; add it to the build?" |
| 9 | **Tools load on demand.** Claude Code defers MCP tool schemas by default (tool search): only tool names and a one-sentence server instruction reach every session. No change to the base prompt (`infra/bridge/src/guidance.ts`) or SessionStart context. |
| 10 | **Logs come from Boat.** A run's setup is one detached Boat command; the server follows its output stream and keeps a capped, redacted tail. Boat keeps the full log for 90 days in command history. |

## Concepts

- **Build**: the definition (name, machine size, setup script, repos, variables). Edited by the owner, or by an agent through a draft.
- **Spec**: the parts of a build that change the image: setup script, repos and their scripts, machine size, and the *names* of build-time
  secrets. `spec_hash = sha256` of their canonical JSON. Variable values are not in the spec: changing one never needs a rebuild.
- **Image**: the build's saved snapshot in the owner's Boat account, `dorks-b-<8 hex install id>-<8 hex build id>`. One per build;
  rebuilding saves the same name, which Boat replaces only once the new save is `ready` (as the base snapshot does today).
- **Run**: one execution of a spec. `image` runs save the image; `trial` runs do the same steps in a throwaway sandbox and save nothing.
- **Draft**: an agent's proposed spec (and variable requests) for one build, one per (build, dork).

## Data model

New migration (append-only, `apps/server/src/migrations.ts`):

```sql
CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                        -- 1..60 chars, shown in pickers
  machine_type TEXT NOT NULL DEFAULT 'default',     -- Boat sandbox type: small | default | large | xlarge
  setup_script TEXT NOT NULL DEFAULT '',            -- bash, run as `user` (passwordless sudo) in /home/user, 64 KB max
  repos TEXT NOT NULL DEFAULT '[]',                 -- JSON [{ repo: "owner/name", branch?: string, setupScript?: string }], at most 10
  rev INTEGER NOT NULL DEFAULT 1,                   -- bumped on every spec change
  spec_hash TEXT NOT NULL,
  approved_hash TEXT,                               -- the spec the owner last approved; owner edits approve themselves
  image TEXT,                                       -- saved snapshot name of the last good image, NULL before the first one
  image_rev INTEGER, image_hash TEXT,               -- the spec it was built from
  image_base TEXT,                                  -- bundle id of the base snapshot it was layered on (staleness)
  image_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Values are AES-GCM envelopes (core/crypto.ts), additional data binds each to (build id, name), like `secrets`.
CREATE TABLE build_vars (
  build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- ^[A-Z][A-Z0-9_]{0,63}$, the same rule as CLI secrets
  value_enc TEXT,                                   -- NULL: requested by an agent, waiting for the owner to fill in
  secret INTEGER NOT NULL,                          -- 1: write-only, never shown or given to a tool. 0: plain, shown
  build_time INTEGER NOT NULL DEFAULT 0,            -- also exported to the setup script (image runs of approved specs only)
  PRIMARY KEY (build_id, name)
) WITHOUT ROWID;

CREATE TABLE build_runs (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'trial')),
  spec TEXT NOT NULL,                               -- the spec JSON this run executes (a draft's, for an agent's trial)
  spec_hash TEXT NOT NULL,
  started_by TEXT NOT NULL,                         -- 'owner' or 'dork:<id>'
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  step TEXT, error TEXT,                            -- error is written for a person, like snapshot_build.error
  attempt INTEGER NOT NULL DEFAULT 1,
  sandbox_id TEXT, process_id TEXT, command_id TEXT, -- Boat ids, for cleanup and for the full log in command history
  exit_code INTEGER,
  log TEXT NOT NULL DEFAULT '',                     -- redacted tail, at most 256 KB
  log_bytes INTEGER NOT NULL DEFAULT 0,             -- stream offset reached, to resume the attach stream after a restart
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX build_runs_build ON build_runs (build_id, created_at DESC);

CREATE TABLE build_drafts (
  id TEXT PRIMARY KEY,
  build_id TEXT REFERENCES builds (id) ON DELETE CASCADE,  -- NULL: the agent proposes a new build (name in spec)
  dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
  base_rev INTEGER,                                 -- the build rev the draft started from (a stale draft shows a warning)
  spec TEXT NOT NULL,
  plain_vars TEXT NOT NULL DEFAULT '{}',            -- name -> value, plain variables only
  var_requests TEXT NOT NULL DEFAULT '[]',          -- [{ name, secret, buildTime, why }]: the owner types the values
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('editing', 'submitted', 'approved', 'rejected')),
  updated_at INTEGER NOT NULL,
  UNIQUE (build_id, dork_id)
);

ALTER TABLE dorks ADD COLUMN build_id TEXT REFERENCES builds (id) ON DELETE SET NULL;  -- NULL: the base snapshot
ALTER TABLE settings ADD COLUMN default_build_id TEXT;
```

The existing `secrets` table (CLI secrets) stays: those are **shared variables**, given to every dork on any build. A build variable with
the same name wins.

Limits: 50 builds, 100 variables per build, 16 KB per value (as today), 64 KB per script, the last 20 runs kept per build (older rows
deleted, Boat still has their logs).

## How a build maps onto Boat

### What Boat offers, and what we use

| Need | Boat primitive | Used |
|---|---|---|
| Tools installed, repos cloned, caches warm | [Saved snapshot](https://docs.boat.dev/snapshots/templates), created `from` another | **Yes**: one per build, layered on the base |
| Run setup and watch it | Sandbox + [detached command](https://docs.boat.dev/api/reference/agent/execute-sandbox-command) + [attach stream](https://docs.boat.dev/api/reference/agent/attach-command) | **Yes** |
| Full logs later | [Command history](https://docs.boat.dev/long-running-tasks/command-history), 90 days, readable while stopped | **Yes**: `command_id` is stored |
| Machine size | Sandbox `type` | **Yes**: per build, passed on create and on the build sandbox |
| Per-repo setup script | Environment [repository setup script](https://docs.boat.dev/setup#repository-setup-scripts) | Same shape, run by us at build time (below) |
| Variables, secret files | [Environments](https://docs.boat.dev/environments) | **No** in v1 (below) |
| Clone repos at start | Environment repositories | **No**: needs Boat's own GitHub connection, which Dorks deliberately does not require |

### Why not Boat environments (for now)

Boat environments are the obvious native home for variables, and the owner asked to prefer native primitives, so this is the decision
most worth reviewing. Against them today:

1. **Upgrades.** A sandbox keeps the environment version it started with until someone calls `upgradeEnvironment`
   ([versions](https://docs.boat.dev/environments/versions)). Changing one variable would mean upgrading every dork's sandbox. Through
   `configure`, a dork gets the new value at its next wake, for free.
2. **On disk.** Boat writes environment variables into managed `~/.bashrc` blocks (the ones `--no-env` strips,
   [access](https://docs.boat.dev/environments/access)), so they land in every stop snapshot of the dork. `configure` puts them only in
   the agent process's environment.
3. **Isolation.** Claude dorks are created with `noEnv: true`, so Boat hands them nothing: no Boat GitHub token, no in-sandbox Boat key
   (which can save snapshots of its own sandbox), no agent logins. An environment relies on four toggles and a switch staying right;
   `checkCodexEnvironment` in `lib/boat.ts` shows what checking that takes.
4. **One slot.** A sandbox has one environment, and Codex dorks already use it for the ChatGPT sign-in.
5. **Two sources of truth.** N environments in the owner's Boat dashboard that they could also edit there, plus the `environment.write`
   key action, which the key does not need today.

Revisit when Claude's sign-in moves to a Boat environment (docs/boat.md already weighs that): at that point dorks carry an environment
anyway, and per-build environments with `passSecrets` only become cheap. The data model above maps 1:1 onto one (variables, secret
flags, repos with setup scripts), so moving is a driver change.

### A run, step by step

An extension of today's base-snapshot job (`services/snapshot.ts`): a `build:run:<runId>` timer, claimed at most once, recovered after a
crash as a new attempt, every Boat call idempotent. One run per build at a time; runs of different builds run one after another (start
limits are per account).

| Step | What happens |
|---|---|
| `prepare` | Delete leftover sandboxes of this build (recorded id, plus label `dorks-build=<hash of install id and build id>`). |
| `create` | `POST /sandboxes` `from` the base snapshot, `type` = the build's size, `noEnv: true`, the 2 h lifetime safety net, the label. |
| `start` | Wait for `ready`. |
| `clone` | Upload a one-shot credential helper and the GitHub token as `/tmp/dorks-build/gh` (0600), clone each repo to `/home/user/work/<owner>/<repo>` (where the bridge looks, `infra/bridge/src/git.ts`; it fetches and checks out over an existing clone), with clean `origin` URLs. Delete the token file and helper before the next step. The setup script never sees the token. |
| `setup` | Upload the script and, for an image run of an approved spec only, `/tmp/dorks-build/env` (0600) with the build-time variables. One **detached** command: `set -a; . env; set +a; rm env; bash -e setup.sh`, then each repo's script in its clone. The server attaches to the stream, appends redacted output to `log`, and stores `process_id`/`command_id`. Cap: 30 minutes (setting), then the run fails. |
| `scan` | Image runs: refuse to save if any build-time secret value or the GitHub token appears on disk (`grep -rlF` over `/home /root /etc /usr/local /opt /var/lib`), or if a clone's `.git/config` holds credentials. The run fails naming the file. `/tmp` is not in a saved snapshot, but it is cleared anyway. |
| `save` | Image runs: `POST /saved-snapshots`, poll until **our** save is `ready` (as today). |
| `finish` | Image runs: set `image`, `image_rev`, `image_hash`, `image_base`. Every run: delete the sandbox (`orphan:` retry job if Boat refuses). |

Trial runs stop after `setup` and delete the sandbox. They need no `snapshot.write` and add no saved snapshot.

The runs table is the build's status: the newest image run says whether the build is building or failed; `image` says what dorks start
from. A failed image run keeps the last good image in use, as the base snapshot does.

### Staleness and rebuilds

A build's image is **stale** when its spec changed (`image_hash != spec_hash`) or the base snapshot changed under it
(`image_base != current base bundle id`, so the bridge in the image is old). Nothing rebuilds by itself, because a run costs money:

- the build page shows "Rebuild" with the reason;
- "Update snapshot" for the base (Settings) offers "and rebuild N builds", queuing image runs for builds whose spec is approved;
- an agent may start an image run only for a spec the owner already approved (decision 7), so it can do the rebuild after a base update.

Repos are not a reason to rebuild: the bridge fetches at dork start. A clone weeks old is still a fast fetch.

### Cost

- One saved snapshot per build. Boat includes 10 per $20 of plan; each above that is $0.056 a day from the wallet
  ([pricing](https://docs.boat.dev/pricing)). The base snapshot counts as one. The builds page shows how many the app keeps.
- Sandbox time while a run runs, at the build's size (`default`: $0.036/h, so a 5-minute run costs about $0.003).
- Deleting a build deletes its saved snapshot (`DELETE /saved-snapshots/{name}`). Dorks on it keep their boxes; a dork whose box is lost
  is re-created from the base snapshot, with a transcript note.
- No new key actions: `snapshot.write` already covers save and delete, `exec` covers detached commands and the attach stream.

## Secrets

Follows AGENTS.md "Secrets" and the existing encrypted settings.

- Values are encrypted at rest (`build_vars.value_enc`, AES-GCM, additional data `build-var|<build id>|<name>`). The API returns names,
  flags and plain values only; secret values are write-only, like CLI secrets.
- **At dork runtime** `configure` sends shared variables plus the dork's build variables (build wins) plus the Claude token, in `env`, as
  today. Decrypted only there, only for a dork allowed to mint secrets (`mayMintSecrets`). An agent can read its own environment, as it
  can today; it never learns another build's values.
- **At build time** only variables marked `build_time` are exported to the setup script, only in image runs, and only when
  `spec_hash == approved_hash`. Trial runs get plain build-time variables only. The GitHub token is used by the `clone` step and is gone
  before the script runs.
- The `scan` step keeps a secret out of a saved image. Run logs are redacted before they are stored or given to a tool: every known
  secret value, and its base64, becomes `[redacted]` (the bridge's `redact.ts` approach). Boat's own command history is not redacted;
  it lives in the owner's Boat account, like everything else in their sandboxes.
- An agent can ask for a variable it needs (`var_requests`): the owner sees the name and the reason and types the value in the UI. A tool
  never takes a secret value as input, so a value never passes through a transcript.

## UI and API

Additive to [architecture.md](architecture.md). Same auth, error shapes and JSON conventions.

**BuildView**: `{ id, name, machineType, setupScript, repos: {repo, branch?, setupScript?}[], vars: {name, secret, buildTime, value?, requested}[],
rev, approved: boolean, image: {name, rev, at, stale, staleReason?} | null, lastRun: RunView | null, drafts: DraftView[], dorkCount, createdAt, updatedAt }`.
`value` is present only for plain variables. **RunView**: `{ id, kind, status, step, startedBy, error, exitCode, startedAt, finishedAt, logBytes }`.

| Method and path | Body / query | Result |
|---|---|---|
| `GET /api/builds` | | `BuildView[]`, by name |
| `POST /api/builds` | `{name, machineType?, setupScript?, repos?}` | `{id}`. Owner-written, so approved |
| `GET /api/builds/:id` | | `BuildView` |
| `PATCH /api/builds/:id` | any of `{name, machineType, setupScript, repos}` | `{}`. Bumps `rev` on a spec change; approves it |
| `DELETE /api/builds/:id` | | `{}`. Cancels a run, deletes the saved snapshot in the background |
| `PUT /api/builds/:id/vars/:name` | `{value?, secret, buildTime}` | `{}`. `value` omitted keeps the stored one (to flip a flag) |
| `DELETE /api/builds/:id/vars/:name` | | `{}` |
| `POST /api/builds/:id/runs` | `{kind: "image"\|"trial"}` | `202 {id}`. Error `conflict` while a run of this build is active, `not_configured` without a Boat key or base snapshot |
| `GET /api/builds/:id/runs` | | `RunView[]`, newest first |
| `GET /api/builds/:id/runs/:runId/log` | `?after=<byte offset>` | `{text, next, done}` from the stored, redacted tail |
| `POST /api/builds/:id/runs/:runId/cancel` | | `{}`. Kills the detached command, deletes the sandbox |
| `POST /api/builds/:id/drafts/:draftId/approve` | `{run?: boolean}` (default true) | `{}`. The draft's spec and plain vars become the build's, `approved_hash` is set, requested vars appear empty for the owner to fill, and an image run starts unless `run: false` |
| `POST /api/builds/:id/drafts/:draftId/reject` | `{reason?}` | `{}` |

Changed: `POST /api/dorks` takes `buildId?` (default `settings.defaultBuildId`, then the base snapshot); a build with no image yet is
`not_configured` (412, "This build has not been built yet"). `repo` becomes optional for a setup session (below). `Dork` gains
`buildId`, `buildName`. `GET/PUT /api/settings` gain `defaultBuildId`. Live: `{"t":"builds"}` (list changed) and
`{"t":"build","buildId"}` (one build, its runs or a log tail changed; coalesced to one per 500 ms per build).

Box creation (`lifecycle/jobs.ts` `boxInfo`): `snapshotId` is the dork's build `image` when it has one, else the base snapshot, and the
create passes the build's `type`. Existing boxes are untouched by rebuilds; a re-created box takes the current image.

**Screens** (layout and components per DESIGN.md; empty states per AGENTS.md):

- **Settings → Builds**: the list (name, size, status, dorks using it), "New build", and "Shared variables" (today's CLI secrets, moved
  here). Empty state: a hairline figure, "No builds yet", one line ("A build is a machine set up once: tools installed, variables set, repos
  cloned."), buttons "New build" and "Set up with an agent".
- **Build page** (`/builds/:id`): header with the name, status and "Build" / "Rebuild". Sections: Setup script (monospace editor),
  Repositories (repo picker, branch, optional script), Variables (name, value or write-only dots, Secret and "Needed while building"
  switches, "Requested by an agent" rows waiting for a value), Size, Runs (selecting one shows its live log), and Agent drafts (a diff
  against the build, the agent's note, the chat it came from, "Approve and build" / "Reject"). "Set up with an agent" opens a setup session.
- **New session composer**: a build picker next to the repo picker once a build exists; the build's repos are listed first in the repo
  picker.
- **Chat**: an agent's submitted draft shows as a card in the transcript with the same diff and buttons (client event `build_draft`);
  the owner's decision is a `build_decision` event and reaches the agent as a user turn.

## How dorks pick a build

- The composer's build picker, defaulting to `settings.defaultBuildId` (set from the build page: "Use for new sessions"), else the base.
- A dork keeps its build for life. Moving a dork to another build would mean re-creating its box (losing on-disk state); not in v1.
- **Setup session**: "Set up with an agent" on a build page creates a dork with `buildId` = that build, no repo required, and a first
  message the owner can edit ("Set up this machine for …"). It starts from the build's image if it has one, else from the base. It is a
  normal dork in every other way (sleep, transcript, Computer tab), so the agent can try commands live in its own box before it writes
  them into the draft.

Repo-less dorks: `configure.repo` becomes nullable; the bridge then starts the agent in its workdir without cloning. That is a small
protocol change in `packages/shared/src/bridge.ts` and `infra/bridge` (the Stop gate already scans whatever repos are under the workdir).

## Agent tooling

### Where it runs

Five tools added to the existing `dorks` MCP server (`infra/bridge/src/mcp.ts`), forwarded over the local RPC socket to the bridge and
over the bridge socket to the server, like `pr_*` and `preview_show`. The server resolves the build from the authenticated dork id, so a
tool can only ever reach the dork's own build (or, for a dork on the base, propose a new one). There is no build id argument to forge.

New bridge rpc ops: `build_get`, `build_draft`, `build_trial`, `build_run`, `build_logs`, `build_submit` (arguments as below). New local RPC
methods `build.*` in `Bridge.rpcMethods`. No new secret ever crosses the socket.

| Tool | What it does |
|---|---|
| `machine_get` | The dork's build: name, size, setup script, repos and their scripts, variables (plain values; secrets by name only), image status and staleness, the last run, and this dork's draft if any. On the base: says so and that `machine_draft` can propose a new build. |
| `machine_draft` | Writes this dork's draft: any of `setupScript` (full text), `repos` (full list), `machineType`, `plainVars` (name to value), `requestVars` (`[{name, secret, buildTime, why}]`), `name` (new build only). Validated like the API. Returns a short diff against the build. |
| `machine_run` | Runs the draft (default) or the build as it is. `kind: "trial"` always works within the caps below. `kind: "image"` only for a spec equal to the approved one (a rebuild); otherwise the error says to submit the draft. Returns the run id at once. |
| `machine_logs` | A run's status and its redacted log: `tail` lines (default 200), or `grep` a pattern, 64 KB at most. `wait` (up to 120 s) long-polls until the run ends, so the agent can wait without a sleep loop. |
| `machine_submit` | Submits the draft with a `note` for the owner's approval. Posts the draft card in the chat and on the build page. The decision comes back as a turn. |

The intended loop: try in its own box → `machine_draft` → `machine_run` (trial) → `machine_logs` → fix → … → `machine_submit` → owner
approves → image run → `machine_logs` until it succeeds. Done means the image run succeeded, which the tool descriptions say.

### Loaded only when needed

- Claude Code defers MCP tool schemas by default ([tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)): at
  session start only the tool **names** and the server's `instructions` load; a schema loads when the model searches for it. The bridge
  passes our server with `--mcp-config` and does not mark these tools `anthropic/alwaysLoad`, so they stay deferred.
- The server `instructions` gain one sentence: "To install tools, set variables or pre-clone repos for future sessions, search for the
  `machine_` tools." The how-to (the loop, the approval rule, the caps) lives in the tool descriptions, which load only on search.
- Nothing is added to `guidance.ts` or the SessionStart hook. The cost to a session that never touches a machine: five tool names and one
  sentence.
- Not chosen: a skill (its description is in context too, and it would be a second place for the same text), and a hidden tool set that
  appears after an "activate" call via `list_changed` (`-p` mode refreshes tools on it, but it adds a step and a stateful server for a
  saving of five names).

### Permissions and safety

- **Scope**: own build only, resolved server-side. Codex dorks get the same tools for free (the bridge already registers the `dorks`
  server with Codex), but only Claude is tested live (AGENTS.md).
- **No secret values**: tools never return one and never accept one. Logs are redacted. Trial runs have no secrets to leak.
- **No unapproved images**: an image run needs `spec_hash == approved_hash`. The owner approves a hash by editing the build or approving a
  draft; the approval card shows the full script diff, the size, and any build-time secret the script will receive.
- **Caps**: per dork, 10 trial runs a day; per build, 5 agent-started image runs a day; one active run per build. Exceeding is a tool error
  telling the agent to ask the owner. Constants first, settings if needed.
- **Machine size** is in the spec, so an agent cannot move a build to `xlarge` without approval.
- **Not chosen: saving the dork's own box as a build.** The in-sandbox Boat key that could do it is absent (`noEnv`), and on purpose: a
  working box holds transcripts, session state, half-done branches and possibly files with secrets. The agent turns what worked in its box
  into a script instead, which is also what makes the build reproducible.
- **Not chosen: tools that act on any machine.** One build per dork keeps prompt injection from a repo the agent reads limited to proposing
  changes to that dork's build, which the owner reviews.

## Build logs and failures

- Output streams from Boat's attach endpoint (one open stream, reopened at the `reconnect` line every 10 minutes with byte offsets). The
  server redacts, appends to `build_runs.log` (tail capped at 256 KB, `log_bytes` keeps the offset), and publishes `{"t":"build"}`. A
  restart re-attaches from `log_bytes`; if the process is gone, the run reads the final status from `GET /commands/{processId}`.
- Every failure becomes `status: failed` with an `error` written for the owner, as `boatBuildFailureMessage` does today: the step, the
  exit code and the last lines of output for a setup failure; Boat's reason for a create or save failure; the file for a scan hit.
- The sandbox is deleted on every outcome (`orphan:` retries). An owner who wants to debug a failure opens a setup session, which starts
  from the base or the last good image, rather than keeping a failed sandbox billing.
- For an agent, `machine_logs` returns the same text plus `error`, and a failed image run never touches the image in use.
- Simulated sandboxes (`BOX_PROVIDER=sim`) get a fake run with step pauses and a few log lines, so the whole flow works in `pnpm dev`.

## Migration from the single base snapshot

- Nothing moves by force. The base snapshot, "Prepare Boat", `baseSnapshotId`, `GET /api/snapshot` and staleness stay as they are.
- Existing dorks get `build_id = NULL`: they start, sleep and re-create from the base, as today.
- CLI secrets keep their table and API (`/api/secrets`) and become "Shared variables" in the UI. No data changes.
- `SnapshotDriver` (`core/snapshot.ts`) grows: `createBuildSandbox` takes `from` and `type`; new `runDetached`, `attach`, `commandStatus`,
  `killCommand`, `deleteSnapshot`. `lib/boatSnapshots.ts` implements them; the sim provider fakes them.
- Docs to keep in step: architecture.md (API, live messages, bridge ops), boat.md (cost, builds), infra/snapshot/README.md (builds are
  layered on it), infra/bridge/README.md (the tools, nullable repo), env.md if any env var is added (none planned).

## Tests (few, per AGENTS.md)

- The run job on the fake driver: supersede and crash recovery, sandbox always deleted, a failed image run keeps the old image.
- The approval gate: an agent's image run of an unapproved spec is refused; build-time secrets reach image runs of approved specs only,
  never trial runs; the scan refuses a save with a secret on disk.
- One bridge test: a `machine_*` tool call reaches the rpc and an error comes back as a tool error.
- Live, once: a small real build on Boat (one tool, one variable, one public repo), a Claude dork on it, then delete the dork, the build
  and its saved snapshot.

## Open questions for the owner

1. **Boat environments vs `configure`** for variables (decision 3). Recommended: `configure` now, revisit with Claude's sign-in.
2. **Secret files** (`.env`): needed in v1? Through `configure` the bridge would write them into the clone (0600, owned by the agent user),
   which puts them on the dork's disk and its stop snapshots. Boat environments do the same with their secret files.
3. **Per-repo scripts at dork start**: rerun a repo's script after the bridge's fetch and checkout (dependencies may have moved since the
   build)? Recommended: no, the agent installs what it needs; revisit if dorks keep doing it first thing.
4. **Agent rebuilds of approved specs** without asking (decision 7): fine, or should every image run need a click?
5. **Caps**: 10 trials per dork per day, 5 agent image runs per build per day, 30-minute setup cap. Right numbers?
6. **Run-finished notification**: today the agent waits with `machine_logs wait`. Once the autonomy work in progress lands, a run end
   could arrive as a `notify` turn instead. Kept out of v1 to avoid touching `notify.ts` and `autonomy.ts` while that work is open.
7. **Periodic refresh**: rebuild approved builds weekly so clones and caches stay warm? Recommended: no, until someone feels it.
