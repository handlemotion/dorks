# Architecture: local-first server

Status: accepted. This replaces `apps/convex` with `apps/server`. There are no users, so this is a hard cut with no data migration.

## Decision

Dorks runs as a **local server on the owner's machine** (a single compiled binary, started as a sidecar by the desktop app, or by hand). It owns a SQLite database, the lifecycle state machine, a durable timer queue, the Boat driver and a GitHub poller. The agent's in-sandbox **bridge** connects *out* to it over a WebSocket through a tunnel; the UI talks to it over loopback HTTP.

### Why not keep Convex

Convex gave us live queries, a durable scheduler, transactions and a WebSocket the bridge connects out over. For a local, single-owner product it costs more than it gives:

- **The tunnel would publish the whole Convex API.** The bridge must reach the backend from Boat's cloud, so the backend needs a public URL. Convex serves everything (UI queries, mutations, admin) on one origin, so a tunnel to it exposes all of it. With our own server, the tunnel forwards only the bridge listener, which speaks one narrow, authenticated protocol.
- **Deploy toolchain and licence.** Running functions locally needs the self-hosted `convex-backend` binary (FSL licence), a CLI plus bundler to deploy functions, admin-key handling and env sync. That is a lot of moving parts to ship inside a desktop app.
- **No local-first sync story.** Convex is the database; there is nothing to replicate to or from a cloud later.
- **What we actually used is small.** Three live queries, a scheduler used as a timer table, and single-document transactions. SQLite with a single writer gives the same atomicity (`BEGIN IMMEDIATE`), a `timers` table gives durable timers, and a Server-Sent-Events invalidation stream gives live UI updates.

The pure logic carries over unchanged: the lifecycle reducer (`core/machine.ts`), the stream normalizer, AES-GCM envelope, the Boat driver, the bridge HMAC, the notification renderer and the shared wire types in `packages/shared`.

### Sync later

The per-dork `events` table is append-only with a dense `seq`. That is the replication unit: a later cloud sync can ship `events` (and settings) by `(dork_id, seq)` without redesigning the model.

## Shape

```
 desktop app (Tauri) ── spawns ──► apps/server  (one binary, Bun)
   UI (static SPA) ──HTTP+SSE──►  UI listener   127.0.0.1:<ui port>     owner-token auth
 Boat sandbox: dorks-bridge ──WS─► bridge listener 127.0.0.1:<bridge port>  ◄── tunnel (wurmhol) ◄── public URL
                                      │
                                      ├─ SQLite (WAL)       <data dir>/dorks.db
                                      ├─ lifecycle driver   one SQLite transaction per input
                                      ├─ timers             durable table + in-process scheduler
                                      ├─ box jobs           Boat driver, outside transactions
                                      └─ GitHub poller      ETag polling with a stored token
```

Runtime: Bun (`bun:sqlite`, `Bun.serve`), compiled with `bun build --compile` into one sidecar binary per target. The code under `apps/server/src` is runtime-neutral except `main.ts`: the SQLite adapter picks `bun:sqlite` under Bun and `node:sqlite` under Node 24, so the unit tests run under vitest on Node against the real code and an in-memory database.

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
| `DORKS_BRIDGE_PORT` | `4748` (`0` = random) | Bridge listener, bound to `127.0.0.1`; the tunnel forwards to this |
| `DORKS_PUBLIC_URL` | none | Public `https://` URL of the tunnel. The sandbox is created with `BRIDGE_URL` = this (as `wss://`). Required before a Boat dork can be created |
| `DORKS_OWNER_TOKEN` | generated | Bearer token for the UI API. Generated once into `secrets.json` if unset |
| `DORKS_UI_ORIGINS` | tauri + localhost:3000 | Comma-separated browser origins allowed by CORS |
| `BOX_PROVIDER` | `boat` | `boat`, or `sim` for the local simulator and tests |
| `SIM_HOST_KEY` | none | Required when `BOX_PROVIDER=sim`; guards `GET /sim/boxes` (header `x-sim-host-key`), which `infra/bridge-sim/host.mjs` polls to start and stop fake sandboxes |
| `DORKS_PARENT_PID` | none | The supervising process (the desktop shell sets it). The server shuts down gracefully within a few seconds of that process disappearing |
| `SIM_LATENCY_MS` | `700` | Sim only: how long a simulated sandbox takes to stop or start, so the polling host always notices |
| `SIM_BUILD_STEP_MS` | `400` | Sim only: pause per step of the simulated base-snapshot build, so progress is visible |
| `DORKS_BRIDGE_BUNDLE` | none | Development: path of a bridge bundle to build snapshots from instead of the embedded one (see "Base snapshot") |
| `DORKS_DEBUG_BRIDGE` | none | Logs bridge frame names and sizes to stderr; never `configure` results or secrets |

`secrets.json` (mode 600) holds `bridgeSecretKey` (HMAC key for per-dork bridge secrets), `encryptionKey` (AES-GCM, base64 32 bytes) and `ownerToken`, generated on first run. The Boat API key, Claude token, GitHub token and CLI secrets are **settings** stored encrypted in SQLite, so the UI can change them without touching the environment.

On startup the server prints one JSON line to stdout for a supervisor: `{"ready":true,"ui":"http://127.0.0.1:4747","bridge":"ws://127.0.0.1:4748/bridge"}`. `GET /api/health` answers `{"ok":true}` without auth.

## UI API (loopback HTTP)

Auth: `Authorization: Bearer <owner token>` (SSE also accepts `?access_token=`, since `EventSource` cannot set headers). Bodies and responses are JSON. Errors are `{"error": AppError}` (see `packages/shared/src/errors.ts`) with a matching HTTP status (`invalid` 400, `forbidden` 401, `not_found` 404, `conflict`/`archived`/`deleting` 409, `limit` 429, `not_configured`/`onboarding_incomplete` 412, other 500).

IDs are UUID strings. Times are epoch milliseconds.

**Dork** (the client-visible row; box ids, session ids and secrets are never returned):
`{ id, title, repo, branch, provider: "claude"|"codex", state, archived, preview?, prUrl?, codexModel?, codexModelChoices?, lastActivityAt, createdAt }`
`state` is one of `creating | working | idle | sleeping | waking | error`.

| Method and path | Body / query | Result |
|---|---|---|
| `GET /api/dorks` | `?archived=true` | `Dork[]`, newest activity first, at most 200 |
| `GET /api/dorks/:id` | | `Dork` or 404 |
| `POST /api/dorks` | `{repo, message, title?, provider?}` (`provider` defaults to `codex`) | `{id}` |
| `PATCH /api/dorks/:id` | `{title}` | `{}` |
| `DELETE /api/dorks/:id` | | `{}` (box is destroyed in the background, then rows are purged) |
| `POST /api/dorks/:id/messages` | `{text}` | `{}` |
| `POST /api/dorks/:id/interrupt` | | `{}` |
| `POST /api/dorks/:id/archive` | `{archived: boolean}` | `{}` |
| `POST /api/dorks/:id/codex-model` | `{model, effort}` | `{}` |
| `GET /api/dorks/:id/events` | `?before=<seq>&limit=<1..200, default 50>` or `?after=<seq>` | `{events: ClientEvent[], hasMore}`. `before` (or neither) returns newest first; `after` returns ascending, inclusive of `seq > after` |
| `GET /api/dorks/:id/subscriptions` | | `SubscriptionView[]` (non-ended) |
| `POST /api/dorks/:id/subscriptions` | `{repo, number}` | `{}` (user subscribe; un-stalls and resets the CI budget) |
| `DELETE /api/dorks/:id/subscriptions` | `{repo, number}` | `{}` |
| `POST /api/dorks/:id/subscriptions/resume` | `{repo, number}` | `{}` |
| `GET /api/settings` | | `{claudeToken, boatKey, github: {configured, login?}, boatOrg, boatEnvironment, baseSnapshotId, sleepMinutes, commentPolicy, publicUrlConfigured, boxProvider}`: booleans and plain values only, never secrets |
| `PUT /api/settings` | any subset of `{boatKey, boatOrg, claudeToken, githubToken, boatEnvironment, baseSnapshotId, sleepMinutes, commentPolicy}` | `{}`. Token fields are write-only; an empty string clears one |
| `GET /api/snapshot` | | the base-snapshot build status, see "Base snapshot" |
| `POST /api/snapshot/build` | `{force?: boolean}` | `202` and the same status. Starts "Prepare Boat" unless a build is running, or the snapshot is already built from this app's bridge and in use (and `force` is not set). Error `not_configured` (412) without a Boat key |
| `GET /api/secrets` | | sorted names `string[]` |
| `PUT /api/secrets/:name` | `{value}` | `{}` (`^[A-Z][A-Z0-9_]{0,63}$`, 16 KB max) |
| `DELETE /api/secrets/:name` | | `{}` |
| `GET /api/health` | no auth | `{ok: true}` |

`ClientEvent` and `SubscriptionView` are the zod types in `packages/shared`. The event log is append-only; a growing assistant message keeps **one** row whose text grows in place (same `seq`), so a client that tails must re-read from its last known `seq` inclusive.

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

`packages/client` wraps this (`useDorks`, `useDork`, `useDorkEvents`, `useSettings`), replacing `@dorks/convex/client` and `convex/react`.

## Bridge protocol (WebSocket, the only thing exposed through the tunnel)

`GET /bridge` upgrades to a WebSocket on the bridge listener. Frames are JSON text. Nothing else is served there (`/` answers 404).

**Auth.** The first frame must be `{"t":"auth","dorkId","secret"}` where `secret = HMAC-SHA256(bridgeSecretKey, "bridge|" + dorkId)` hex, as before. The server answers `{"t":"auth_ok"}`; on a wrong secret, an unknown or deleting dork, or no first frame within 5 s it closes with code 4403. Nothing is served to an unauthenticated socket.

**Requests** (bridge to server): `{"t":"rpc","id":<n>,"op":"<op>","args":{...}}`. **Responses**: `{"t":"res","id":<n>,"ok":true,"result":...}` or `{"t":"res","id":<n>,"ok":false,"error":AppError}`.

| op | args | result |
|---|---|---|
| `connect` | | `{afterBridgeSeq}`. Error `sleeping` if the dork is asleep (a bridge must not wake anything). Marks the bridge seen and queues a `configure` command |
| `heartbeat` | | `{}`. Bridge liveness; back after a blip while `working`/`idle` re-arms the machine |
| `push` | `{frames: FromBridge[]}` (at most 500 frames, 256 KB per event) | `{ok:true}` or `{ok:false,expectedBseq}` when the batch has a gap. A gap applies nothing: the bridge resends from `expectedBseq`. Events numbered `<=` the stored `bridge_seq` are replays and skipped. Errors `too_many_frames`, `event_too_large` |
| `configure` | | the `configure` `ToBridge` frame (Claude token, CLI secrets, GitHub token, repo, resume session) or `null` if refused. **The only place secrets are decrypted**; they exist only in this response, never stored in a command row |
| `gh_token` | | `{token}` or `null` (the stored GitHub token; kept so the bridge's refresh path keeps working, the server no longer queues `gh_token` commands) |
| `subscribe_pr` | `{repo, number, source: "auto"\|"agent"}` | `{}` (idempotent) |
| `unsubscribe_pr` | `{repo, number}` | `{}` |

**Pushes** (server to bridge): `{"t":"commands","cmds":[{cid, frame: CommandFrame}]}` is the **snapshot of unacknowledged commands** and is re-sent whenever it changes (and once right after `auth_ok`). Delivery is idempotent: the bridge dedupes by `cid`/message id and acknowledges with a `push` `ack` frame, which removes the command. This gives resume-after-reconnect for free: after a drop the bridge re-auths, calls `connect` (learning `afterBridgeSeq`, the event cursor, so it replays events above it) and receives the current snapshot. `{"t":"subscriptions","views":SubscriptionView[]}` is sent likewise for the bridge's PR cache.

`push` frames, `ToBridge`, `FromBridge` and `CommandFrame` are the zod types in `packages/shared/src/bridge.ts`. The server no longer queues `gh_token` commands and ignores the legacy Codex device-code frames (`codex_login`; `codex_issue` still becomes an error event): Codex always authenticates through a Boat environment, so `configure` always says `codexAuthSource: "boat"`.

The `Transport` interface in `infra/bridge/src/transport.ts` is unchanged; `WsTransport` implements it over this protocol with reconnect and resume.

## Base snapshot ("Prepare Boat")

Every sandbox is created from a saved snapshot in the user's own Boat account (snapshots are per account), and the app builds it in one click instead of the manual `boat` steps in `docs/boat.md`. Code: `services/snapshot.ts` (the job), `core/snapshot.ts` (the provider seam), `lib/boatSnapshots.ts` (Boat), `snapshot/assets.ts` (what goes in).

`GET /api/snapshot` returns `{state: "none"|"building"|"ready"|"failed", snapshot, managed, stale, step, stepIndex, stepCount, message, error, startedAt, finishedAt, builtBundleId, currentBundleId, canBuild, cannotBuildReason}`:

- `snapshot` is the saved snapshot this app last built (`dorks-base-<8 hex of the install id>`, per installation so two installs on one Boat account never replace each other's image). `managed` is true when `settings.baseSnapshotId` is that snapshot; a name entered by hand (for example a `bsh_` share code) is never judged stale.
- `stale` means it was built from an older bridge or installer than this app now carries; `POST /api/snapshot/build` rebuilds it (no `force` needed). `bundleId` is the first 12 hex of sha256(bridge bundle, 0x00, installer).
- `state: "failed"` keeps `snapshot` (the last good one) and leaves `baseSnapshotId` alone: dorks keep starting from it. `error` is a message written for the user; for an installer failure it ends with the last lines of its output.
- Steps, in order: `prepare` (delete earlier build sandboxes: the recorded one and any with this install's `dorks-build` label), `create` (no account credentials, a 2 h lifetime as a safety net), `start`, `upload` (bridge bundle as base64, installer as text, then a sha256 check), `install` (`boat-install.sh`, 10 minute cap), `save` (Boat's saved-snapshot API, polled until OUR sandbox's save is `ready`; re-saving a name replaces the old artifact only once the new one is ready), `finish` (set `baseSnapshotId`). The build sandbox is deleted on every outcome; if Boat refuses, an `orphan:<id>` job retries.
- The job is a `snapshot:build` timer; a crash leaves the row `running` and the next start queues it again as a new attempt (`recoverSnapshotBuild`).
- The bridge bundle and the installer are embedded in the compiled sidecar (`snapshot/embedded.bun.ts`, resolved by `bun build --compile`; `scripts/build.ts` builds the bridge first). From source they are read from `infra/`.
- `BOX_PROVIDER=sim` swaps in an in-memory provider (`SIM_BUILD_STEP_MS`), so the whole flow runs without Boat.

Boat API used (https://docs.boat.dev): `POST|GET /sandboxes`, `GET|DELETE /sandboxes/{id}`, `PUT /sandboxes/{id}/files`, `POST /sandboxes/{id}/commands`, `POST /saved-snapshots`, `GET /saved-snapshots/{name}`.

## Lifecycle

`core/machine.ts` is unchanged apart from dropping the GitHub-token-refresh effects. Dispatch applies an input in one transaction: persist the new state, append a `status` event, then run effects (arm/cancel timers, enqueue box jobs, release held notifications, enqueue `interrupt`). Pausing keeps the same intent-with-generation model (`flushing` → `pausing` → `cancelled`). Timers: `sleep`, `watchdog`, `bridge_watch`, `flush`, `notify`, `pause_retry`. Global jobs (owner `''`): `poll`, `sweep`, `snapshot:build`, `orphan:<boxId>`.

## GitHub (autonomy)

No GitHub App and no webhooks. One **token** (a fine-grained PAT, or the one `gh auth token` yields) is stored encrypted in settings; it is handed to the sandbox in `configure` and used by the server's poller. Every 30 s (when any subscription is active) the poller reads each subscribed PR with conditional requests (`If-None-Match`; a 304 is free against the rate limit): the PR (head, base, state, mergeability), its reviews, its conversation and review comments since the last cursor, and the check suites of the head. It turns differences into the same normalized events the webhook path produced (`pr_closed`, `pr_synchronize`, `pr_base_changed`, `review`, `comment`, `check_suite`, mergeability) and feeds them through the same routing, CI-attempt budget, debounce inbox and `notify` rendering as before. Polling catches up after the machine sleeps, which webhooks cannot.

Identity: the dork acts as whoever owns the token. Events authored by the token's own login are ignored (they are the agent's own), so use a dedicated bot account's token if you also want your comments on the PR to wake the dork; otherwise talk to it in the chat.

## Security model

- UI listener: loopback only, bearer owner token, CORS limited to configured origins.
- Bridge listener: loopback only; the tunnel forwards to it. Only `/bridge` upgrades; authentication is the per-dork HMAC; secrets are returned only over an authenticated socket and never persisted in command rows.
- At rest: Boat key, Claude token, GitHub token and CLI secrets are AES-GCM encrypted (`core/crypto.ts`, additional data binds each to its purpose); `secrets.json` is mode 600.
- The sandbox's `BRIDGE_URL` is fixed at creation, so `DORKS_PUBLIC_URL` must be stable (a stable tunnel hostname).

## Build and test

```sh
pnpm --filter @dorks/server test         # vitest on Node 24 (node:sqlite), in-memory database, fake clock and sandbox provider
pnpm --filter @dorks/server typecheck
pnpm --filter @dorks/server build        # bun build --compile -> apps/server/dist/dorks-server-<target triple> (+ dorks-server for the host); `--all` for both macOS targets
node apps/server/scripts/e2e.mjs         # a real server process (SERVER_BIN=<binary> for the compiled one) with the simulated sandbox host
BRIDGE_IMPL=real node apps/server/scripts/e2e.mjs   # same, with the real in-box bridge and a fake Claude CLI
```

The compiled sidecar is about 64 MB (arm64) / 70 MB (x64): that is the Bun runtime plus the bundled code. The binary needs no files next to it; the database and `secrets.json` live in `DORKS_DATA_DIR`.

## Out of scope here

The Tauri shell and the tunnel sidecar (`docs/desktop.md`). The web client lives in `packages/client` and `apps/web`; `apps/convex` has been removed.
