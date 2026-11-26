# Architecture: local-first server

Status: accepted. This replaces `apps/convex` with `apps/server`. There are no users, so this is a hard cut with no data migration.

## Decision

Dorks runs as a **local server on the owner's machine** (a single compiled binary, started as a sidecar by the desktop app, or by hand). It owns a SQLite database, the lifecycle state machine, a durable timer queue, the Boat driver and a GitHub poller. The server dials *out* to each awake sandbox's **bridge** over a WebSocket (the box provider's hosted URL for the bridge port), so the owner's machine opens no inbound port and needs no public URL; the UI talks to it over loopback HTTP.

### Why not keep Convex

Convex gave us live queries, a durable scheduler, transactions and a WebSocket the bridge connects out over. For a local, single-owner product it costs more than it gives:

- **Convex would have to be public.** With Convex the bridge must reach the backend from Boat's cloud, so the backend needs a public URL, and Convex serves everything (UI queries, mutations, admin) on one origin, so exposing it exposes all of it. Our own server dials each box's bridge instead, so it exposes nothing, and the bridge socket speaks one narrow, mutually authenticated protocol.
- **Deploy toolchain and licence.** Running functions locally needs the self-hosted `convex-backend` binary (FSL licence), a CLI plus bundler to deploy functions, admin-key handling and env sync. That is a lot of moving parts to ship inside a desktop app.
- **No local-first sync story.** Convex is the database; there is nothing to replicate to or from a cloud later.
- **What we actually used is small.** Three live queries, a scheduler used as a timer table, and single-document transactions. SQLite with a single writer gives the same atomicity (`BEGIN IMMEDIATE`), a `timers` table gives durable timers, and a Server-Sent-Events invalidation stream gives live UI updates.

The pure logic carries over unchanged: the lifecycle reducer (`packages/core/src/machine.ts`), the stream normalizer, AES-GCM envelope, the Boat driver, the bridge HMAC, the notification renderer and the shared wire types in `packages/shared`.

### Sync later

The per-dork `events` table is append-only with a dense `seq`. That is the replication unit: a later cloud sync can ship `events` (and settings) by `(dork_id, seq)` without redesigning the model.

## Shape

```
 desktop app (Tauri) ── spawns ──► apps/server  (one binary, Bun)
   UI (static SPA) ──HTTP+SSE──►  UI listener   127.0.0.1:<ui port>     owner-token auth
                                  bridge links  ──WS, dials out──► Boat hosted URL ──► dorks-bridge 127.0.0.1:4748 (each awake box)
                                      │
                                      ├─ SQLite (WAL)       <data dir>/dorks.db
                                      ├─ lifecycle driver   one SQLite transaction per input
                                      ├─ timers             durable table + in-process scheduler
                                      ├─ box jobs           Boat driver, outside transactions
                                      └─ GitHub poller      ETag polling with a stored token
```

Runtime: Bun (`bun:sqlite`, `Bun.serve`), compiled with `bun build --compile` into one sidecar binary per target. The code under `apps/server/src` is runtime-neutral except `main.ts`: the SQLite adapter picks `bun:sqlite` under Bun and `node:sqlite` under Node 24, so the unit tests run under Vitest (`vp test`) on Node against the real code and an in-memory database.

### Process model and atomicity

- All state changes are **synchronous functions over one SQLite connection**, wrapped in `BEGIN IMMEDIATE ... COMMIT`. A thrown error rolls back everything (this is how a rejected message to an archived dork also un-persists its outbox row).
- Anything async (Boat calls, GitHub calls, HMAC verification, decryption) happens **outside** transactions and reports back through a transactional function carrying the box-operation generation (`op_gen`), exactly as before, so a stale result from a superseded operation is ignored.
- Effects that must survive a crash are rows in `timers`: `owner` (a dork id or `""`), `name`, `due_at`, `payload`. Jobs (work that calls a provider, so it cannot run in a transaction) are timers too: `box:create:<gen>`, `box:resume:<gen>`, `box:pause:<gen>` (one row per operation generation, so a superseded operation still runs and its stale result is ignored), `box:destroy`, `orphan:<boxId>`, `stall:<subscriptionId>` and the global `poll`. A timer is claimed by deleting its row in the transaction that starts running it (at-most-once, like Convex scheduled functions; every provider call is idempotent). On boot the scheduler reloads the table, so due timers fire immediately.
- After the outermost commit, the transaction's change set is published to live listeners (SSE clients and connected bridge sessions). A rollback discards it.

## Configuration

Environment (all optional except where noted); a desktop shell sets these when it spawns the sidecar.

| Variable | Default | Purpose |
|---|---|---|
| `DORKS_DATA_DIR` | `~/Library/Application Support/Dorks` (macOS), `$XDG_DATA_HOME/dorks` | Holds `dorks.db` and `secrets.json` |
| `DORKS_UI_PORT` | `4747` (`0` = random) | UI listener, bound to `127.0.0.1` |
| `DORKS_OWNER_TOKEN` | generated | Bearer token for the UI API. Generated once into `secrets.json` if unset |
| `DORKS_UI_ORIGINS` | tauri + localhost:3000 | Comma-separated browser origins allowed by CORS |
| `BOX_PROVIDER` | `boat` | `boat`, or `sim` for the local simulator and tests |
| `SIM_HOST_KEY` | none | Required when `BOX_PROVIDER=sim`; guards `GET /sim/boxes` (header `x-sim-host-key`), which `infra/bridge-sim/host.mjs` polls to start and stop fake sandboxes |
| `DORKS_PARENT_PID` | none | The supervising process (the desktop shell sets it). The server shuts down gracefully within a few seconds of that process disappearing |
| `SIM_LATENCY_MS` | `700` | Sim only: how long a simulated sandbox takes to stop or start, so the polling host always notices |
| `SIM_BUILD_STEP_MS` | `400` | Sim only: pause per step of the simulated base-snapshot build, so progress is visible |
| `DORKS_BRIDGE_BUNDLE` | none | Development: path of a bridge bundle to build snapshots from instead of the embedded one (see "Base snapshot") |
| `DORKS_DEBUG_BRIDGE` | none | Logs bridge frame names and sizes to stderr; never `configure` results or secrets |

`secrets.json` (mode 600) holds `bridgeSecretKey` (HMAC key for per-dork bridge secrets), `encryptionKey` (AES-GCM, base64 32 bytes) and `ownerToken`, generated on first run. The Boat API key, Claude token and CLI secrets are **settings** stored encrypted in SQLite (GitHub is the GitHub CLI's login, read live and never stored: [GitHub](github.md)), so the UI can change them without touching the environment.

On startup the server prints one JSON line to stdout for a supervisor: `{"ready":true,"ui":"http://127.0.0.1:4747","bridge":"ws://127.0.0.1:4748/bridge"}`. `GET /api/health` answers `{"ok":true}` without auth.

## UI API (loopback HTTP)

Auth: `Authorization: Bearer <owner token>` (SSE also accepts `?access_token=`, since `EventSource` cannot set headers). Bodies and responses are JSON. Errors are `{"error": AppError}` (see `packages/shared/src/errors.ts`) with a matching HTTP status (`invalid` 400, `forbidden` 401, `not_found` 404, `conflict`/`archived`/`deleting` 409, `limit` 429, `not_configured`/`onboarding_incomplete` 412, other 500).

IDs are UUID strings. Times are epoch milliseconds.

**Dork** (the client-visible row; box ids, session ids and secrets are never returned):
`{ id, title, repo, branch, provider: "claude"|"codex"|"opencode"|"antigravity", state, archived, preview?, previews: {port, url, title?}[], prUrl?, codexModel?, codexModelChoices?, model?, effort?, agentModel?, agentEffort?, modelChoices?, buildId, kind, parentId, icon?, lastActivityAt, createdAt }`
`state` is one of `creating | working | idle | sleeping | waking | error`. For Claude, `model`/`effort` are the session's choice (absent: the CLI's default), `agentModel`/`agentEffort` what the agent confirmed it runs (the model from its `system/init` event, the effort the bridge started it with; cleared on a change until confirmed again), and `modelChoices` the `AgentModelChoice[]` the CLI offered this account (its `initialize` answer). `previews` are the dev servers the agent showed (`show_preview` below), oldest first, at most 20; Chat details' Artifacts shows them as running previews and opens one as it appears. The URLs are public hosted ports (no token), cleared when the box is replaced. `mode` is `chat`, `code` or `nerd` ([modes](modes.md); a nerd plans and runs worker dorks), `parentId` the coordinator that started a worker, else null: [crews](crew.md). `GET /api/dorks/:id` also returns `queue: {id, text, createdAt}[]`, the messages queued for when the current turn ends, oldest first, and `commands: AgentCommand[]`, the slash commands and skills the agent last offered (the list leaves both out).

| Method and path | Body / query | Result |
|---|---|---|
| `GET /api/dorks` | `?archived=true` | `Dork[]`, newest activity first, at most 200 |
| `GET /api/dorks/:id` | | `Dork` or 404 |
| `POST /api/dorks` | `{repo, message, title?, provider?, model?, effort?, buildId?, setup?, mode?, icon?}` (only `mode: "code"`, the default, needs `repo`, [modes](modes.md); `provider` defaults to `claude`; Codex needs a configured Boat environment; Claude's `model`/`effort` must be in `settings.claudeModels`; Codex's `model` is a `gpt-…` id with an optional `effort` (`low` to `xhigh`, default `high`), stored as the session's `codexModel`; `buildId` defaults to `settings.defaultBuildId`, and needs a built image unless `setup: true`, a machine-setup session that also needs no `repo`: [builds](builds.md)) | `{id}` |
| `PATCH /api/dorks/:id` | `{title}` | `{}` |
| `DELETE /api/dorks/:id` | | `{}` (box is destroyed in the background, then rows are purged) |
| `POST /api/dorks/:id/messages` | `{text}` | `{}`. While the agent works the message steers the running turn (Claude reads it at its next tool call); otherwise it starts a turn |
| `POST /api/dorks/:id/queue` | `{text}` | `{queued}`. While a turn runs (`creating`, `waking`, `working`) the message waits in the dork's `queue`; each queued message goes out as its own turn when the current one ends, oldest first (the machine's `release_queue`). A Stop holds the queue until a turn ends again. With no turn running it is sent at once (`queued: false`). At most 20 |
| `DELETE /api/dorks/:id/queue/:queuedId` | | `{}`: removes a queued message |
| `POST /api/dorks/:id/queue/:queuedId/send` | | `{}`: sends a queued message now instead, steering the running turn |
| `POST /api/dorks/:id/interrupt` | | `{}` |
| `POST /api/dorks/:id/desktop` | `{theme?: "light"\|"dark"}` | `{url}`: a fresh live view of the dork's computer for an iframe ([computer use](computer-use.md)). Never stored or logged; minted per view because Boat's URL must be opened within 10 minutes. Error `sleeping` (409) unless the dork is `working` or `idle` (this never wakes it), `timeout` (504) while the stream is still starting. Under the sim it is a path to a stand-in page, `GET /sim/desktop` |
| `POST /api/dorks/:id/read` | none | `{}`; the owner read the chat. A dork is `unread: true` from the end of a turn (working → idle) until this or the owner's next message, on every device |
| `POST /api/dorks/:id/archive` | `{archived: boolean}` | `{}` |
| `POST /api/dorks/:id/mode` | `{mode: "chat"\|"code"\|"nerd"}` | `{}`. Switches the session's [mode](modes.md); while the sandbox is up the bridge restarts the agent on the same session with the new mode once the current turn ends. `invalid` for a worker, `conflict` for a nerd with live workers |
| `POST /api/dorks/:id/model` | `{model: string\|null, effort: string\|null}` | `{}`. A model and effort from `modelChoices` (null: the default). Codex's pair is stored as `codexModel`; before a Codex session has reported the plan's list any well-formed id is taken. While the sandbox is up the bridge restarts the agent on the same session (Claude `--resume`, Codex `thread/resume`) once the current turn ends; asleep, the next wake uses it |
| `POST /api/dorks/:id/codex-model` | `{model, effort}` | `{}`. Restarts a Codex session paused because its model was not on the plan, on one of `codexModelChoices` |
| `GET /api/dorks/:id/files` | `?q=&limit=<1..100, default 50>` | `{files: string[], listed, truncated}`: the repository paths that best match `q` (`rankFiles`, `packages/shared/src/mentions.ts`), from the last listing the bridge sent; `listed` is false until it has sent one. The composer's `@` menu ("Mentions" below) |
| `GET /api/dorks/:id/workspace` | | `{roots: WorkspaceRoot[]}` (`packages/shared/src/workspace.ts`): the git checkouts in the sandbox's work directory, the session's own first ("Files" below). Error `sleeping` (409) unless the dork is `working` or `idle` and its bridge is connected (this never wakes it), `timeout` (504) when the bridge does not answer |
| `GET /api/dorks/:id/workspace/tree` | `?root=` | `WorkspaceTree`: a checkout's files (tracked and untracked, not ignored, at most 20000) and their git status |
| `GET /api/dorks/:id/workspace/file` | `?root=&path=` | `WorkspaceFile`: the text and SHA-256 of a file, or only its size when it is binary or over 1 MB |
| `PUT /api/dorks/:id/workspace/file` | `{root, path, contents, sha?}` | `{sha, size}`: replaces an existing file's text. With `sha` (the version it was edited from) a file changed meanwhile is refused with `conflict` (409); without, it is overwritten |
| `GET /api/dorks/:id/events` | `?before=<seq>&limit=<1..200, default 50>` or `?after=<seq>` | `{events: ClientEvent[], hasMore}`. `before` (or neither) returns newest first; `after` returns ascending, inclusive of `seq > after` |
| `GET /api/dorks/:id/pr?url=` | | `PullRequestView`: one of the session's PRs read live from GitHub as the gh login (state, mergeability, checks, files with patches, comments). `url` picks it (its headline PR or any PR it has a subscription to, ended ones included); without it, the headline (the latest it opened). 404 for any other PR or without one |
| `POST /api/dorks/:id/pr/merge` | `{method: "squash"\|"merge"\|"rebase", sha?, url?}` | `{merged, sha}`; `sha` pins the reviewed head (409 `conflict` if it moved, or GitHub refuses: conflicts, required checks or reviews) |
| `POST /api/dorks/:id/pr/ready` | `{url?}` | `{}`: marks a draft pull request ready for review (GitHub GraphQL `markPullRequestReadyForReview`); an already ready PR answers `{}`, a closed one 409 `conflict` |
| `POST /api/dorks/:id/pr/update-branch` | `{sha?, url?}` | `{}` (merges the base branch into the PR's branch) |
| `GET /api/dorks/:id/subscriptions` | | `SubscriptionView[]`: live ones, plus ended ones the session opened itself or that were merged or closed (the session's PR history); the bridge gets live ones only |
| `POST /api/dorks/:id/subscriptions` | `{repo, number}` | `{}` (user subscribe; un-stalls and resets the CI budget) |
| `DELETE /api/dorks/:id/subscriptions` | `{repo, number}` | `{}` |
| `POST /api/dorks/:id/subscriptions/resume` | `{repo, number}` | `{}` |
| `GET /api/dorks/:id/comments` | | `CommentView[]` (`packages/shared/src/comments.ts`), oldest first: the owner's comment threads on the session's running previews and the agent's replies ("Preview comments" below) |
| `POST /api/dorks/:id/comments` | `{body, anchor, port}` | `{id}`: a new thread on the preview at `port`, pointing at `anchor` (an element or a passage of text). The agent hears about it as a `notify` turn |
| `POST /api/dorks/:id/comments/:cid/replies` | `{body}` | `{id}`: the owner's reply; it opens a resolved thread again and reaches the agent like a new comment |
| `PATCH /api/dorks/:id/comments/:cid` | `{body?, resolved?}` | `{}`: edits the owner's own comment, or resolves / reopens a thread (its first comment) |
| `DELETE /api/dorks/:id/comments/:cid` | | `{}`: deletes the owner's own comment (a thread's first comment takes its replies with it) |
| `POST /api/dorks/:id/inputs/:requestId` | `{values}` or `{dismiss: true}` | `{}`: the owner's answer to an agent's request for values it uses without reading them ([secure inputs](secure-inputs.md)). Values are stored encrypted and reach only the session's bridge; no response or event carries one |
| `GET /api/settings` | | `{claudeToken, boatKey, github: {configured, login?}, boatOrg, boatEnvironment, baseSnapshotId, sleepMinutes, commentPolicy, claudeCodeMode, boxProvider, claudeModels, defaultBuildId}`: booleans and plain values only, never secrets. `claudeModels` is the model list a Claude agent last reported (empty before the first session), what a new session can choose from |
| `PUT /api/settings` | any subset of `{boatKey, boatOrg, claudeToken, githubConnected, boatEnvironment, baseSnapshotId, sleepMinutes, commentPolicy, claudeCodeMode}` | `{}`. `claudeCodeMode` (default true) starts new Claude sessions in Code Mode; a dork keeps the value it was created with. Token fields are write-only; an empty string clears one. Provider values are checked before anything is saved: `boatKey`/`boatOrg` with the same check as `POST /api/boat/check`, `boatEnvironment` against Boat's environment list, `githubConnected: true` reads the GitHub CLI's login and checks it with GitHub `GET /user` (a missing or signed-out `gh` is refused too); a refusal is `invalid` (400) with Boat's or GitHub's reason in plain words, and an unreachable provider does not block the save. Saving a non-empty `boatKey` with no base snapshot (in Settings or `BASE_SNAPSHOT_ID`) queues the base-snapshot build; so does the next start, if the process stopped in between. A failed build is never retried by itself |
| `GET /api/github/repos` | `?fresh=1` reads `gh` and GitHub again | `{login, orgs, repos, auth: {state, source, missingScopes}}`: the GitHub CLI login's user (null when not connected), its organizations' logins, and the non-archived `owner/name` repositories it can see (300 most recently pushed, then a page of each organization's). `auth.state` is `ok`, `not_connected`, `gh_missing`, `gh_logged_out`, `rejected` or `unreachable`; `missingScopes` names any of `repo`, `read:org`, `workflow` the token lacks. Cached for two minutes, dropped on connect and disconnect; a problem answers empty lists. Feeds the repository picker and the sidebar's owner switcher |
| `POST /api/boat/check` | `{boatKey?, boatOrg?}` (the saved ones when omitted) | `{status: "ok"\|"invalid"\|"needs_org"\|"credit_required"\|"unreachable", message}`: asks Boat's `GET /limits` with that key (a free trial or `canStart: false` is `credit_required`), or `GET /sandboxes?limit=1` when the key lacks `account.read`; nothing is saved. Error `not_configured` (412) with no key at all |
| `GET /api/snapshot` | | the base-snapshot build status, see "Base snapshot" |
| `POST /api/snapshot/build` | `{force?: boolean}` | `202` and the same status. Starts "Prepare Boat" unless a build is running, or the snapshot is already built from this app's bridge and in use (and `force` is not set). Error `not_configured` (412) without a Boat key |
| `GET /api/secrets` | | sorted names `string[]` |
| `PUT /api/secrets/:name` | `{value}` | `{}` (`^[A-Z][A-Z0-9_]{0,63}$`, 16 KB max) |
| `DELETE /api/secrets/:name` | | `{}` |
| `GET /api/mcp-servers` | | `McpServerView[]` sorted by name: `{name, transport, url, command, args, headerNames, envNames, oauth, createdAt}`, never header or env values |
| `PUT /api/mcp-servers/:name` | `{transport: "http", url, headers?}` or `{transport: "stdio", command, args?, env?}` | `{oauth}`: `signed_out` when the server asks for a sign-in. Adds or replaces; a `null` header/env value keeps the saved one. Restarts awake Claude agents once their turn ends. See [MCP servers](mcp.md) |
| `DELETE /api/mcp-servers/:name` | | `{}` |
| `POST /api/mcp-servers/:name/oauth` | `{base}` | `{url}`: the sign-in page of a server that asks for OAuth; the browser comes back to `GET /oauth/mcp/callback` (no token). See [MCP servers](mcp.md#oauth) |
| `DELETE /api/mcp-servers/:name/oauth` | | `{}`. Signs out: forgets the tokens |
| `GET /api/skills` | | `SkillView[]` sorted by name: `{name, description, source: {repo, ref, path}, sha, url, fileCount, bytes, installedAt, updatedAt}`. See [skills](skills.md) |
| `POST /api/skills/resolve` | `{source}` | `SkillResolution`: `{repo, ref, sha, skills: {name, description, path, fileCount, bytes, installed}[], requested}`. `source` is what the owner pasted: `owner/repo`, a github.com URL or an `npx skills add` command. Reads GitHub as the gh login; nothing is saved |
| `POST /api/skills` | `{source, skills: string[]}` | `{installed}`. Downloads the source again and saves the named skills (all of them when it holds one); a skill of the same name is replaced. Awake Claude agents sync without a restart |
| `POST /api/skills/:name/update` | | `{updated}`: downloads the skill again from its repository and ref |
| `DELETE /api/skills/:name` | | `{}` |
| `GET /api/composio` | | `{connected, toolkits}`: whether a Composio key is saved, and the apps signed in through it. See [MCP servers](mcp.md) |
| `PUT /api/composio` | `{apiKey}` | `{}`. Checks the key with a Composio session and saves it as the `composio` server |
| `DELETE /api/composio` | | `{}`. Removes the key and the `composio` server |
| `POST /api/composio/toolkits/:toolkit/link` | | `{url}`: a Composio sign-in page for one app |
| `DELETE /api/composio/toolkits/:toolkit` | | `{}`. Signs that app out |
| `GET/POST /api/builds`, `GET/PATCH/DELETE /api/builds/:id`, `PUT /api/builds/:id/default`, `PUT/DELETE /api/builds/:id/vars/:name`, `GET/POST /api/builds/:id/runs`, `GET /api/builds/:id/runs/:runId/log`, `POST /api/builds/:id/runs/:runId/cancel`, `POST /api/builds/:id/drafts/:draftId/approve\|reject` | | Builds: named machine setups, see [builds](builds.md) ("UI and API") |
| `GET/POST /api/automations`, `GET/PATCH/DELETE /api/automations/:id`, `GET/POST /api/automations/:id/runs` | | Automations: instructions an agent runs on a schedule or on repository events, each run a session; see [automations](automations.md) |
| `POST /api/dorks/:id/local/:requestId`, `GET/PUT /api/local-access`, `DELETE /api/local-access/sessions[?dork=]` | | The owner's answer to a session's request to use this computer, the on/off switch and the sessions allowed: [local access](local-access.md) |
| `GET /api/health` | no auth | `{ok: true}` |
| `POST /mcp` | JSON-RPC (MCP, Streamable HTTP, plain JSON answers) | The dorks MCP server for the owner's other agents: `dork_*`, `build_*`, `repo_list`. Owner bearer token; a browser `Origin` outside `DORKS_UI_ORIGINS` is 403; `GET`/`DELETE` are 405. See [crews](crew.md) |

`ClientEvent` and `SubscriptionView` are the zod types in `packages/shared`. A `ship` event carries the whole `ShipView` of a merged PR's ship each time it changes; clients keep the latest per `ship.id` ([shipping](shipping.md)). A `turn_complete` carries `outcome` (`done`, `stopped` after the user's Stop, `failed`) and, for a `done` turn, `finalMessageId`: the turn's final answer, the last assistant message with no tool call after it, named by the server from the agent's stream. Clients show the final answer and fold the rest of the turn behind a checkpoint, "Worked for 2m 14s" (`durationMs`), that opens the turn's whole history; they never infer the final answer from position. Turns stored before these fields existed have neither. Every agent session is told this (`infra/bridge/src/guidance.ts`, as Claude's `--append-system-prompt` and Codex's `developerInstructions`), so it writes a self-contained final answer. The event log is append-only; a growing assistant message keeps **one** row whose text grows in place (same `seq`), so a client that tails must re-read from its last known `seq` inclusive.

### Live updates: `GET /api/live` (Server-Sent Events)

One stream per client. Messages are `data: <json>\n\n`; a `: ping` comment every 20 s keeps proxies open. They are **invalidations**, not payloads: refetch the thing named.

| Message | Meaning |
|---|---|
| `{"t":"hello","now":<ms>}` | sent on connect; refetch everything you show |
| `{"t":"dorks"}` | the dork list changed (rows, order or archive state) |
| `{"t":"dork","dorkId"}` | one dork's row changed |
| `{"t":"events","dorkId","seq"}` | the transcript tail is now `seq`; refetch `events?after=<your last seq - 1>` (coalesced to at most one message per 50 ms per dork) |
| `{"t":"subscriptions","dorkId"}` | PR subscriptions changed |
| `{"t":"settings"}` | settings or secret names changed |
| `{"t":"snapshot"}` | the base-snapshot build changed (a step, a result); refetch `GET /api/snapshot` |
| `{"t":"builds"}` | the build list changed; refetch `GET /api/builds` |
| `{"t":"build","buildId"}` | one build, its runs, drafts or a run's log changed; refetch it, its runs and an open log |
| `{"t":"automations"}` | an automation, its runs or a watched repository changed; refetch the automations and run histories you show |

`packages/client` wraps this (`useDorks`, `useDork`, `useDorkEvents`, `useSettings`), replacing `@dorks/convex/client` and `convex/react`.

### Live updates for cloud orgs (s2)

A Teams or Cloud org with no Mac in it runs on the dorks-cloud Worker, which holds no stream open (handlemotion/dorks-cloud `docs/realtime.md`). The app picks it in `apps/web/src/lib/place.ts` (`runsOnWorker`) and points the client at `<home>/api/cloud/orgs/:id`: the home server forwards `api/*` to the Worker's `/v1/orgs/:id/api/*` (REST, unchanged) and `realtime/*` to `/v1/realtime/orgs/:id/*`. With `cloud` set, `@dorks/client` (`cloud-live.ts`, `s2.ts`) reads s2 instead of `/api/live`:

- **Org feed** (`POST realtime/live-token`): the same messages as `/api/live`, a local `hello` when the read opens and again after a failure.
- **An open transcript** (`POST realtime/sessions/:id/read-token`): the session's `events` stream carries the `ClientEvent`s themselves. The first follow checks the tail, reads the newest page over REST, then reads s2 from that tail; later follows resume after the last record seen. Reads resume after every drop from the last `seq_num`, reconnect before the 10-minute token expires and at least every 10 minutes with a fresh token, send the stream's `s2-encryption-key`, and join events split into parts.

`pnpm dev:mock` lists such an org when `MOCK_ORG_RUNTIME` names a dorks-cloud Worker, an org on it and a member's token (`packages/client/src/mock-cloud.ts`).

## Bridge protocol (WebSocket, dialed by the server)

**Where the bridge listens.** In the box the bridge listens on `127.0.0.1:BRIDGE_PORT` (`4748`). The box is created with exactly `DORK_ID`, `BRIDGE_PORT` and `BRIDGE_SECRET` in its environment. Frames are JSON text.

**Endpoint.** `BoxProvider.bridgeEndpoint(boxId)` (`packages/core/src/box.ts`) gives the URL and headers to dial. For Boat (`packages/core/src/boat.ts`) it is `POST /sandboxes/<id>/host` with `{port: 4748, public: false, localhost: true, title: "Dorks bridge"}`; Boat answers a protected URL `https://<sub>-4748.on.boat.dev?_token=…`, and the server dials `wss://<sub>-4748.on.boat.dev/` with `Cookie: _port_auth=<token>`. The token is a bearer credential: never stored or logged. Port 4748 is reserved, so `preview_show` refuses it. The simulator gives each sim box its own loopback port (`sim_boxes.bridge_port`, `bridgePort` in `/sim/boxes`) and the server dials `ws://127.0.0.1:<port>/`.

**Links** (`http/bridgeLinks.ts`). Every 500 ms the server reconciles the dorks that have a `box_id`, are not deleting and are `creating`, `waking`, `working` or `idle`, and keeps one socket per dork. A dropped or refused socket is dialed again with backoff from 0.5 s to 10 s; after every 5 failed dials in a row it asks the provider for the endpoint again. A socket silent for 100 s is dropped and redialed (the bridge heartbeats every 30 s). On its side the bridge's listener pings every 30 s and terminates sockets that miss a pong.

**Handshake.** Each side proves it holds the per-dork secret, `secret = HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)` hex, without sending it (`packages/shared/src/bridgeProof.ts`):

1. On open the server sends `{"t":"hello","nonce":Ns}` (32 random bytes, hex).
2. The bridge answers `{"t":"auth","dorkId","nonce":Nb,"proof"}` with `proof = HMAC-SHA256(secret, "bridge|" + Ns + "|" + Nb)` hex.
3. The server checks that `dorkId` is the dork it dialed, the proof, and that the dork exists and is not deleting; otherwise, or with no first frame within 5 s, it closes with 4403.
4. The server sends `{"t":"auth_ok","proof"}` with `proof = HMAC-SHA256(secret, "server|" + Nb + "|" + Ns)`; the bridge checks it and closes with 1008 if it is wrong.

The bridge closes a socket that has not finished the handshake within 10 s and takes at most 4 handshakes at once (more are closed with 1013). A newly verified socket replaces the old one, which is closed with 4000. Nothing is served to an unauthenticated socket.

**Calls** (server to bridge, the Files tab): `{"t":"call","id":<n>,"op":"fs.roots"|"fs.tree"|"fs.read"|"fs.write","args":{...}}`, answered by `{"t":"ret","id":<n>,"ok":true,"result":...}` or `{"t":"ret","id":<n>,"ok":false,"error":{code,message}}` (`invalid`, `not_found`, `conflict`, else `failed`) on the same socket. A bridge older than calls ignores them and the server's call times out.

**Requests** (bridge to server): `{"t":"rpc","id":<n>,"op":"<op>","args":{...}}`. **Responses**: `{"t":"res","id":<n>,"ok":true,"result":...}` or `{"t":"res","id":<n>,"ok":false,"error":AppError}`.

| op | args | result |
|---|---|---|
| `connect` | | `{afterBridgeSeq}`. Error `sleeping` if the dork is asleep (a bridge must not wake anything). Marks the bridge seen and queues a `configure` command |
| `heartbeat` | | `{}`. Bridge liveness; back after a blip while `working`/`idle` re-arms the machine |
| `push` | `{frames: FromBridge[]}` (at most 500 frames, 256 KB per event) | `{ok:true}` or `{ok:false,expectedBseq}` when the batch has a gap. A gap applies nothing: the bridge resends from `expectedBseq`. Events numbered `<=` the stored `bridge_seq` are replays and skipped. Errors `too_many_frames`, `event_too_large` |
| `configure` | | the `configure` `ToBridge` frame (Claude token, shared and build variables, GitHub token, repo or `null` for a setup session, resume session) or `null` if refused. **The only place secrets are decrypted**; they exist only in this response, never stored in a command row |
| `gh_token` | | `{token}` or `null` (the GitHub CLI's current token; kept so the bridge's refresh path keeps working, the server no longer queues `gh_token` commands) |
| `subscribe_pr` | `{repo, number, source: "auto"\|"agent"}` | `{}` (idempotent) |
| `unsubscribe_pr` | `{repo, number}` | `{}` |
| `build` | `{action: "get"\|"draft"\|"run"\|"logs"\|"submit", ...}` | The agent's `machine_*` MCP tools ([builds](builds.md), "Agent tooling"), scoped to this dork's build. Never returns a secret value |
| `local` | `{action: "request"\|"wait", ...}` | The agent's `local_run`/`local_read`/`local_wait` tools: ask to run a command or read a file on the owner's computer, and wait for the answer and the result. Nothing runs unless the owner allowed the session (or every session): [local access](local-access.md) |
| `crew` | `{tool, args}` | A coordinator's or worker's crew tools ([crews](crew.md)), the same table as `POST /mcp`, scoped to the dork's crew: a coordinator reaches only its workers, a worker only its coordinator and siblings. A plain dork is `forbidden`. One `dork_wait` waits at most 8 s |
| `mcp_token` | `{name, stale?}` | `{authorization, expiresAt}`: a current access token for an OAuth MCP server, refreshed when about to expire or when `stale` (the token the server just refused) is still the saved one. Errors `not_configured` (not signed in, or the grant is gone) |
| `skill` | `{name}` | `{name, digest, files: {path, data (base64), exec?}[]}`: one of the owner's skills, fetched when `configure` lists a digest the box does not have ([skills](skills.md)) |
| `show_preview` | `{port, title?, localhost?, via?}` | `{port, url, title?}`. The agent's `preview_show` MCP tool (bridge RPC `preview.show`). The box provider hosts the port (Boat `POST /host`, public; see [Boat](boat.md#hosted-ports)) and the URL is stored in the dork's `previews` (one per port, the newest replaces). `via` is the bridge's preview proxy in front of `port` (below, "Preview proxy"): the provider then hosts `via`, on loopback, and the preview is still listed under `port`; an older bridge sends none and its port is hosted directly. Errors `invalid` (bad or reserved port), `sleeping` (no box), `not_configured`, `failed` |
| `comment` | `{action: "list" \| "reply" \| "resolve", id?, body?, all?}` | The comment_* MCP tools ("Preview comments"): `list` answers `{text}`, the open threads (all with `all`) as the agent reads them; `reply` and `resolve` write as the agent. Errors `invalid`, `not_found` |
| `ship` | `{action: "verify", repo, number, ok, note}` | `{text}`. The agent's `ship_verify` MCP tool: its check of a merged PR's live deployment, recorded on the session's ship that waits for one ([shipping](shipping.md), "The agent"). Errors `invalid`, `not_found` (no ship waiting) |

### Agents

Every agent speaks Claude Code's stream-json to the server; the other adapters translate (`infra/bridge/src/codex.ts`, `opencode.ts`,
`antigravity.ts`). Codex runs as `codex app-server` (JSON-RPC on stdio), one thread per dork:

| | Claude Code | Codex |
|---|---|---|
| Steering | a mid-turn message is read at the next tool call | `turn/steer` into the running turn (a turn that ended as it was sent gets the message as the next turn) |
| Queue, notifications | the server's queue and `notify` go out at turn boundaries | the same |
| Done gates (verify, ship, brevity) | `Stop` hook | the bridge calls `hook.stop` on `turn/completed`; the judge is the plan's lightest model on an ephemeral thread |
| PR follow-up | `PostToolUse` hook | every finished `commandExecution` |
| Briefing | `SessionStart` hook | a `<system-reminder>` input item on the first turn after a start, resume or compaction |
| Instructions | `--append-system-prompt` / `--system-prompt` | the thread's `developerInstructions` (final answer, skills, crew role, computer, or a chat's prompt) |
| MCP servers | `--mcp-config` | `dorks` on `-c`, the owner's as `thread/start` config; Boat's `computer` from `~/.codex/config.toml` |
| Skills | `~/.claude/skills` | the same folder as a skills root; `/skill` messages invoke one |
| Images | image blocks | `image` inputs (data URLs) |
| Tool calls | as they are | mapped onto Claude's names (`Bash`, `Edit`/`Write` with the diff, `WebSearch`, `mcp__server__tool`, the plan as `TodoWrite`) |
| Secure inputs | `PreToolUse` fills a secure-input reference in a tool's input ([secure inputs](secure-inputs.md)) | not available: Codex cannot rewrite a tool's input from outside |

### Cloud sessions (`S2Transport`)

A box of a cloud org (Teams, Cloud) runs the same bridge with `DORKS_TRANSPORT=s2` and `DORKS_WORKER_URL`: nothing dials it, and it listens on no port. It appends the session's transcript to s2 and tails its commands there, and calls the stateless Worker (handlemotion/dorks-cloud, `docs/org-runtime.md` and `docs/realtime.md`) over HTTPS for the rest (`infra/bridge/src/s2/`). Every call is `POST <worker>/v1/bridge/<dorkId>/<op>` with `authorization: DorksBridge <ts>.<proof>`, `proof = HMAC-SHA256(secret, "bridge|" + ts + "|" + METHOD + " " + path + " " + sha256hex(body))` (`httpProof`/`checkHttpProof` in `packages/shared/src/bridgeProof.ts`, 60 s of clock skew). Refusals are AppError bodies; `forbidden` stops the bridge, `sleeping` exits it.

| op | body | answer |
|---|---|---|
| `connect` | `{}` | `{basin, basinUrl?, streams: {events, commands}, token, tokenExpiresAt, fence, encryptionKey}`: fences `events` with a fresh token (the previous bridge's appends then get 412 and it exits), issues an s2 token for the session's prefix (append, read, check-tail; 1 h) and appends a `fetch_configure` command, as the server's `connect` queues one. The bridge's `afterBridgeSeq` is the last bseq in the stream |
| `token` | `{}` | `{token, expiresAt}`: a fresh s2 token, asked for 5 minutes before expiry and whenever s2 refuses one |
| `state` | `{frames}` | `{}`. The `push` frames other than events (`ready`, `ack`, `agent_exited`, `flushed`, `title`, `agent_models`, ...) plus what the server derives from the stream: `{t: "session", sessionId, model?}`, `turn_started`, `turn_idle`, `{t: "preview", text}`. Sent after the events before them are durable. `{frames: []}` is the heartbeat |
| `rpc` | `{op, args}` | `{result}`: the ops and shapes of the table above (`configure`, `gh_token`, `subscribe_pr`, `skill`, ...) |

The bridge normalizes the agent's lines into client events itself (`@dorks/core/normalize`, plus the turn's `finalMessageId` and `stopped` as `services/bridge.ts` stamps them) and appends them as s2 records in the layout of dorks-cloud's `src/realtime/records.ts` (fenced, `match_seq_num`, exactly once; `infra/bridge/src/s2/records.ts` documents the headers). A `commands` record's id is the cid (for messages also the frame's `id`) and its body a `CommandFrame`, `{t: "call", id, op, args}` (answered by a `ret` record in `events`) or `{t: "subscriptions", views}`. The bridge acks a command by appending its echo to `events`, the commit point; acks may come out of order, so every record carries the cursor (`c`, the first unacked command) and the cids acked past it (`a`). A restarted bridge delivers again what was not acked and skips duplicate cids. `pnpm --filter @dorks/bridge test s2` covers this against an in-memory s2; `test/s2-live.test.ts` runs the built bridge on a real s2 basin with real Claude, including two `kill -9`s.

### Mentions

The composer offers a menu above the box (`apps/web/src/components/ComposerMenu.tsx`): `/` as a message's first word lists the agent's skills and commands, `@` after a space (or at the start) searches the repository's files. Picking one writes `/name ` or `@path ` into the text; nothing else changes about the message, and the agent reads both as it would in a terminal.

- **Commands** come from Claude Code's `initialize` answer (`commands`: name, description, argument hint; skills included, their source at the end of the description, `(user)` or `(project)`). The bridge relays them as `agent_commands` and the server keeps them on the dork (`agent_commands`). Before a session has reported any, and for a new session, the menu lists the owner's installed skills. Other agents get no `/` menu.
- **Files**: the bridge lists the working tree with `git ls-files --cached --others --exclude-standard` when the agent starts and every 15 s (`infra/bridge/src/files.ts`), and sends `files` only when the listing changed, at most 5000 paths in 180 KB (`truncated` past that). The server keeps the last listing per dork (`dork_files`), so the menu works while the box sleeps, and answers searches with `GET /api/dorks/:id/files`.

### Files

Chat details' **Files** tab (`apps/web/src/components/chat-details/Files.tsx`) browses and edits the repositories checked out in the sandbox: Pierre's editor (`@pierre/diffs`, `File` in an edit session) on the left, Pierre's file tree (`@pierre/trees`) on the right under a chooser of the checkouts. Nothing is stored on the server; each read is a `call` to the bridge (`infra/bridge/src/workspace.ts`, `services/workspace.ts`), only while the sandbox is awake.

- **Checkouts**: every git repository in the work directory, at its top or one or two levels down (`owner/name`, where the bridge clones the session's repository and a build's), so one the agent cloned beside it shows too. Each is named after its GitHub `origin`, with its branch.
- **Paths** are checked by shape (`validWorkspacePath`: relative, no `..`, nothing in `.git`) on the server and the bridge, then resolved through symlinks by the bridge, which refuses anything outside the checkout or in a `.git`. Only existing files are written, in place, so their owner and mode stay the agent user's.
- **Saves** carry the SHA-256 of the version that was opened; when the agent changed the file meanwhile the save is a `conflict`, and the tab offers Reload or Overwrite. The tree is listed again every 15 s while the tab shows.

### Preview proxy

A preview is not hosted straight from the agent's dev server. On `preview.show` the bridge starts a small reverse proxy for that port (`infra/bridge/src/preview-proxy.ts`), on `127.0.0.1` and a free port, and sends that port as `via`. The proxy:

- adds `<script src="/__dorks/overlay.js">` early in the `<head>` of every HTML page loaded as a document or frame (those requests drop `Accept-Encoding`, so the page comes back uncompressed). The overlay (`infra/bridge/overlay/overlay.ts`, React Grab's primitives, bundled into the bridge by `scripts/build.mjs`) does nothing unless the page is framed. Framed, it runs the element picker inside the page and answers its parent window over `postMessage` (the protocol is at the top of `overlay.ts`: picking elements and text, comment anchor positions, area capture, the page's path). That is how Chat details' preview picker (`apps/web/src/components/PreviewBrowser.tsx`) works on a page from another origin;
- drops `X-Frame-Options` and CSP `frame-ancestors`, so the page loads in the app's frame;
- makes each request look local: `Host` is `localhost:<port>`, an `Origin` or `Referer` on the public host is rewritten to it, `X-Forwarded-*` and `Forwarded` are dropped, and a redirect to the dev server's own origin is made relative. Dev servers that check hosts or origins (Vite's `allowedHosts`, Next's dev origins and server actions) then need no setting;
- passes WebSocket upgrades (HMR) through with the same header rewrite, and every other request and response unchanged. With nothing on the port it answers 502 with a short page.

The proxies' ports are kept in `<state dir>/previews.json`: a hosted URL survives a pause, but every process stops, so the bridge listens on the same ports again when it starts. If a proxy cannot start, the bridge hosts the port directly, as before (no picker).

**Pushes** (server to bridge): `{"t":"commands","cmds":[{cid, frame: CommandFrame}]}` is the **snapshot of unacknowledged commands** and is re-sent whenever it changes (and once right after `auth_ok`). Delivery is idempotent: the bridge dedupes by `cid`/message id and acknowledges with a `push` `ack` frame, which removes the command. This gives resume-after-reconnect for free: after a drop the bridge re-auths, calls `connect` (learning `afterBridgeSeq`, the event cursor, so it replays events above it) and receives the current snapshot. `{"t":"subscriptions","views":SubscriptionView[]}` is sent likewise for the bridge's PR cache.

`push` frames, `ToBridge`, `FromBridge` and `CommandFrame` are the zod types in `packages/shared/src/bridge.ts`. The server does not queue `gh_token` commands. For Claude, `configure` carries `model`/`effort` when chosen; the bridge sends the CLI an `initialize` control request and relays its model list as an `agent_models` frame (`{models: AgentModelChoice[], effort}`), and passes the `model` of `system/init` through. `configure` lists the owner's skills as `skills: {name, digest}[]`; the bridge writes changed ones into `~/.claude/skills` before it starts the agent, and a change to them alone never restarts it ([skills](skills.md)). On a build with services, `configure` carries them as `services: BuildService[]`, what the agent's `service_start` can start ([services](services.md)). A `configure` whose model or effort changed restarts the CLI on the same session after the current turn. Codex authenticates only through a Boat environment (there is no per-box sign-in); `codex_issue` becomes an error event, `agent_models` carries the plan's models with their efforts (as for Claude), and `codex_models` lists the usable ones when the chosen model is not on the plan. While a dork's title is still its first message (`title_source = 'message'`), `configure` carries that message as `nameFrom`: the bridge asks a light model beside the agent (Haiku through `claude -p`, or a `luna`/mini Codex model on a side thread) for a 5–7 word name and sends a `title` frame; the server applies it only over the placeholder, never over a name the user typed.

The `Transport` interface in `infra/bridge/src/transport.ts` is unchanged; `WsTransport` implements it over this protocol. It takes an acceptor (the loopback listener, `infra/bridge/src/listen.ts`) instead of a URL, and an rpc waits up to 15 s for the server to connect before it fails.


### Preview comments

The owner comments on a running preview in Chat details (`PreviewBrowser`): on an element, or on a passage of text; or on one of the session's images in the lightbox (`ImageLightbox`, `ImageComments.tsx`): on a point or an area of it. Dorks keeps the threads (`preview_comments`, `apps/server/src/services/comments.ts`); the agent answers in them.

- **Anchors** come from the preview overlay: the page path, React Grab's selector for the element, its tag, and the component and source file when the page is a dev build; a text comment adds the quoted words and up to 32 characters before and after them, so the overlay can find the passage again after a reload or an edit; an area comment is a rectangle in document pixels plus its screenshot (an uploaded image the comment claims for the dork; the notification carries it as `![…](dorks-image:<id>)`, which the bridge turns into the image in the agent's turn). The app draws a bubble on each commented element and highlights each passage, from the positions the overlay reports (`marks`). An image comment's anchor (`kind: "image"`) is the image's id and its spot in fractions of the image (0 to 1 from the top-left, plus a width and height for an area), with no `port`; the image must be the dork's, and the notification carries it as `![…](dorks-image:<id>)` like an area's screenshot.
- **Delivery** reuses the autonomy path (docs/autonomy.md): each comment or reply of the owner's waits (`notified = 0`) for the `comments_notify` timer (5 s from the first, not sliding), which folds them into one `notify` command, `<dorks-event source="preview">`, held mid-turn like any notification, with a transcript card (`notify` event, `source: "preview"`). Every agent gets it the same way.
- **Answers**: the MCP tools `comment_list`, `comment_reply` and `comment_resolve` (bridge op `comment`, `{action: "list" | "reply" | "resolve", id?, body?, all?}`). The agent's replies wake nothing. The owner can reopen a thread or write in it again, which reaches the agent as a reply.
- **Live**: every change publishes `{t: "comments", dorkId}` on `/api/live`.

Nothing in the preview writes to the chat's composer: every tool ends in a comment. The toolbar also shows rulers: the overlay follows the pointer (`track`) and reports the element under it.

## Base snapshot ("Prepare Boat")

Every sandbox is created from a saved snapshot in the user's own Boat account (snapshots are per account), and the app builds it in one click instead of the manual `boat` steps in `docs/boat.md`. Code: `services/snapshot.ts` (the job), `core/snapshot.ts` (the provider seam), `lib/boatSnapshots.ts` (Boat), `snapshot/assets.ts` (what goes in).

`GET /api/snapshot` returns `{state: "none"|"building"|"ready"|"failed", snapshot, managed, stale, step, stepIndex, stepCount, message, error, startedAt, finishedAt, builtBundleId, currentBundleId, canBuild, cannotBuildReason}`:

- `snapshot` is the saved snapshot this app last built (`dorks-base-<8 hex of the install id>`, per installation so two installs on one Boat account never replace each other's image). `managed` is true when `settings.baseSnapshotId` is that snapshot; a name entered by hand (for example a `bsh_` share code) is never judged stale.
- `stale` means it was built from an older installer (`infra/snapshot/boat-install.sh`) than this app now carries; `POST /api/snapshot/build` rebuilds it (no `force` needed). `bundleId` is the first 12 hex of sha256(installer). A newer bridge alone does not make it stale: a box whose `dorks-bridge` differs from the server's gets the server's installed when it starts.
- `state: "failed"` keeps `snapshot` (the last good one) and leaves `baseSnapshotId` alone: dorks keep starting from it. `error` is a message written for the user; for an installer failure it ends with the last lines of its output.
- Steps, in order: `prepare` (delete earlier build sandboxes: the recorded one and any with this install's `dorks-build` label), `create` (no account credentials, a 2 h lifetime as a safety net), `start`, `upload` (bridge bundle as base64, installer as text, then a sha256 check), `install` (`boat-install.sh`, 10 minute cap), `save` (Boat's saved-snapshot API, polled until OUR sandbox's save is `ready`; re-saving a name replaces the old artifact only once the new one is ready), `finish` (set `baseSnapshotId`). The build sandbox is deleted on every outcome; if Boat refuses, an `orphan:<id>` job retries.
- The job is a `snapshot:build` timer; a crash leaves the row `running` and the next start queues it again as a new attempt (`recoverSnapshotBuild`).
- The bridge bundle and the installer are embedded in the compiled sidecar (`snapshot/embedded.bun.ts`, resolved by `bun build --compile`; `scripts/build.ts` builds the bridge first). From source they are read from `infra/`.
- `BOX_PROVIDER=sim` swaps in an in-memory provider (`SIM_BUILD_STEP_MS`), so the whole flow runs without Boat.

Boat API used (https://docs.boat.dev): `POST|GET /sandboxes`, `GET|DELETE /sandboxes/{id}`, `PUT /sandboxes/{id}/files`, `POST /sandboxes/{id}/commands`, `POST /saved-snapshots`, `GET /saved-snapshots/{name}`.

## Builds

Optional, named machine setups layered on the base snapshot: a build's image is a Boat saved snapshot made by a run job
(`services/buildRuns.ts`, timers `build:run:<id>` and `build:forget:<image>`), a dork on a build starts from that image at the build's
size, and the build's variables reach it through `configure`. Agents propose changes through the `build` bridge op; only the owner
applies them. The full design: [builds](builds.md).

## Lifecycle

`packages/core/src/machine.ts` is unchanged apart from dropping the GitHub-token-refresh effects. Dispatch applies an input in one transaction: persist the new state, append a `status` event, then run effects (arm/cancel timers, enqueue box jobs, release held notifications, enqueue `interrupt`). Pausing keeps the same intent-with-generation model (`flushing` → `pausing` → `cancelled`). Timers: `sleep`, `watchdog`, `bridge_watch`, `flush`, `notify`, `pause_retry`. Global jobs (owner `''`): `poll`, `sweep`, `snapshot:build`, `orphan:<boxId>`, `build:run:<runId>`, `build:forget:<image>`, `automation:<id>` (an automation's schedules) and `automation-watch` (the repository watcher, [automations](automations.md)).

## GitHub (autonomy)

No GitHub App and no webhooks. One **token**, the GitHub CLI's (`gh auth token`, read live and never stored, [GitHub](github.md)), is handed to the sandbox in `configure` and used by the server's poller. Every 10 s (when any subscription is active) the poller reads each subscribed PR with conditional requests (`If-None-Match`; a 304 is free against the rate limit): the PR (head, base, state, mergeability), its reviews, its conversation and review comments since the last cursor, and the check suites of the head. It turns differences into the same normalized events the webhook path produced (`pr_closed`, `pr_synchronize`, `pr_base_changed`, `review`, `comment`, `check_suite`, mergeability) and feeds them through the same routing, CI-attempt budget, debounce inbox and `notify` rendering as before. Polling catches up after the machine sleeps, which webhooks cannot.

Identity: the dork acts as whoever owns the token. Events authored by the token's own login are ignored (they are the agent's own), so use a dedicated bot account's token if you also want your comments on the PR to wake the dork; otherwise talk to it in the chat.

## Security model

- UI listener: loopback only, bearer owner token, CORS limited to configured origins.
- Bridge: the server dials out; nothing on the owner's machine listens for sandboxes. In the box the bridge listens on loopback only, reachable through the provider's protected hosted URL (Boat's per-port token). Authentication is the mutual per-dork HMAC handshake; secrets are returned only over an authenticated socket and never persisted in command rows.
- At rest: Boat key, Claude token and CLI secrets are AES-GCM encrypted (the GitHub token is not stored: it stays in `gh`) (`packages/core/src/crypto.ts`, additional data binds each to its purpose); `secrets.json` is mode 600.

## Build and test

```sh
pnpm --filter @dorks/server test         # vp test (Vitest) on Node 24 (node:sqlite), in-memory database, fake clock and sandbox provider
pnpm --filter @dorks/server typecheck
pnpm --filter @dorks/server build        # bun build --compile -> apps/server/dist/dorks-server-<target triple> (+ dorks-server for the host); `--all` for both macOS targets
node apps/server/scripts/e2e.mjs         # a real server process (SERVER_BIN=<binary> for the compiled one) with the simulated sandbox host
BRIDGE_IMPL=real node apps/server/scripts/e2e.mjs   # same, with the real in-box bridge and a fake Claude CLI
```

The compiled sidecar is about 64 MB (arm64) / 70 MB (x64): that is the Bun runtime plus the bundled code. The binary needs no files next to it; the database and `secrets.json` live in `DORKS_DATA_DIR`.

## Out of scope here

The Tauri shell (`docs/desktop.md`). The web client lives in `packages/client` and `apps/web`; `apps/convex` has been removed.
