# Crews: coordinators, workers and the Dorks MCP server

Status: first cut. One set of session tools, served in two places:

- **External**: the dorks server is itself an MCP server (`POST /mcp` on the UI listener, owner token). Any agent the owner runs
  (Claude Code, Claude Desktop, Cursor, Devin, a script) can create dorks, message them, wait for them and read their answers,
  list builds and repos, and start build runs.
- **Internal**: a **coordinator** dork gets the same tools inside its sandbox (the built-in `dorks` MCP server), scoped to the
  dorks it created, its **workers**. Workers get a small subset to talk to their coordinator and to each other.

A coordinator is a session that does not develop: it breaks a long goal into tasks, hands each to a worker dork (its own
sandbox, repo, branch and PRs), follows them, and reports to the owner. Together they are a **crew**.

## Design choices (and where they come from)

| Choice | Why |
|---|---|
| One tool table (`packages/shared/src/crew.ts`) for both layers, each tool tagged with who may see it (`owner`, `coordinator`, `worker`) | External and internal agents read the same names, descriptions and results; the server enforces scope, the list only hides what is not allowed |
| Session handles are explicit `id` arguments, no MCP session state | MCP 2026-07-28 is stateless (no `initialize`, no `Mcp-Session-Id`): state lives in handles the server mints |
| Coordinators are **woken**, not made to poll: a worker's turn end reaches its coordinator as a `<dorks-event source="crew">` turn | The same pattern as Claude Code background subagents, agent teams' idle notifications and Devin's managed sessions. It reuses the `notify` path of [autonomy](autonomy.md): held until the coordinator's turn boundary, wakes it from sleep |
| `dork_wait` also exists: blocks up to a timeout until any or all of the named dorks settle, always returns | External clients have no wake-ups (Devin's MCP has `devin_session_gather` for the same reason). Internally it is for short waits; the guidance says to end the turn instead |
| Coordinator → worker messages are user turns (they steer); worker → coordinator and worker → worker messages are notes held for the recipient's turn boundary | The coordinator is its workers' user. A peer note never interrupts and never counts as the owner's consent |
| Depth 1: only the owner creates coordinators, a coordinator creates workers, a worker creates nothing | Teams forbid nesting, subagents cap it; deeper trees multiply cost faster than they help |
| At most 8 live (not archived) workers per coordinator, 30 crew notes per sender per hour | Server-side limits, not prompt rules (runaway fan-out and ping-pong loops are the documented failure modes) |
| Archiving or deleting a coordinator archives its workers, and an archived coordinator or worker can only read, stop and archive (a late tool call cannot start, wake or restore a dork) | Stopping a parent stops its children |
| The worker's final answer is its report | `turn_complete.finalMessageId` already names it; guidance tells workers to make it a report (outcome, PR, verification, blockers) |
| A worker's PR outcomes reach its coordinator straight from the poller | A merge or close by the token's own login (usually the owner) wakes no one on the worker's side, so no turn ends and no report follows; without this a nerd waits on a PR that merged long ago |

## Data

- `dorks.mode`: a coordinator is a dork in `nerd` mode ([modes](modes.md)). `dorks.parent_id`: the coordinator that created a worker (null
  otherwise). The `Dork` view carries `mode` and `parentId`.
- `crew_inbox`: notes and reports waiting for a dork (`dork_id`, `from_id`, `kind` `report|note`, `text`, `delivered`). The per-dork
  `crew_notify` timer (3 s, from the first row, not sliding) folds them into one `notify` command (`kinds: []`, so older bridges
  accept it) and one `crew` transcript event per row.
- Transcript events: `user_message` gains optional `from {id, title}` (a message a coordinator sent); `crew` `{direction: "in"|"out",
  peer {id, title}, kind: "report"|"note", text}` is a report or note received or sent.

## Roles and tools

`configure` carries `role: "coordinator" | "worker"` (absent for a plain dork). The bridge appends the role's guidance to the system
prompt (`infra/bridge/src/guidance.ts`) and answers the in-box MCP server's `crew.role` RPC, so `tools/list` shows only that role's
tools. A plain dork sees none of them.

| Tool | Owner (external) | Coordinator | Worker |
|---|---|---|---|
| `dork_create {message, repo?, title?, buildId?, model?, effort?, coordinator?}` | any dork, `coordinator: true` for a coordinator | a worker (child); `repo` required | no |
| `dork_list {archived?, query?}` | all dorks | its workers | its crew: coordinator and sibling workers |
| `dork_get {id}` | any | its workers | no |
| `dork_read {id, after?, limit?}` condensed transcript | any | its workers | no |
| `dork_send {id, text}` | user message | user message to a worker | note to its coordinator or a sibling |
| `dork_wait {ids, mode: any\|all, timeoutSeconds}` | any | its workers | no |
| `dork_stop {id}` interrupt the current turn | any | its workers | no |
| `dork_archive {id, archived?}` | any | its workers | no |
| `dork_delete {id}` | any | no | no |
| `build_list` | yes | yes | no |
| `build_run {id, kind}` | yes | no | no |
| `repo_list {query?}` | yes | yes | no |

A dork is **settled** when it is `idle`, `sleeping` or `error` with no unacknowledged message: the state `dork_wait` waits for and the
one `dork_get` reports as `settled: true`. `lastAnswer` is the final answer of its latest finished turn with the turn's outcome.

## Server

- `apps/server/src/services/crew.ts`: `crewCall(app, caller, tool, args)`, where `caller` is `{owner: true}` or `{dorkId}`. Every
  lookup goes through `scoped()`, which refuses (`not_found`) a dork outside the caller's crew. Reports: `append` hands each
  `turn_complete` and each `status: error` of a worker to `crewObserve`, which queues a report for its coordinator. It does the same for a worker's PR outcomes from [autonomy](autonomy.md): `pr_merged`,
  a subscription that stalls or ends as `closed`, and a `notify` carrying a `conflict` (the worker is told to fix it; the report says so).
  CI failures, reviews and comments stay with the worker, whose turn end reports how it handled them.
- External MCP: `apps/server/src/http/mcp.ts`, Streamable HTTP on `POST /mcp` of the UI listener. Plain JSON responses, no SSE.
  Answers both the 2026-07-28 stateless shape (`server/discover`, version in `_meta` / `MCP-Protocol-Version`) and the legacy
  `initialize` handshake (no session id is minted). `GET`/`DELETE` are 405. Auth is the owner bearer token (the UI API's); a browser
  `Origin` not in `DORKS_UI_ORIGINS` is 403. Results carry the text and `structuredContent`.
- Internal: bridge op `crew {tool, args}` (`services/crew.ts` with the authenticated dork as caller). One call waits at most 8 s
  (`dork_wait` loops in the box).

## Bridge

- `infra/bridge/src/mcp.ts` lists the crew tools for the role (`crew.role` RPC) and forwards calls as RPC `crew`, which the bridge
  forwards to the server op. `dork_wait` repeats 8 s waits until its timeout.
- `guidance.ts`: `COORDINATOR_GUIDANCE` and `WORKER_GUIDANCE`. A nerd writes to the owner in at most 4 short lines plus one small
  list or table; the Stop hook (`hooks.ts`, `brevityReason`) sends a coordinator's final answer over that budget back once to be cut.

## Web

In the app a coordinator is called a **nerd**: New session's mode menu starts one, and the sidebar lists it in the repository group
of the build it works on. A nerd can also read and leave notes for the owner's other sessions: [modes](modes.md), "Nerd reach".

- **Sidebar:** a nerd is a row in the repository group of the build it works on, with the dork mark in its state's colour
  ([modes](modes.md)). New session's mode menu starts one (`POST /api/dorks {mode: "nerd", message}`) and opens it. Workers have no
  rows: they live inside their nerd.
- **The dork's chat** is a normal chat (`SessionChat`) whose box asks what the dork should do next and shows no repository. Crew reports and
  notes are folded lines in the transcript ("Report from …") that open on the whole text.
- **Dork details** (`CrewDetails`) replace Chat details: **Sessions** (its workers: state, title, repository, PR), **Artifacts** (the
  screenshots and previews of the dork and every worker) and one tab per worker pull request, the PR view alone (a dork has no local
  changes). The tabs work as Chat details' do (`useOpenTabs`, remembered per dork): each closes, "+" opens a New tab that indexes the
  crew's PRs, Sessions and Artifacts, so a closed PR comes back from there. No Files or Computer: a dork has neither.
- **A worker opens in place**, inside Sessions: a full-width bar (its state and title; open full screen, stop, archive, close) over its
  chat, which the owner can talk in.
- **Full screen** is the worker's own page with its own Chat details. The header starts with a crumb back to the dork, and the sidebar
  keeps the dork highlighted, so the top session is never lost.
- Below `lg` details are hidden, as for every chat; a report's **Open session** still reaches its worker full screen.

## Connect an external agent

```sh
claude mcp add --transport http dorks http://127.0.0.1:4747/mcp --header "Authorization: Bearer $DORKS_OWNER_TOKEN"
```

The token is the owner token (`<data dir>/secrets.json`, or `dev-owner-token` under `pnpm dev`). Keep it out of shared config.

## Not yet

- Per-worker budgets (Devin's ACU limit): there is no spend signal to cap on yet.
- A shared task list (agent teams). The coordinator keeps its plan in its own turns for now.
- Structured output schemas on `dork_create`.
- The MCP Tasks extension for `dork_wait`.
  the transcript shows crew reports and notes.
