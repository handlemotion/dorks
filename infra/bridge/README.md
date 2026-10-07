# dorks-bridge: the in-box bridge

The process that runs inside every sandbox box. It runs the Claude Code CLI headlessly, and speaks the bridge protocol
(`packages/shared/src/bridge.ts`) to the Convex backend (`apps/convex/convex/bridge.ts`) in place of the old WebSocket. It grew out of
`infra/bridge-sim/convex-sim.mjs`, which stays as the zero-dependency reference.

```
 Convex ──subscription bridge.commands──▶ dorks-bridge ──stdin (stream-json)──▶ claude -p …
 Convex ◀──mutation bridge.push (batched)─┘             ◀──stdout (stream-json)──┘
 Convex ◀──action bridge.configure / bridge.ghToken (the only place secrets travel)
```

## What the base snapshot needs

| Requirement | Why |
|---|---|
| **Linux user that is not root** | `claude --permission-mode bypassPermissions` refuses to start as root/sudo (outside a recognised sandbox). |
| **Node.js ≥ 22** (developed and tested on 24) | Runs the bridge. The bundled Convex client uses the global `WebSocket` (stable in Node 22). The bridge needs nothing else installed: it is one bundled file. |
| **git** (any version with `credential.helper` and `check-ref-format`; 2.30+) | Clone/fetch/checkout. The bridge sets `credential.helper` per repo. |
| **Claude Code CLI on `PATH`** (or `CLAUDE_BIN`) | `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` (native) or `npm i -g @anthropic-ai/claude-code`. Pin a version in the image and set `DISABLE_UPDATES=1` in the box env so it does not self-update. Verified against 2.1.293; the interrupt/stream-json flags used are the documented ones. |
| `sync` (coreutils) | Used on `flush`; optional (the bridge ignores its absence). |
| Outbound HTTPS to the Convex deployment, `github.com`, and Anthropic | |
| `dorks-bridge` installed | `pnpm --filter @dorks/bridge build`, then copy `infra/bridge/dist/cli.mjs` to `/usr/local/bin/dorks-bridge` (it has a `#!/usr/bin/env node` shebang and is self-contained: Convex client and shared schemas are bundled, no `node_modules`). |

### How it is started

The box entrypoint (owned by `infra/snapshot`) must start `dorks-bridge` as the box user, once per boot/resume, with these env vars (the
backend's `create_box` / `resume_box` provide them):

```
DORK_ID=<convex dorks id>   BRIDGE_URL=https://<deployment>.convex.cloud   BRIDGE_SECRET=<64 hex, HMAC(BRIDGE_SECRET_KEY, dorkId)>
```

Exit codes: `0` = clean (SIGTERM/SIGINT, or `connect` was refused with `sleeping`: the backend thinks this box is paused, so do **not**
restart it); `1` = fatal (backend answered `forbidden`: wrong secret or the dork was deleted). Restart policy: restart on a crash or a
non-zero exit with backoff, never on `0`. On a pause the box is frozen or killed; on resume the entrypoint starts the bridge again and
the backend re-sends `configure`.

`dorks-bridge credential --sock <path> <op>` is the same binary acting as a git credential helper (see below); `dorks-bridge --version`.

## Config and env it reads

Required (provided by the box): `DORK_ID`, `BRIDGE_URL`, `BRIDGE_SECRET`.

| Var | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `claude` | The CLI binary. Tests point it at `test/fixtures/fake-claude.mjs`. |
| `DORKS_PERMISSION_MODE` | `bypassPermissions` | Passed to `--permission-mode`. See "Permission mode". |
| `DORKS_CLAUDE_ARGS` | _(none)_ | Extra argv for the CLI, whitespace-separated (e.g. `--model sonnet`). |
| `DORKS_WORKDIR` | `~/work` | Repos are cloned to `<workdir>/<owner>/<repo>`. |
| `DORKS_STATE_DIR` | `~/.dorks-bridge` | `cred.sock` (0600, dir 0700) and `messages.log` (ids of user messages already written, for dedupe across a bridge restart). No secrets. Must survive a pause (it is on the box disk). |
| `DORKS_GIT_BASE_URL` | `https://github.com` | Clone base: `<base>/<owner>/<repo>.git`. Local/e2e use `file://…`. |
| `HEARTBEAT_MS` | `30000` | `bridge.heartbeat` interval. |
| `DELTA_BATCH_MS` | `150` | Text deltas are coalesced into one event per window. |
| `DORKS_BATCH_MS` | `50` | Debounce for sending a batch of other frames. |
| `DORKS_FLUSH_IDLE_WAIT_MS` | `20000` | How long `flush` waits for the current turn to finish before persisting anyway. |

The bridge never writes configure's secrets into its own `process.env`. `DORKS_*`, `BRIDGE_*`, `DORK_ID`, `CONVEX_*`, `SIM_HOST_KEY`
and `CLAUDE_BIN` are stripped from the environment of the Claude child and everything under it (git included).

## How it behaves

**Connect / numbering.** `bridge.connect` returns `afterBridgeSeq`; new events are numbered from `max(local, afterBridgeSeq) + 1`. The
Convex client reconnects its socket by itself; on every reconnect the bridge calls `connect` again (idempotent), continues numbering and
replays any retained event above the new `afterBridgeSeq`. `connect` refused with `sleeping` → exit 0.

**Outbound buffer** (`src/outbox.ts`). One ordered queue, one batch in flight. A failed push is retried with capped exponential backoff
(0.5 s → 30 s, jittered) forever; a batch is never dropped. Delivered events stay in a 2000-event replay window. If `bridge.push` returns
`{ expectedBseq }` (the gap-aware backend), the bridge rewinds to that seq and resends; if it returns nothing (today's backend) the push
counts as success, so this is feature-detected rather than required. Not durable across a bridge *process* crash: the numbering and the
session recover from the backend (`afterBridgeSeq`) and `--resume`, but events not yet pushed are lost.

**What is forwarded.** Only what `apps/api/src/normalize.ts` reads: `system/init` (reduced to `session_id`), `system/session_state_changed`,
stream `message_start` + `text_delta`, `assistant`, `user` (tool results), `result`, `rate_limit_event`. Thinking blocks, hook/status/retry
chatter and other stream deltas are dropped before they cost a bseq. Tool inputs/results are clipped at 16 KB per string (the backend
previews ~2 KB). Assistant text is never clipped. **`session_state_changed` needs `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`**, which the
bridge sets on the child; without it the backend would never see a turn end.

**Commands.**
- `fetch_configure` → `bridge.configure` action → clone/fetch, checkout (below), spawn the CLI, `ack`, `ready`. Idempotent: if the CLI is
  already running with the same repo+env it only re-acks and re-sends `ready`; a changed config restarts the CLI on the same session.
  If setup fails (bad branch name, clone refused) it reports `agent_exited` with `stderrTail: "setup failed: <step>"`.
- `user_message` → one stream-json line on stdin (`{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`),
  then `ack`. Deduped by id (in memory and in `messages.log`). If the CLI is not up yet it is left unacked and retried after configure.
- `interrupt` → `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` on stdin, the documented way in streaming
  input mode (not a signal: SIGINT/SIGTERM would end the session). Queued messages are not cancelled (`cancel_queued` is not set), so a
  message the user already sent still runs next.
- `flush` → wait (≤ `DORKS_FLUSH_IDLE_WAIT_MS`) for the turn to go idle, `fsync` the session transcript, `sync`, then `ack` + `flushed`
  (after every event queued before it).
- `fetch_gh_token` → `bridge.ghToken` action → swaps the in-memory token the credential helper serves, `ack`.

**Git.** The remote URL is always `https://github.com/<owner>/<repo>.git`, with no credentials. The repo's `credential.helper` is
`dorks-bridge credential --sock <state>/cred.sock`, which asks the running bridge for the token over a Unix socket (0600) and answers only
for `github.com` (and the host of `DORKS_GIT_BASE_URL`); it never stores. The token lives in the bridge's memory and nowhere on disk, so the
agent's own `git push` works and gets the refreshed token after each `fetch_gh_token`. Branch: reuse the local branch, else track
`origin/<branch>`, else create it from the default branch. Local work is never reset. Note: `gh` (the GitHub CLI) is *not* authenticated;
only git is (follow-up below).

**Claude CLI argv** (checked against the Claude Code docs and a live run of 2.1.293):

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --permission-mode bypassPermissions [--resume <id>]
```

`--verbose` is required for stream-json output; `--include-partial-messages` makes `stream_event` text deltas flow. Not used: `--bare` (it
never reads OAuth, and the box authenticates with `CLAUDE_CODE_OAUTH_TOKEN`) and `--no-session-persistence` (the transcript on disk *is*
what `--resume` loads). Project settings/CLAUDE.md of the cloned repo are loaded as usual.

**Permission mode: `bypassPermissions`.** Nobody is attached to answer a prompt, and a box is an isolated, single-tenant, disposable
environment that already holds the user's secrets for this one repo. The docs recommend this mode for "isolated containers and VMs", and
the lesser modes either hang or deny (`acceptEdits` still prompts for any shell command or network call; `dontAsk` denies them, so the agent
cannot run tests or `git push`). What `bypassPermissions` still does *not* skip are a few always-asked safety checks; those reach the
bridge as `can_use_tool` control requests, and the bridge **denies** them (with a message telling the model nobody can approve) so the turn
continues instead of hanging. Deny rules in the repo's settings still apply. Override with `DORKS_PERMISSION_MODE` if the snapshot ever gets
a tighter policy.

**Secrets.** `CLAUDE_CODE_OAUTH_TOKEN` and the user's CLI secrets (from `configure`) go only into the child's environment; `BRIDGE_SECRET` and
the other bridge variables never do (a configure env var with a reserved name is ignored). Nothing secret is logged: CLI stderr is
never logged at all; its last 2 KB is attached to `agent_exited` after every known secret value is replaced with `[redacted]`;
errors are logged by code/name only; the logger scrubs known secrets as a last line of defence.

**Exit.** When the CLI exits on its own the bridge sends `agent_exited { code, stderrTail }` (`code: null` if killed by a signal) and keeps
running; a later `configure` starts it again.

## Tests

```sh
pnpm --filter @dorks/bridge test        # unit tests, fake claude CLI + fake transport + local bare git remote (no network)
pnpm --filter @dorks/bridge typecheck
```

`test/fixtures/fake-claude.mjs` replays the stream-json shapes of a turn (state change, init, `message_start`, text deltas, assistant
text + `tool_use`, `tool_result`, `result`, idle), honours `--resume`, interrupts and EOF, and has hooks for crashes, stderr echo and permission
requests. Its events follow the Agent SDK types and a live unauthenticated run of the real CLI; no paid session was recorded.

### End-to-end against a local Convex backend

`infra/bridge-sim/host.mjs` takes `BRIDGE_IMPL=real` to run one real bridge per sim box instead of `convex-sim.mjs` (it builds the bundle,
creates a local bare git remote for `jaantonio/demo`, and gives each box its own state/work dirs that survive a "pause"). With the local
Convex set up as in `docs/convex-spike.md`:

```sh
cd apps/convex && BRIDGE_IMPL=real ./scripts/run-e2e.sh      # CLAUDE_BIN defaults to the fake CLI
```

This is the same 37-check acceptance run plus the secret scan; the turn produces `assistant_delta`, `assistant_message`, `tool_use`,
`tool_result`, `turn_complete`, and the session resumes after sleep/wake.

### Trying it with a real Claude token locally

1. Get a token: `claude setup-token` (needs a Claude subscription) and `export CLAUDE_CODE_OAUTH_TOKEN=…` (or `ANTHROPIC_API_KEY`).
2. Bridge-level check, no Convex needed (three short turns: reply, a Bash tool call, then resume in a new bridge process):
   ```sh
   pnpm --filter @dorks/bridge test live
   ```
   (`LIVE_CLAUDE_ARGS="--model haiku"` to pick a model; `CLAUDE_BIN` for a non-default binary.)
3. Full loop through Convex with the real CLI: `apps/convex/scripts/e2e.mjs` takes the Claude token from `E2E_CLAUDE_TOKEN` (default: a
   placeholder). With the local Convex set up:
   ```sh
   cd apps/convex && E2E_CLAUDE_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" BRIDGE_IMPL=real CLAUDE_BIN=claude ./scripts/run-e2e.sh
   ```
   The repo comes from the local fixture remote, and the model decides what tools to use, so the `tool_use`/`tool_result` checks depend on
   it editing a file for "add a readme". Treat this as a smoke test; the fake-CLI run is the deterministic acceptance bar.

## Open items

- `bridge.push` returning `{ expectedBseq }` on a gap is already handled (replay from that seq).
- `gh` is not authenticated in the box (only git is, through the credential helper). Installation tokens expire after an hour, so a
  `GH_TOKEN` env var would go stale; a `gh` shim that asks the same socket is the clean fix.
- Pause/resume of the whole box is the entrypoint's job (`infra/snapshot`); the bridge only needs to be started again with the same env.
