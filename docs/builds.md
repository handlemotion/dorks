# Builds

Status: **accepted and implemented**. Code: `apps/server/src/services/builds.ts` (definition, variables, drafts), `buildRuns.ts` (the run job), `buildAgent.ts` (the agent's op), `infra/bridge/src/mcp.ts` (`machine_*` tools), `apps/web/src/routes/_conn/_app/builds.tsx` (the page).

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
| 7 | **No image from a spec the owner has not seen, and no secret value in a script the owner has not seen.** Every spec has a hash. Saving an image and injecting build-time secrets both require the owner to have approved that hash (an owner edit approves itself; an agent's draft is approved by the owner's click). Trial runs (no save, no secrets) do not. |
| 8 | **"Set up a machine" is an ordinary dork**, opened from a build's page (`POST /api/dorks {setup: true, buildId}`): no repo required, and the build needs no image yet (it starts from the base). It is not a special environment: the tools in decision 6 are the same in every dork on a build, so a dork working on a repo can also say "I installed X; add it to the build?" A dork on the base machine cannot draft: the owner creates a build first. |
| 9 | **Tools load on demand.** Claude Code defers MCP tool schemas by default (tool search): only tool names and a one-sentence server instruction reach every session. No change to the base prompt (`infra/bridge/src/guidance.ts`) or SessionStart context. |
| 10 | **Logs come from Boat.** A run's setup is one detached Boat command; the server follows its output stream and keeps a capped, redacted tail. Boat keeps the full log for 90 days in command history. |

## Concepts

- **Build**: the definition (name, machine size, setup script, repos, variables). Edited by the owner, or by an agent through a draft.
- **Spec**: the parts of a build that change the image: setup script, repos and their scripts, machine size, and the *names* of the
  variables marked "needed while building". `spec_hash = sha256` of their canonical JSON; it is what the owner approves.
- **Build-time values**: the values of those variables. Not in the spec (a secret must not end up in an approval hash), but tracked for
  staleness through a keyed hash (HMAC with the server's key), so changing a version pin the setup reads marks the image out of date.
- **Image**: the build's saved snapshot in the owner's Boat account, `dorks-b-<8 hex install id>-<8 hex build id>`. One per build;
  rebuilding saves the same name, which Boat replaces only once the new save is `ready` (as the base snapshot does today).
- **Run**: one execution of a spec. `image` runs save the image; `trial` runs do the same steps in a throwaway sandbox and save nothing.
- **Draft**: an agent's proposed spec and variable changes for its dork's build, one per (build, dork).

## Data model

Migration 7 (`apps/server/src/migrations.ts`):

| Table | Holds |
|---|---|
| `builds` | `name` (unique), `machine_type` (`small`/`default`/`large`/`xlarge`), `setup_script`, `repos` (JSON `[{repo, branch?, setupScript?}]`, at most 10), `rev` (bumped on a spec change), `spec_hash`, `approved_hash`, and the image: `image` (saved snapshot name), `image_hash` (the spec it was built from), `image_base` (the base snapshot and bridge bundle it was layered on), `image_vars` (keyed hash of the build-time values), `image_at` |
| `build_vars` | `(build_id, name)`, `value_enc` (AES-GCM, additional data `build-var\|<build>\|<name>`; NULL: asked for by an agent, waiting for the owner), `secret`, `build_time` |
| `build_runs` | `kind` (`image`/`trial`), the `spec` it runs and its hash, `started_by` (`owner` or `dork:<id>`), `status` (`queued`/`running`/`succeeded`/`failed`/`cancelled`), `step`, `error` (written for a person), `attempt`, Boat ids (`sandbox_id`, `process_id`, `command_id`), `exit_code`, `log` (redacted tail, 256 KB) and `log_bytes` |
| `build_drafts` | `(build_id, dork_id)` unique, `base_rev`, `spec`, `vars` (DraftVar[]: `{name, secret, buildTime, value?, why, remove?}`; a secret never has a value), `note`, `status` (`editing`/`submitted`/`approved`/`rejected`) |
| `dorks.build_id` | the build the dork's machine starts from; NULL: the base snapshot. `ON DELETE SET NULL` |
| `settings.default_build_id` | the build new sessions start on |

Wire types: `packages/shared/src/builds.ts` (`BuildView`, `RunView`, `DraftView`, `BuildSpec`, `draftVar`).

The existing `secrets` table (CLI secrets) stays: those are **shared variables**, given to every dork on any build. A build variable with
the same name wins.

Limits: 50 builds, 100 variables per build, 16 KB per value (as today), 64 KB per script; the API lists the last 20 runs of a build
(Boat keeps every command's log for 90 days).

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
- An agent can ask for a variable it needs (a draft variable with `secret: true` and a reason): the owner sees the name and the reason and
  types the value in the UI. A draft refuses a secret with a value, so a value never passes through a transcript.

## UI and API

Additive to [architecture.md](architecture.md). Same auth, error shapes and JSON conventions.

`BuildView`, `RunView` and `DraftView` are in `packages/shared/src/builds.ts`. A `BuildView` carries plain variable values only; a
secret is a name and flags. `image` is `{name, at, stale, staleReason}` or null.

| Method and path | Body / query | Result |
|---|---|---|
| `GET /api/builds` | | `BuildView[]`, by name |
| `POST /api/builds` | `{name, machineType?, setupScript?, repos?}` | `201 {id}`. Owner-written, so approved |
| `GET /api/builds/:id` | | `BuildView` |
| `PATCH /api/builds/:id` | any of `{name, machineType, setupScript, repos}` | `{}`. Bumps `rev` on a spec change; approves it |
| `DELETE /api/builds/:id` | | `{}`. Cancels its runs, deletes the saved snapshot in the background (`build:forget:<image>` job) |
| `PUT /api/builds/:id/default` | `{default?: false}` | `{}`. Makes it (or, with `default: false`, stops it being) the build new sessions start on. Needs an image |
| `PUT /api/builds/:id/vars/:name` | `{value?, secret?, buildTime?}` | `{}`. `value` omitted keeps the stored one (to flip a flag). Approves the change |
| `DELETE /api/builds/:id/vars/:name` | | `{}` |
| `POST /api/builds/:id/runs` | `{kind: "image"\|"trial"}` | `202 RunView`. Errors: `conflict` while this build has a run, `not_configured` without a Boat key or base snapshot, or when a value needed while building is missing |
| `GET /api/builds/:id/runs` | | `RunView[]`, newest first, at most 20 |
| `GET /api/builds/:id/runs/:runId/log` | `?after=<byte offset>` | `{text, next, done, run}` from the stored, redacted tail |
| `POST /api/builds/:id/runs/:runId/cancel` | | `{}`. The job kills the command and deletes the sandbox at its next step |
| `POST /api/builds/:id/drafts/:draftId/approve` | `{run?: boolean}` (default true) | `{run: RunView \| null, missing: string[]}`. The draft's spec and variable changes become the build's (approved); requested variables appear empty for the owner to fill in; an image run starts unless `run: false` or a value needed while building is `missing` |
| `POST /api/builds/:id/drafts/:draftId/reject` | `{reason?}` | `{}` |

Changed: `POST /api/dorks` takes `buildId?` (default `settings.defaultBuildId` when it is built, then the base snapshot) and `setup?`. A
build with no image is `not_configured` (412) unless `setup: true`; a setup session needs `buildId` and may omit `repo`. `Dork` gains
`buildId`. `GET /api/settings` gains `defaultBuildId`. Live: `{"t":"builds"}` (the list changed) and `{"t":"build","buildId"}` (one build,
its runs or a log tail changed). Bridge op `build` (`{action: get|draft|run|logs|submit, ...}`), below.

Box creation (`lifecycle/jobs.ts` `boxInfo`): `snapshotId` is the dork's build `image` when it has one, else the base snapshot, and the
create passes the build's `type`. Existing boxes are untouched by rebuilds; a re-created box takes the current image.

**Screens** (layout and components per DESIGN.md; empty states per AGENTS.md):

- **Builds** (the sidebar's Builds page, `/builds`): the list (name, Default, status, "a change to review"), and "New build". Empty state:
  the stack figure, "No builds yet", one line ("A build is a machine set up once: tools installed, variables set, repositories cloned."),
  "New build".
- **A build** (`/builds?build=<id>`): the header has "Set up with an agent" and "Build" / "Rebuild". Groups, as on Settings: Status (where
  it stands, why it is out of date, what is missing, Cancel, "Use for new sessions"), each agent change to review (before and after, the
  variable changes, the note, the chat it came from, "Approve and build" / "Reject" with an optional reason), Setup script, Repositories,
  Variables (Secret and "Needed while building"; "Fill in" for requested ones), Size, Runs ("Try the setup", the runs, the selected one's
  live log), Name and removal.
- **Settings**: "CLI secrets" is now "Shared variables": they reach every session, on any machine; a build's variable of the same name wins.
- **New session composer**: a machine menu beside the repository once a build is built (the default build preselected, "Base machine"
  always offered); the build's repositories come first in the repository picker.
- **Chat**: an agent's submitted draft is a card in the transcript ("Proposed a change to the machine web. Waiting for you.", the note,
  "Review the change"); the owner's decision updates the card and reaches the agent as its next turn.

## How dorks pick a build

- The composer's machine menu, defaulting to `settings.defaultBuildId` (set on the build's page: "Use for new sessions"), else the base.
- A dork keeps its build for life. Moving a dork to another build would mean re-creating its box (losing on-disk state); not in v1.
- **Setup session**: "Set up with an agent" on a build's page creates a dork with `buildId` = that build, `setup: true`, no repo, and a
  first message asking the agent to set the machine up with the `machine_` tools. It starts from the build's image if it has one, else
  from the base. It is a normal dork in every other way (sleep, transcript, Computer tab), so the agent can try commands live in its own
  box before it writes them into the draft.
- **Fresh code on an old image**: a repo baked into an image can be weeks old. The bridge fetches at start, and a new dork branch starts
  from the freshly fetched upstream of the checked-out branch (`@{upstream}`), not from the commit the image was built at. An existing
  dork branch is never reset (`infra/bridge/src/git.ts`).

Repo-less dorks: `configure.repo` is nullable (`packages/shared/src/bridge.ts`); the bridge then starts the agent in its work directory
without cloning, with the same git credential helper, so the agent can still clone and push (the Stop gate already scans whatever repos
are under the work directory). `dorks.repo` is stored as `""`.

## Agent tooling

### Where it runs

Five tools added to the existing `dorks` MCP server (`infra/bridge/src/mcp.ts`), forwarded over the local RPC socket to the bridge and
over the bridge socket to the server, like `pr_*` and `preview_show`. The server resolves the build from the authenticated dork id, so a
tool can only ever reach the dork's own build. There is no build id argument to forge.

One bridge op, `build` (`{action: "get" | "draft" | "run" | "logs" | "submit", ...}`, `apps/server/src/services/buildAgent.ts`), and one
local RPC method, `build`, that forwards it. No secret ever crosses the socket.

| Tool | What it does |
|---|---|
| `machine_get` | The dork's build: name, size, setup script, repos and their scripts, variables (plain values; secrets by name only), image status and staleness, the last run, and this dork's draft if any. On the base machine it says so and that the owner has to create a build first. |
| `machine_draft` | Writes this dork's draft: any of `setupScript` (full text), `repos` (full list), `machineType`, `vars` (changes merged by name: `{name, value?, secret?, buildTime?, why?, remove?}`; a secret with a value is refused). Validated like the API. Returns the draft. |
| `machine_run` | `kind: "trial"` (default) runs the draft (or the build as it is) without saving or secrets, within the caps below. `kind: "image"` rebuilds the approved spec, never the draft. Returns the run id at once. |
| `machine_logs` | A run's status and its redacted log: `tail` lines (default 200), or lines containing `grep` (a plain substring: a regular expression from the agent would run on the server), 64 KB at most. `wait` (up to 120 s) polls in short calls until the run ends, so the agent waits without a sleep loop. |
| `machine_submit` | Submits the draft with a `note` for the owner's approval: a card in the chat and on the build's page. The decision comes back as a turn. |

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
  draft; the build's page shows the change against the build (script, repos, size) and every variable change, with the agent's reasons.
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
  server redacts whole lines (so a secret split across two chunks is still caught), appends to `build_runs.log` (tail capped at 256 KB,
  `log_bytes` counts everything written), and publishes `{"t":"build"}`. A server restart re-queues a queued or running run as a new
  attempt, which deletes the old sandbox first: a run never resumes half-way.
- Every failure becomes `status: failed` with an `error` written for the owner, as `boatBuildFailureMessage` does today: the step, the
  exit code and the last lines of output for a setup failure; Boat's reason for a create or save failure; the file for a scan hit.
- The sandbox is deleted on every outcome (`orphan:` retries). An owner who wants to debug a failure opens a setup session, which starts
  from the base or the last good image, rather than keeping a failed sandbox billing.
- For an agent, `machine_logs` returns the same text plus `error`, and a failed image run never touches the image in use.
- Simulated sandboxes (`BOX_PROVIDER=sim`) run a fake setup with step pauses (`SIM_BUILD_STEP_MS`), so the whole flow works in `pnpm dev`.

## Migration from the single base snapshot

- Nothing moves by force. The base snapshot, "Prepare Boat", `baseSnapshotId`, `GET /api/snapshot` and staleness stay as they are.
- Existing dorks get `build_id = NULL`: they start, sleep and re-create from the base, as today.
- CLI secrets keep their table and API (`/api/secrets`) and become "Shared variables" in the UI. No data changes.
- `SnapshotDriver` (`core/snapshot.ts`) grew: `createBuildSandbox` takes `from`, `type` and a label key; new `runDetached`, `attach`,
  `killCommand`, `deleteSnapshot`. `lib/boatSnapshots.ts` implements them; the simulator echoes the uploaded scripts' lines as output, and
  a line that is `false` or `exit <n>` fails the run, so failures can be tried in `pnpm dev`.
- No new environment variable and no new Boat key action.

## Tests (few, per AGENTS.md)

- `apps/server/test/builds.test.ts`: an image run starts from the base at the build's size, clones without leaving the token, saves and
  deletes its sandbox, and a failed rebuild keeps the image; build-time secrets reach image runs only, trials get plain values, logs are
  redacted, a secret on disk refuses the save, and a changed build-time value (not a runtime one) marks the image stale; an agent edits
  only a draft, its trial runs the draft, its image run builds the approved spec, and the owner's approval applies the draft and tells it.
- `infra/bridge/test/mcp.test.ts`: the `machine_*` tools forward to the bridge's `build` method and a refusal is a tool error.

## Decided after review

The owner approved the recommendations: variables through `configure` (not Boat environments), no secret files in v1, per-repo scripts
at build time only, agents may rebuild an approved spec, and the caps above. From the spec review:

- A setup session can start on a build that has no image yet (`setup: true`).
- A dork on the base machine cannot draft a new build: the owner creates the build, then starts a setup session on it.
- Build-time values count for staleness, through a keyed hash, without putting a secret in the approval hash.
- A new dork branch starts from the fetched upstream, so a clone baked into an image never starts work on old code.

## Still open

1. **Secret files** (`.env`): not in v1. Through `configure` the bridge would write them into the clone (0600, owned by the agent user),
   which puts them on the dork's disk and its stop snapshots; Boat environments do the same with their secret files.
2. **Run-finished notification**: today the agent waits with `machine_logs wait`. Once the autonomy work in progress lands, a run end could
   arrive as a `notify` turn instead.
3. **Boat environments**: revisit when Claude's sign-in moves to a Boat environment (above).
