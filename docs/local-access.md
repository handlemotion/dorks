# Local access: agents asking to use your computer

Agents run in cloud sandboxes, but the Dorks server runs on your own computer (the desktop app's sidecar). Local access lets an
agent ask that server to run one command or read one text file **on your computer**, for things that only exist there: a CLI
signed in to your accounts, a local-only service, simulators and devices, a file outside the repo. Nothing runs without your answer.

## Why this shape

The server is already on the machine and already speaks an authenticated protocol to every sandbox (the bridge). So an agent's
request travels the path everything else does: MCP tool in the box → bridge (Unix socket) → bridge WebSocket (per-dork HMAC) → server.
The server stores the request, shows it in the chat, and runs it only after you allow it. No new listener, port or credential is
exposed, and the sandbox never gets a shell on your computer: it gets back the output of what you approved.

A full "local session" mode (the agent itself running on the Mac) was not chosen: it would hand the agent your whole machine for the
whole session, where this gives it one approved command at a time.

## Flow

1. The agent calls `local_run {command, cwd?, reason, timeoutSeconds?}` or `local_read {path, reason}` (dorks MCP server,
   `infra/bridge/src/mcp.ts`). The bridge forwards it as the `local` op (`action: "request"`).
2. The server (`apps/server/src/services/local.ts`) records a `local_requests` row and appends a `local_request` event. The chat shows
   a card with the exact command and folder (or path), the agent's reason, and **Allow once**, **Allow for 1 hour**, **Deny**.
3. The tool waits (the `local` op with `action: "wait"`, polled in 8 s steps for up to 5 minutes; `local_wait` continues). An
   unanswered request expires after 10 minutes (a durable `local:<id>` timer).
4. Allowed: the server runs the command in your login shell (`$SHELL -lc`, stdin closed, no TTY, Homebrew paths added) in that
   folder, kills its process group at the time limit (default 120 s, at most 600 s), and returns the start and end of the output
   (16 KB + 48 KB). A read returns up to 256 KB of a text file. The card shows the result folded under Output.

## Permission model

- **Default:** ask every time. Settings, Your computer can turn it **Off**: agents are told it is off, every permission ends and
  whatever is waiting is declined.
- **One at a time:** a session cannot ask again while a request is waiting.
- **Allow for 1 hour** is scoped to the session that asked and to exactly that thing: for a command, the same command text in the
  same folder; for a read, files under that file's folder as resolved on disk (symlinks followed, so a link cannot widen it).
  Anything else asks again. Grants are listed in Settings, Your computer, and on their card, with **Stop**.
- **Never shared:** files under the Dorks data directory (its keys and database), binary files. The command's environment drops the
  server's own variables (`DORKS_*`, `CLAUDE_CODE_*`, `ANTHROPIC_*`, `BOAT_*`, `GH_TOKEN`, `GITHUB_TOKEN`, ...).
- **Audit:** every request, answer and result is an event in the chat's transcript.
- A command you allow runs with your permissions. Read it: the card shows it verbatim, and the agent's reason is labelled as its own words.

## API

| Where | What |
|---|---|
| Bridge op `local` | `{action: "request", kind: "run"\|"read", command?, cwd?, path?, reason, timeoutSeconds?}` → `{requestId, kind, status}`; `{action: "wait", requestId, waitMs?}` → `{requestId, kind, status, exitCode?, output?, truncated?, error?}`. `status`: `pending`, `running`, `denied`, `expired`, `done`, `failed`. Errors `forbidden` (turned off), `conflict` (one already waiting) |
| `POST /api/dorks/:id/local/:requestId` | `{decision: "once"\|"deny"}` or `{decision: "grant", minutes: 15\|60}` |
| `GET /api/local-access` | `{enabled, grants: LocalGrant[]}` (active grants) |
| `PUT /api/local-access` | `{enabled}` |
| `DELETE /api/local-access/grants[/:grantId]` | revoke one, or all (`?dork=` for one session's) |

Events: `local_request`, `local_decision` (`allowed` via `once`/`grant`/`standing`, `denied`, `expired`), `local_result`. Grant and
switch changes publish the `settings` live message.
