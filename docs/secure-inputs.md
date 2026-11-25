# Secure inputs: values an agent uses without reading

An agent sometimes needs something only the owner has: a login, a password, a one-time code, an API key. Pasting it into the chat
puts it in the transcript and the model's context for good. A secure input lets the agent **use** such a value without ever **reading**
it: the owner types it into a form in the chat, and the agent only holds a reference, `{{secret:NAME}}`.

Claude Code agents only: the value is filled in and hidden by Claude Code hooks, which the other agents do not have. A request from
another agent is refused with a message saying so.

## Flow

1. The agent calls `input_request {title, description?, fields}` (dorks MCP server, `infra/bridge/src/mcp.ts`). Each field has a `name`
   (what goes in `{{secret:NAME}}`), a `label`, a `kind` (`text`, `email`, `secret`: masked with a show button, `otp`: a one-time
   code), and optionally a `description` and `optional: true`. At most 8 fields.
2. The server (`apps/server/src/services/inputs.ts`) stores an `input_requests` row and appends an `input_request` event. The chat shows a
   form (`apps/web/src/components/InputRequest.tsx`): Continue, Dismiss, and "Claude can use these but never sees them".
3. The tool waits (bridge op `input`, `action: "wait"`, polled in 8 s steps for up to 5 minutes; `input_wait` continues). An unanswered
   request expires after 30 minutes (a durable `input:<id>` timer). One request at a time per session.
4. The owner submits: `POST /api/dorks/:id/inputs/:requestId {values}` (or `{dismiss: true}`). Each value is encrypted (AES-GCM, additional
   data binds it to the session and the name) into `input_values`, one row per name per session: asking again under a name replaces
   its value (a fresh one-time code). The `input_response` event lists the names, never a value.
5. The tool returns the names and their references. The bridge fetches the values (`action: "values"`, over its authenticated socket) and
   keeps them in memory only; it fetches them again on every `configure` (after a wake or a restart) and for a name it does not know yet.

## How a value is used without being read

Claude Code's hooks run the bridge (`infra/bridge/src/inputs.ts`, through `dorks hook`) around every tool call:

- **PreToolUse** replaces each `{{secret:NAME}}` in the tool's input with the value, in the input the tool runs with (`updatedInput`).
  The model keeps the input it wrote, so the transcript and its context show the reference. In a Bash command a reference becomes
  `${DORKS_SECRET_NAME}`, with an `export` of the shell-quoted value in front, so any value survives the shell exactly as typed; the
  agent puts it where a variable expands (bare or in double quotes, not single quotes). In any other tool (a browser's text to type,
  a file to write, an MCP tool's arguments) it is the value itself. The dorks MCP tools are left alone. A reference to a name with no
  value stops the call, telling the agent to ask for it.
- **PostToolUse** replaces the value, and its base64, base64url, URL-encoded and JSON-escaped forms, with `[redacted]` in every tool's
  output (`updatedToolOutput`) before the model sees it: a value echoed, written to a file and read back, or printed by a server. A
  base64 token that decodes to text holding a value is redacted whole (a Basic authorization header encodes `user:password`). A value
  replaced under the same name stays redacted for as long as the bridge runs, since the old one may still sit in a file or a log.
- The bridge scrubs the same forms from every event it sends (the transcript) and from its logs.

Values are never in the agent's environment, a file the bridge writes, the CLI's config, an event, a server log, or a UI API response.

## What it does not protect against

The guarantee is that the value never enters the model's context or the transcript by accident. A command that has the value can
still do anything with it: send it somewhere, or transform it in a way the redaction does not catch (reversed, hashed, split up).
Such a command is visible in the chat with its reference in it. Prompt injection that steers the agent into such a command is the
residual risk, as with any credential an agent can use. Values shorter than 4 characters are not redacted.

## API

| Where | What |
|---|---|
| Bridge op `input` | `{action: "request", title, description?, fields}` → `{requestId, status}`; `{action: "wait", requestId, waitMs?}` → `{requestId, status, names?, refs?}`; `{action: "values"}` → `{values: {name: value}}` (the bridge only). `status`: `pending`, `provided`, `dismissed`, `expired`. Errors `conflict` (one already waiting), `invalid` (not Claude, bad fields) |
| `POST /api/dorks/:id/inputs/:requestId` | `{values: {name: value}}` or `{dismiss: true}` → `{}`. `invalid` for a missing required field or an unknown one, `conflict` once answered or expired |

Events: `input_request` (`requestId, title, description?, fields`), `input_response` (`requestId, status, names?`). A pending request
counts as the session needing attention.
