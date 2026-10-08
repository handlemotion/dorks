# dorks-bridge: the in-box bridge

The process that runs inside every sandbox box. It runs the Claude Code CLI headlessly, and speaks the bridge protocol
(`packages/shared/src/bridge.ts`) to the Convex backend (`apps/convex/convex/bridge.ts`) in place of the old WebSocket. It grew out of
`infra/bridge-sim/convex-sim.mjs`, which stays as the zero-dependency reference.

```
 Convex ──subscription bridge.commands──▶ dorks-bridge ──stdin (stream-json)──▶ claude -p …
 Convex ◀──mutation bridge.push (batched)─┘             ◀──stdout (stream-json)──┘
 Convex ◀──action bridge.configure / bridge.ghToken (the only place secrets travel)
 Convex ◀──mutation bridge.subscribe / bridge.unsubscribe, query bridge.subscriptions──┐
                                  git credential helper, `dorks`, `gh` shim ──unix socket──┘ (local RPC)
```

It is also the box's autonomy plumbing ([`docs/autonomy.md`](../../docs/autonomy.md)): `notify` commands become user turns, and a local RPC on
the credential socket serves the `dorks` CLI and the `gh` shim (see "Local RPC, `dorks` and the `gh` shim").

## What the base snapshot needs

| Requirement | Why |
|---|---|
| **Two Linux users: the bridge as root (or with `CAP_SETUID`), Claude as an unprivileged user** (e.g. `dork`) | Recommended, see "Privilege separation". `claude --permission-mode bypassPermissions` refuses to start as root/sudo, and a same-uid child can read the bridge's `/proc/<pid>/environ` and memory. Needs `setpriv` (util-linux, in every mainstream base image). A single unprivileged user also works (leave `CLAUDE_RUN_AS` unset) with the caveats below. |
| `kernel.yama.ptrace_scope` ≥ 1 (`sysctl -w kernel.yama.ptrace_scope=1`, persist in `/etc/sysctl.d`) | Stops a same-uid process from attaching to the bridge. Required for the single-user layout, defence in depth for the two-user one. |
| **Node.js ≥ 22** (developed and tested on 24) | Runs the bridge. The bundled Convex client uses the global `WebSocket` (stable in Node 22). The bridge needs nothing else installed: it is one bundled file. |
| **git** (any version with `credential.helper` and `check-ref-format`; 2.30+) | Clone/fetch/checkout. The bridge sets `credential.helper` once, in the Claude user's global config (see "Git"). |
| **Claude Code CLI on `PATH`** (or `CLAUDE_BIN`) | `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` (native) or `npm i -g @anthropic-ai/claude-code`. Pin a version in the image and set `DISABLE_UPDATES=1` in the box env so it does not self-update. Verified against 2.1.293; the interrupt/stream-json flags used are the documented ones. |
| `sync` (coreutils) | Used on `flush`; optional (the bridge ignores its absence). |
| Outbound HTTPS to the Convex deployment, `github.com`, and Anthropic | |
| `dorks-bridge` installed | `pnpm --filter @dorks/bridge build`, then copy `infra/bridge/dist/cli.mjs` to `/usr/local/bin/dorks-bridge` (it has a `#!/usr/bin/env node` shebang and is self-contained: Convex client and shared schemas are bundled, no `node_modules`). Symlink it as `dorks` and `gh` too (below). |
| **`gh`** (pinned) at `/usr/bin/gh`, the **`gh stack`** extension | Not needed by the bridge itself; the `gh` shim runs them. `infra/snapshot` installs both. |

### How it is started

The box entrypoint (owned by `infra/snapshot`) must start `dorks-bridge` as the box user, once per boot/resume, with these env vars (the
backend's `create_box` / `resume_box` provide them):

```
DORK_ID=<convex dorks id>   BRIDGE_URL=https://<deployment>.convex.cloud   BRIDGE_SECRET_FILE=<path to a 0400 file holding the 64-hex secret>
CLAUDE_RUN_AS=dork
```

The secret is `HMAC(BRIDGE_SECRET_KEY, dorkId)`. Prefer **`BRIDGE_SECRET_FILE`**: the bridge reads the file once and unlinks it, so the secret never sits in the process environment. `BRIDGE_SECRET` in env still works as a fallback (and is needed again if the box restarts the bridge after the file was consumed; have the entrypoint write the file on every start).

Exit codes: `0` = clean (SIGTERM/SIGINT, or `connect` was refused with `sleeping`: the backend thinks this box is paused, so do **not**
restart it); `1` = fatal (backend answered `forbidden`: wrong secret or the dork was deleted). Restart policy: restart on a crash or a
non-zero exit with backoff, never on `0`. On a pause the box is frozen or killed; on resume the entrypoint starts the bridge again and
the backend re-sends `configure`.

The same binary has other entry points (below): `dorks-bridge credential --sock <path> <op>` (git credential helper), `dorks` (the agent CLI) and `gh` (the shim);
`dorks-bridge --version`.

## Config and env it reads

Required (provided by the box): `DORK_ID`, `BRIDGE_URL`, and `BRIDGE_SECRET_FILE` (or `BRIDGE_SECRET`).

| Var | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `claude` | The CLI binary. Tests point it at `test/fixtures/fake-claude.mjs`. |
| `CLAUDE_RUN_AS` | _(unset)_ | Unprivileged user to run Claude (and the git clone/checkout) as, via `setpriv`. The bridge must be root. Sets the child's `HOME`/`USER` to that user's. |
| `DORKS_PERMISSION_MODE` | `bypassPermissions` | Passed to `--permission-mode`. See "Permission mode". |
| `DORKS_CLAUDE_ARGS` | _(none)_ | Extra argv for the CLI, whitespace-separated (e.g. `--model sonnet`). |
| `DORKS_WORKDIR` | `~/work` | Repos are cloned to `<workdir>/<owner>/<repo>`. |
| `DORKS_STATE_DIR` | `~/.dorks-bridge` | `cred.sock` (the local RPC socket, 0600, dir 0700), `messages.log` (ids of user messages and notifications already written, for dedupe across a bridge restart), `claude-settings.json` (the hooks handed to `claude --settings`, 0644 so the Claude user can read it) and `stop-gate.json` (which Stop-gate conditions were already raised in the session). No secrets. Must survive a pause (it is on the box disk). |
| `DORKS_GIT_BASE_URL` | `https://github.com` | Clone base: `<base>/<owner>/<repo>.git`. Local/e2e use `file://…`. |
| `HEARTBEAT_MS` | `30000` | `bridge.heartbeat` interval. |
| `DELTA_BATCH_MS` | `150` | Text deltas are coalesced into one event per window. |
| `DORKS_BATCH_MS` | `50` | Debounce for sending a batch of other frames. |
| `DORKS_FLUSH_IDLE_WAIT_MS` | `20000` | How long `flush` waits for the current turn to finish; then it interrupts the turn. |
| `DORKS_FLUSH_INTERRUPT_WAIT_MS` | `5000` | How long `flush` waits for the interrupted turn to wind down before persisting. |

The bridge never writes configure's secrets into its own `process.env`. `DORKS_*`, `BRIDGE_*`, `DORK_ID`, `CONVEX_*`, `SIM_HOST_KEY`
and `CLAUDE_BIN` are stripped from the environment of the Claude child and everything under it (git included). Two `DORKS_` names are
the exception: the bridge sets `DORKS_SOCK` (the RPC socket path) in the child's environment, and `DORKS_REAL_GH` (where the real gh
is, optional) passes through.

## How it behaves

**Connect / numbering.** `bridge.connect` returns `afterBridgeSeq`; new events are numbered from `max(local, afterBridgeSeq) + 1`. The
Convex client reconnects its socket by itself; on every reconnect the bridge calls `connect` again (idempotent), continues numbering and
replays any retained event above the new `afterBridgeSeq`. `connect` refused with `sleeping` → exit 0.

**Outbound buffer** (`src/outbox.ts`). One ordered queue, one batch in flight. A failed push is retried with capped exponential backoff
(0.5 s → 30 s, jittered) forever; a batch is never dropped. Delivered events stay in a 2000-event replay window. If `bridge.push` returns
`{ expectedBseq }` (the gap-aware backend), the bridge rewinds to that seq and resends; if it returns nothing (today's backend) the push
counts as success, so this is feature-detected rather than required. A push answering `{ ok: false, expectedBseq }` is treated as rejected as a whole: only retained *events* from that seq are replayed (control frames that were delivered are never repeated; ones in the rejected batch were never confirmed and are still queued). If `expectedBseq` is older than the replay window the retained events are renumbered from it (the lost ones can never be resent) instead of being retried forever, and if the backend is ahead of everything held the bridge numbers new events above it. `too_many_frames` halves the batch size; `event_too_large` replaces the oversized event with a `{type, truncated:true}` stub keeping its bseq, so one bad event cannot block the stream. Not durable across a bridge *process* crash: the numbering and the
session recover from the backend (`afterBridgeSeq`) and `--resume`, but events not yet pushed are lost.

**What is forwarded.** Only what `apps/api/src/normalize.ts` reads: `system/init` (reduced to `session_id`), `system/session_state_changed`,
stream `message_start` + `text_delta`, `assistant`, `user` (tool results), `result`, `rate_limit_event`. Thinking blocks, hook/status/retry
chatter and other stream deltas are dropped before they cost a bseq. Tool inputs/results are clipped at 16 KB per string (the backend
previews ~2 KB), the `tool_use_result` field (the tool's full structured output: whole files, full stdout) is dropped, and any single event is capped at 200 KB (the backend rejects >256 KB). Assistant text is only clipped if an event would exceed that cap. **`session_state_changed` needs `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`**, which the
bridge sets on the child; without it the backend would never see a turn end.

**Commands.**
- `fetch_configure` → `bridge.configure` action → clone/fetch, checkout (below), spawn the CLI, `ack`, `ready`. Idempotent: if the CLI is
  already running with the same repo+env it only re-acks and re-sends `ready`; a changed config restarts the CLI on the same session.
  The config fetch is retried with backoff if it fails transiently. `--resume` is only used when the session transcript exists on this box's
  disk (`<config dir>/projects/*/<id>.jsonl`); otherwise (e.g. the box was recreated) it starts a fresh session. If the CLI still answers
  "No conversation found" the bridge discards that run's output, starts a fresh session once and replays the messages it never answered.
  If setup fails (bad branch name, clone refused) it reports `agent_exited` with `stderrTail: "setup failed: <step>"`.
- `user_message` and `notify` → one stream-json line on stdin (`{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`),
  then `ack`. Deduped by id (in memory and in `messages.log`). If the CLI is not up yet it is left unacked and retried after configure.
  `notify` (an autonomy digest, already wrapped in a `<dorks-event>` envelope by the backend) takes the very same path (`Bridge.deliver`): the
  `text` is written verbatim, deduped by id (memory + `messages.log`), acked, and left unacked until the agent is up. The log gets its kinds and PRs, never the text.
- `interrupt` → `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` on stdin, the documented way in streaming
  input mode (not a signal: SIGINT/SIGTERM would end the session). Queued messages are not cancelled (`cancel_queued` is not set), so a
  message the user already sent still runs next. An interrupt that arrives while `configure` is still starting the agent is applied once it is up.
- `flush` → wait (≤ `DORKS_FLUSH_IDLE_WAIT_MS`) for the turn to go idle; if it does not, interrupt it and wait (≤ `DORKS_FLUSH_INTERRUPT_WAIT_MS`);
  then `fsync` the session transcript, `sync`, `ack` + `flushed` (after every event queued before it; carries `cid` = the flush command's id,
  which the shared protocol is gaining as an optional field).
- `fetch_gh_token` → `bridge.ghToken` action → swaps the in-memory token the credential helper serves, `ack`.

**Git.** The remote URL is always `https://github.com/<owner>/<repo>.git`, with no credentials. The credential helper is configured once, in
the Claude user's **global** git config, scoped to the host (`credential.https://github.com.helper`, plus the host of `DORKS_GIT_BASE_URL` when
that is another http(s) URL), so every repo the agent clones under the workdir can push, not just the starting repo (the token is
installation-wide). It is `dorks-bridge credential --sock <state>/cred.sock`, which asks the running bridge for the token (the `token` RPC method)
and answers only for `github.com` (and the host of `DORKS_GIT_BASE_URL`); it never stores. The token lives in the bridge's memory and nowhere on
disk, so the agent's own `git push` works and gets the refreshed token after each `fetch_gh_token`. `user.name` / `user.email` are set globally
too, unless already configured. Starting repo: reuse the local branch, else track `origin/<branch>`, else create it from the default branch.
Local work is never reset.

**Local RPC, `dorks` and the `gh` shim.** The credential socket (`src/rpc.ts`) is a small JSON-lines RPC: one request per line,
`{"method":"pr.sub","params":{…}}`, answered in order with `{"ok":true,"result":…}` or `{"ok":false,"error":{"code","message"}}` (codes: `invalid`,
`unknown_method`, `unavailable`, `denied`, `failed`). Only the Claude user can connect (0600 in a 0700 dir). Methods are one table
(`Bridge.rpcMethods`); non-`RpcError` failures are reported as `internal error` so nothing from the process leaks.

| Method | Params → result |
|---|---|
| `token` | `{ host }` → `{ token }`; only for `github.com` (and the clone host). `unavailable` until the first `configure`. |
| `pr.sub` / `pr.unsub` | `{ repo: "owner/name", number, source?: "auto" \| "agent" }` / `{ repo, number }` → the ref. Validated here, then `bridge.subscribe` / `bridge.unsubscribe`; the call waits (≤ 2 s) until the cached list reflects it, so `sub` then `list` reads its own write. A backend that does not answer within 10 s gives `unavailable` (the Convex client would otherwise queue the mutation while offline). |
| `pr.list` | → `SubscriptionView[]`: the cached result of the reactive `bridge.subscriptions` query, opened once the bridge is connected and re-opened after every reconnect. Waits ≤ 5 s for the first copy; a malformed list is ignored and the last good one is kept. |

| `hook.stop` / `hook.postToolUse` / `hook.sessionStart` | The hook's JSON input (as Claude Code sends it) → the hook's JSON output, or `null` for "no opinion". See "Hooks". |

One bundle, several entry points, chosen by the name it is invoked as (`argv[1]`, so symlinks work) or, as `dorks-bridge`, by its first argument:

| Invoked as | Role |
|---|---|
| `dorks-bridge` | the daemon |
| `dorks-bridge credential --sock <path> <op>` | git credential helper |
| `dorks <…>`, or `dorks-bridge dorks <…>` | the agent CLI |
| `gh <…>`, or `dorks-bridge gh <…>` | the gh shim |

The snapshot installs the file once and symlinks `dorks` and `gh` to it. The CLI and shim find the bridge through `DORKS_SOCK`, which the bridge sets in
the Claude child's environment (they are children of it).

- `dorks pr sub <pr>`, `dorks pr unsub <pr>`, `dorks pr list [--json]`, where `<pr>` is `https://github.com/owner/name/pull/12` or `owner/name#12`.
  Human-readable output by default; exit 0 on success, 2 for a bad reference or usage, 1 when the bridge is unreachable (`dorks: cannot reach the
  dorks bridge in this box`) or refuses.
- **`gh` shim.** Ahead of the real gh on `PATH` (`/usr/local/bin/gh` over `/usr/bin/gh`). It asks the socket for the token, runs the real gh
  (`DORKS_REAL_GH`, else the first `gh` on `PATH` that is not the shim, compared by real path) with `GH_TOKEN` set, and passes stdio and the exit
  code through (signals are relayed). The token is only in that child's environment: not in argv, not on disk (installation tokens last an hour, so
  it is fetched per invocation). After a **successful** `gh pr create`, or `gh stack submit` (URLs are looked for on both streams), it reads the PR URLs
  from the output (a terminal run is never intercepted) and calls `pr.sub` with `source: "auto"`. A failure to get the token or to subscribe is one
  `dorks: …` line on stderr and never changes gh's exit code; without `DORKS_SOCK` (not in a box) it is a silent pass-through. Do not install the shim as
  a *copy*: it finds itself by real path, so use the symlink.

**Hooks** (`src/hooks.ts`, `src/hook-cli.ts`, `src/work-scan.ts`). Claude Code calls back into the bridge at three points. At `start()` the bridge writes
`<state>/claude-settings.json`, and the agent is started with `claude --settings <that file>`:

```json
{ "hooks": {
  "Stop":         [{ "hooks": [{ "type": "command", "command": "'<node>' '<cli.mjs>' dorks hook stop", "timeout": 30 }] }],
  "PostToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "… dorks hook post-tool-use", "timeout": 15 }] }],
  "SessionStart": [{ "matcher": "startup|resume|compact", "hooks": [{ "type": "command", "command": "… dorks hook session-start", "timeout": 10 }] }]
} }
```

`--settings` is applied above the user's and the project's settings files, and hooks from every source run, so a repo's own `.claude/settings.json` hooks still
fire next to these (checked with the real CLI, and asserted in the live test). The command goes through the bundle's absolute path (the same `[node, cli.mjs]`
as the git credential helper) in its `dorks` role, so it does not depend on `PATH` inside the hook's shell. `dorks hook <stop|post-tool-use|session-start>` reads the hook
JSON on stdin, calls `hook.stop` / `hook.postToolUse` / `hook.sessionStart` on `DORKS_SOCK` and prints the answer. **It fails open:** no socket, an unreachable or
slow bridge, an error answer, unreadable input or any exception ends in exit 0 with no output, which Claude Code reads as "no opinion", so a broken hook never wedges
the agent. A handler that throws on the bridge side does the same (one `hook … failed: <error name>` log line).

| Hook | What the bridge does |
|---|---|
| `Stop` | The "done" gate. Scans the git repositories under the workdir (`<workdir>/*/*`, up to three levels, not into repos, `node_modules` or dot dirs) with local git reads only: **unpushed** (a branch with commits its upstream, or `origin/<branch>` if pushed without `-u`, does not have), **unpublished** (a branch with no remote counterpart and commits beyond the default branch; a branch that merely tracks the default branch counts as having no upstream), and **no PR** (a pushed branch with commits beyond the default branch and no pull request: first the cached subscriptions by `headRef`, else `gh pr list --head` through the real `gh` with the bridge's token; "any state", so merged or closed branches are not nagged about; unknown when gh or the network fails, which never blocks). A branch whose remote branch is gone is skipped. If anything is **new** it answers `{"decision":"block","reason":…}`: validate locally (tests, typecheck, lint for what changed, using the repo's scripts), push, open a PR with `gh pr create`, or explain why it is intentionally not pushing. Otherwise it answers nothing, whether or not subscriptions are active. |
| `PostToolUse` (`Bash`) | Backs up the shim, which only watches gh when stdout is not a terminal. After a command that matches `gh … pr create` / `gh stack submit` it subscribes (`source: "auto"`) to the PR URLs in the tool's stdout and stderr, unless the list already has them. After `gh … pr merge` / `pr close` it unsubscribes from `Closed|Merged|Squashed and merged|Rebased and merged pull request owner/name#n` as gh prints it (not `--auto`, which only queues). Repos are compared case-insensitively. It never returns anything, so the tool result is untouched. |
| `SessionStart` | `hookSpecificOutput.additionalContext`: the subscribed PRs (`repo#n "title": CI, review, mergeable, CI fix attempts n/2, STALLED`) and a short "how autonomy works here" guide (the `<dorks-event>` turns, validate locally before pushing, `dorks pr sub/unsub/list`, post a standby note when ready, never merge). |

**The Stop gate cannot loop.** `stop_hook_active: true` (Claude Code is already continuing because a Stop hook blocked) always allows the stop. Beyond that,
a condition (`kind`, repository directory, branch) is raised **once per session**: the set of raised conditions is persisted in `stop-gate.json` (the bridge restarts
whenever the box wakes) and keyed by `session_id`. A condition is forgotten as soon as a Stop finds it cleared, so work that goes unpushed again later (a CI
fix, say) is raised again, while an ignored or "intentionally not pushing" one is not repeated. Conditions found while `stop_hook_active` was true were not raised
and are caught at the next Stop. The turn that answers a `ready` notification is not gated (the bridge remembers the kinds of the last `notify` it wrote; a user
message resets that). Claude Code adds its own cap on consecutive Stop blocks.

**Claude CLI argv** (checked against the Claude Code docs and a live run of 2.1.293):

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --permission-mode bypassPermissions --settings <state>/claude-settings.json [--resume <id>]
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

**Secrets.** `CLAUDE_CODE_OAUTH_TOKEN` and the user's CLI secrets (from `configure`) go only into the child's environment. The bridge variables
(`BRIDGE_*`, `DORK_ID`, `DORKS_*`, `CONVEX_*`, `SIM_HOST_KEY`, `CLAUDE_BIN`, `CLAUDE_RUN_AS`) are not passed to the child, and a configure env var
with a reserved name is ignored. Nothing secret is logged: CLI stderr is never logged at all; its last 2 KB is attached to `agent_exited` after every
known secret value is replaced with `[redacted]`; errors are logged by code/name only; the logger scrubs known secrets as a last line of defence.

**Privilege separation (what actually protects `BRIDGE_SECRET`).** Not putting the secret in the child's *environment* is not enough on its own: a
child running as the same uid as the bridge can read `/proc/<bridge pid>/environ` (the kernel keeps the initial environment, whatever the process does
afterwards) and, without Yama, the bridge's memory. So the supported layout is:

- the bridge runs as root and starts Claude with `CLAUDE_RUN_AS=<user>`: Claude and the git commands that prepare its working tree run through
  `setpriv --reuid --regid --init-groups`, and the repo, the credential socket (`<state>/cred/cred.sock`, 0600) and the child's `HOME` belong to that user;
  the state dir stays root-only (it holds `messages.log`);
- the secret arrives via `BRIDGE_SECRET_FILE` (0400, unlinked after reading), so it is not in the environment either;
- `kernel.yama.ptrace_scope ≥ 1` as defence in depth.

With this, an agent under `bypassPermissions` cannot read the bridge's environ, memory or secret, so it cannot forge pushes, pause its own box or call
`configure`. Without `CLAUDE_RUN_AS` (single unprivileged uid) the agent *can* recover `BRIDGE_SECRET` from the bridge process unless Yama is on, and even
then only `ptrace_scope ≥ 2` or a separate uid fully closes it; treat the secret as readable by the agent in that layout. The agent already holds the
Claude and GitHub tokens either way, so what is at stake is mainly event forgery and lifecycle control (the credential socket hands the GitHub token to any
process of the Claude user by design; the token's scope is what limits it). `test/privsep.test.ts` checks the uid separation when run as root:
`sudo -E env "PATH=$PATH" npx vitest run test/privsep.test.ts` (skipped otherwise).

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

`test/hooks.test.ts` covers the Stop gate on git fixtures (clones of local bare remotes: unpushed, unpublished, no PR, once per condition, restart, `stop_hook_active`,
`ready`), PostToolUse, SessionStart, the settings file, the argv and the gh lookup; `test/hook-cli.test.ts` runs the built `dorks hook` against a stand-in socket,
including every fail-open path; and `bridge.test.ts` ("autonomy: hooks") runs the commands from the written settings file through a shell against a real bridge.

`test/fixtures/fake-gh.mjs` stands in for the real gh in the shim tests (it reports its argv and `GH_TOKEN`, prints what the test asks for and exits
with the code it is given). The `dorks` and shim tests run the **built bundle** under the names `dorks` / `gh` (symlinks, like the snapshot) against an
in-process stand-in for the bridge's RPC socket; the bridge-level tests use the fake transport (`subscribePr`, `unsubscribePr`, a settable
`bridge.subscriptions`), so none of this needs the autonomy backend.

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
2. Bridge-level check, no Convex needed: three short turns (reply, a Bash tool call, then resume in a new bridge process), and one turn proving the hooks
   (SessionStart's context reaches the model, the Stop gate blocks an unpushed commit exactly once and the turn still ends, a repo hook still runs next to them):
   ```sh
   pnpm --filter @dorks/bridge test live
   ```
   (`LIVE_CLAUDE_ARGS="--model haiku"` to pick a model; `CLAUDE_BIN` for a non-default binary; `ANTHROPIC_BASE_URL` is passed through.)
3. Full loop through Convex with the real CLI: `apps/convex/scripts/e2e.mjs` takes the Claude token from `E2E_CLAUDE_TOKEN` (default: a
   placeholder). With the local Convex set up:
   ```sh
   cd apps/convex && E2E_CLAUDE_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" BRIDGE_IMPL=real CLAUDE_BIN=claude ./scripts/run-e2e.sh
   ```
   The repo comes from the local fixture remote, and the model decides what tools to use, so the `tool_use`/`tool_result` checks depend on
   it editing a file for "add a readme". Treat this as a smoke test; the fake-CLI run is the deterministic acceptance bar.

## Known limitations

- **Dedupe is at-most-once across a crash.** A message is journaled right after it is written to the CLI's stdin. If the bridge or box dies between
  the write and the CLI actually processing it, the backend's redelivery is acked from the journal and never re-run. (The opposite, a duplicate, would
  need the write to fail after being journaled, which cannot happen.)
- `messages.log` (written ids, mode 0600) grows without bound; only the last 2000 lines are read at startup.
- The credential helper answers by host (`github.com`, plus the host of `DORKS_GIT_BASE_URL`) and does not check `protocol=https`.
- The child env is built from a deny-list: anything else the box entrypoint exports (beyond the reserved prefixes above) reaches Claude. Keep the entrypoint
  env minimal, or set `CLAUDE_RUN_AS` and give that user its own clean environment.
- Pending, unsent events are lost if the bridge process itself crashes (see "Outbound buffer").
- The gh shim only reads PR URLs when its stdout is not a terminal (a pipe changes what gh prints on a TTY). The agent's tools are never TTYs; a human running
  `gh pr create` by hand in a terminal is not auto-subscribed (`dorks pr sub` does it). The `PostToolUse` hook reads the tool result instead, so `gh pr create` is
  caught in either case when the agent runs it.
- The Stop gate looks at commits and branches, not at uncommitted changes, and only at repositories under the workdir. Whether a pushed branch has a PR needs the
  real `gh` and network; without them that one check stays silent.

## Open items

- `bridge.push` returning `{ expectedBseq }` on a gap is already handled (replay from that seq).
- The autonomy backend (`bridge.subscribe`, `bridge.unsubscribe`, reactive `bridge.subscriptions`; docs/autonomy.md, slice B1) has to be deployed for
  `pr.*` to do anything. Before that the bridge logs `subscriptions query error`, `dorks pr list` answers `unavailable` and `pr sub` reports the refusal.
- Pause/resume of the whole box is the entrypoint's job (`infra/snapshot`); the bridge only needs to be started again with the same env.
