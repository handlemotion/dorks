# Local access: agents asking to use your computer

Agents run in cloud sandboxes, but the Dorks server runs on your own computer (the desktop app's sidecar). Local access lets an
agent ask that server to run one command or read one text file **on your computer**, for things that only exist there: a CLI
signed in to your accounts, a local-only service, simulators and devices, a file outside the repo. You are asked once per session
whether it may access your computer; nothing runs before you allow it.

## Why this shape

The server is already on the machine and already speaks an authenticated protocol to every sandbox (the bridge). So an agent's
request travels the path everything else does: MCP tool in the box → bridge (Unix socket) → bridge WebSocket (per-dork HMAC) → server.
The server stores the request, shows it in the chat, and runs it only once you allowed the session. No new listener, port or
credential is exposed, and the sandbox never gets a shell on your computer: it gets back the output of each command it ran.

A full "local session" mode (the agent itself running on the Mac) was not chosen: it would hand the agent your whole machine for the
whole session, where this gives it one command at a time, each one in the chat.

Asking for every command was tried first and was too much: the owner approved the same kind of command over and over. So the
question is "may this session use my computer?", answered once.

## Flow

1. The agent calls `local_run {command, cwd?, reason, timeoutSeconds?}` or `local_read {path, reason}` (dorks MCP server,
   `infra/bridge/src/mcp.ts`). The bridge forwards it as the `local` op (`action: "request"`).
2. The server (`apps/server/src/services/local.ts`) records a `local_requests` row and appends a `local_request` event. If the session
   is already allowed (or Always allow is on), it starts right away. Otherwise the chat shows one compact card: "Claude wants to
   access your computer", the agent's reason, the first command (or path), and **Allow for this session**, **Always allow**, **Deny**.
3. The tool waits (the `local` op with `action: "wait"`, polled in 8 s steps for up to 5 minutes; `local_wait` continues). An
   unanswered request expires after 10 minutes (a durable `local:<id>` timer).
4. Allowed: the server runs the command in your login shell (`$SHELL -lc`, stdin closed, no TTY, Homebrew paths added) in that
   folder, kills its process group at the time limit (default 120 s, at most 600 s), and returns the start and end of the output
   (16 KB + 48 KB). A read returns up to 256 KB of a text file. Each command is one line in the chat ("Ran on your computer:
   `cmd`") whose output folds open under it.

## Permission model

- **Default:** a session asks once. **Allow for this session** lets every later request of that session (dork) run without asking
  (`dorks.local_allowed_at`). **Always allow** turns on the `localAlwaysAllow` setting: no session asks again, and a request another
  session is waiting on runs too.
- **Settings, Your computer:** "Allow sessions to access this computer without asking" is the `localAlwaysAllow` switch. Turning it
  off makes new sessions ask again; sessions you already allowed keep their permission (listed under Allowed sessions, with **Stop**).
  **Agents can ask: Off** tells agents it is off, ends every permission (each session's and Always allow) and declines whatever is waiting.
- **One at a time:** a session cannot ask again while a request is waiting.
- **Never shared:** files under the Dorks data directory (its keys and database, resolved on disk so a symlink cannot reach it), binary
  files. The command's environment drops the server's own variables (`DORKS_*`, `CLAUDE_CODE_*`, `ANTHROPIC_*`, `BOAT_*`, `GH_TOKEN`,
  `GITHUB_TOKEN`, ...).
- **Audit:** every request, answer and result is an event in the chat's transcript.
- A command runs with your permissions. Allowing a session lets its agent run any command as you until the session ends or you stop it.

## API

| Where | What |
|---|---|
| Bridge op `local` | `{action: "request", kind: "run"\|"read", command?, cwd?, path?, reason, timeoutSeconds?}` → `{requestId, kind, status}`; `{action: "wait", requestId, waitMs?}` → `{requestId, kind, status, exitCode?, output?, truncated?, error?}`. `status`: `pending`, `running`, `denied`, `expired`, `done`, `failed`. Errors `forbidden` (turned off), `conflict` (one already waiting) |
| `POST /api/dorks/:id/local/:requestId` | `{decision: "session"\|"always"\|"deny"}` |
| `GET /api/local-access` | `{enabled, sessions: [{dorkId, dorkTitle, allowedAt}]}` (the sessions allowed) |
| `PUT /api/local-access` | `{enabled}` |
| `GET/PUT /api/settings` | `localAlwaysAllow` (Always allow) |
| `DELETE /api/local-access/sessions[?dork=]` | stop one session's permission (`?dork=`), or every session's |

Events: `local_request`, `local_decision` (`allowed` via `session`/`always` when the owner answered, `standing` when an earlier answer
covered it; `once`/`grant` in transcripts from the per-command version; `denied`, `expired`), `local_result`. Permission and switch
changes publish the `settings` live message.
