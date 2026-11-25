# Modes: chat, code and nerd

Status: first cut. Every dork has a **mode** that decides what kind of session it is: its instructions, its hooks and the in-box tools it
is offered. One table (`packages/shared/src/modes.ts`) declares what each mode changes; the server, the bridge and the app all read it.

| | **Chat** | **Code** | **Nerd** |
|---|---|---|---|
| For | Talking, writing, research, analysis, help with the owner's own computer | Work in a repository that ships as pull requests | Planning a goal and running other sessions to reach it ([crews](crew.md)) |
| Repository | None: it starts in an empty work directory | Required (`owner/name`) | None |
| Instructions (Claude) | `--system-prompt`: the chat prompt in place of Claude Code's own, which is written for coding (`CHAT_SYSTEM_PROMPT`, `infra/bridge/src/guidance.ts`), plus the skills guidance | Claude Code's prompt plus the final-answer and skills guidance | Code's, plus the coordinator guidance |
| Autonomy hooks | Off: no Stop gate, no PR subscription context at session start | On | On |
| `dorks` MCP tools | Everything but `pr_subscribe`, `pr_unsubscribe`, `pr_list` | All | All, plus the coordinator's crew tools |
| Shell, files, web, desktop, local access (`local_run`, `local_read`) | Yes | Yes | Yes |
| The owner's MCP servers and skills | Yes | Yes | Yes |
| Model | The owner's choice, as in every mode | | |

Other agents (OpenCode, Antigravity) get the chat prompt as their system prompt in a chat; Codex gets no mode-specific instructions.

## Choices

| Choice | Why |
|---|---|
| A mode is a field of the dork, not a separate product or app | One engine (sandbox, lifecycle, transcript, artifacts) serves all three; a mode only changes what the agent is told and offered |
| Chat keeps the whole machine, including local access | The owner wants a chat that can fix something on their own computer, run code to answer, and make things, not a plain chat window |
| Chat replaces Claude Code's system prompt instead of appending to it | Appended guidance cannot undo a coding persona; tool descriptions carry the tool usage either way |
| Connectors and skills are the same in every mode | The owner's own tools belong to the owner, not to a mode |
| No model default per mode | The owner picks the model, as before |
| The mode can be switched on a live session | The bridge restarts the agent on the same session with the new flags once the turn ends, as for a model change. A worker keeps its coordinator's mode; a nerd with live workers stays one until they are archived |
| One sandbox per chat for now | The lifecycle is one box per dork. A shared "home" box for chats is a later step, once there is enough use to know it is needed |

## Nerd reach

A nerd steers, stops and archives only the workers it started. Beyond its crew it may:

- list the owner's other sessions (`dork_list` with `all: true`, marked `[other]`),
- read them (`dork_get`, `dork_read`),
- leave one a note (`dork_send`): delivered at that session's next turn boundary, as information from another agent, never as the
  owner's instruction or consent (rate-limited like worker notes).

Its guidance tells it to prefer the sessions it started and never take over another session's task. It can start chat workers
(`dork_create` with `mode: chat`, no repo) as well as code workers.

## Wire

- `dorks.mode` (`chat | code | nerd`, default `code`) replaced `dorks.kind`; a former coordinator is a nerd. The `Dork` view and `CrewDork`
  carry `mode`.
- `POST /api/dorks` takes `mode` (the older `kind: "coordinator"` still means nerd); only `code` requires `repo`.
  `POST /api/dorks/:id/mode {mode}` switches it.
- `configure` carries `mode` (absent from an older server: code). The bridge answers `crew.role` with `{role, mode}` so the in-box MCP
  server lists the right tools, and the hooks skip the Stop gate and session-start context in a chat.

## App

- The composer's bar starts with the mode menu (`ModeMenu`). A new session remembers the mode picked last; one opened from a repository's
  `+` is a code session. In chat and nerd mode the repository chooser goes away.
- The sidebar shows **Nerds** and **Chats** groups (when there are any) above the repositories.
