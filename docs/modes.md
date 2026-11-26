# Modes: code and nerd

Every dork has a **mode** that decides what kind of session it is: its instructions and the crew tools it is offered. One table
(`packages/shared/src/modes.ts`) declares what each mode changes; the server, the bridge and the app all read it.

| | **Code** | **Nerd** |
|---|---|---|
| For | Work in a repository that ships as pull requests | Planning a goal and running other sessions to reach it ([crews](crew.md)) |
| Repository | Required (`owner/name`) | None |
| Instructions (Claude) | Claude Code's prompt plus the final-answer and skills guidance | Code's, plus the coordinator guidance |
| Autonomy hooks and `dorks` MCP tools | All | All, plus the coordinator's crew tools |
| Shell, files, web, desktop, local access (`local_run`, `local_read`) | Yes | Yes |
| The owner's MCP servers and skills | Yes | Yes |
| Model | The owner's choice, as in every mode | |

There was a third mode, **chat** (a general assistant with no repository and its own system prompt). It is retired: code and nerd cover
the work. A migration turned every chat into a code session with no repository (it stays in the sidebar, under Other) and every chat
automation into a paused code one, since its triggers may name no repository yet. A bridge or an export that still says `chat` reads it
as code (`dorkModeOf`).

## Choices

| Choice | Why |
|---|---|
| A mode is a field of the dork, not a separate product or app | One engine (sandbox, lifecycle, transcript, artifacts) serves both; a mode only changes what the agent is told and offered |
| Connectors and skills are the same in every mode | The owner's own tools belong to the owner, not to a mode |
| No model default per mode | The owner picks the model, as before |
| The mode can be switched on a live session | The bridge restarts the agent on the same session with the new flags once the turn ends, as for a model change. A worker keeps its coordinator's mode; a nerd with live workers stays one until they are archived |

## Nerd reach

A nerd steers, stops and archives only the workers it started. Beyond its crew it may:

- list the owner's other sessions (`dork_list` with `all: true`, marked `[other]`),
- read them (`dork_get`, `dork_read`),
- leave one a note (`dork_send`): delivered at that session's next turn boundary, as information from another agent, never as the
  owner's instruction or consent (rate-limited like worker notes).

Its guidance tells it to prefer the sessions it started and never take over another session's task. Its workers are code sessions, each
in a repository.

## Wire

- `dorks.mode` (`code | nerd`, default `code`) replaced `dorks.kind`; a former coordinator is a nerd. The `Dork` view and `CrewDork`
  carry `mode`.
- `POST /api/dorks` takes `mode` (the older `kind: "coordinator"` still means nerd); only `code` requires `repo`.
  `POST /api/dorks/:id/mode {mode}` switches it.
- `configure` carries `mode` (absent from an older server: code). The bridge answers `crew.role` with `{role, mode}`.

## App

- There is no mode menu: where a session starts sets its mode. New session starts a code session; the Nerds group's `+` (shown even
  while there are none) starts a nerd. In nerd mode the repository chooser goes away and the session starts on the owner's default build
  (`buildId` omitted, so the server's fallback applies, a build without repositories included); a nerd's workers start on its build. An
  open session's bar names its build (or the base machine), not its repository.
- The sidebar lists the nerds in a group of their own, then the code sessions by repository. A nerd wears the dork mark in its state's
  colour, like any session: the Nerds group sets it apart.
- On mobile, a new session with no repository chosen is a nerd.
