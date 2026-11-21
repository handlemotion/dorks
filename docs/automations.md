# Automations

Status: **implemented**. Code: `apps/server/src/services/automations.ts` (definitions, schedules, runs), `automationWatch.ts` (the
repository watcher), `lib/schedule.ts` (time zones), `apps/web/src/routes/_conn/_app/automations.tsx` (the pages),
`apps/web/src/components/automations/` (the trigger editor and templates). Wire types: `packages/shared/src/automations.ts`.

An **automation** is instructions an agent runs on its own: on a schedule, or when something happens in a repository. Every run starts
an ordinary session (a dork) with the instructions, then a short note on what started it. Nothing about the session is special: it shows
in the sidebar, sleeps, wakes, opens pull requests and is archived like any other.

## Triggers

An automation has one to ten triggers; any of them starts a run. Each names the repository the session starts in.

| Trigger | Fires | The agent is told |
|---|---|---|
| Schedule (`every`: `hour`, `day`, `weekdays`, `week` with `day`; `time` `HH:MM`; an IANA `timezone`; `repo`; optional `branch`) | At the wall-clock time in its zone, daylight saving included | The schedule, and the branch to start from |
| `pr_opened` | A pull request opened | The PR's number, title, author, URL, branch and base |
| `pr_pushed` | New commits on an open pull request (its head changed) | Same |
| `pr_merged` | A pull request merged | Same |
| `issue_opened` | An issue opened (pull requests left out) | The issue and its text, quoted as the author's, not the owner's |
| `comment` | A conversation comment on an issue or pull request | The comment, quoted the same way |

GitHub triggers take `authors`: only events by these logins (the PR's or issue's author, the comment's writer). Empty means anyone.

**Run now** runs it once by hand in the first trigger's repository, whether or not it is active. A refusal (Claude not connected, a
build not built) is shown where the owner clicked; a refused automatic run is recorded in the history as failed, with the reason.

## Schedules

One `automation:<id>` job per active automation with a schedule, due at its next time (`lib/schedule.ts` `nextFire`). The automation
keeps `sched_from`, the time its schedules were last evaluated from; when the job runs, every schedule whose next time after `sched_from`
has passed starts one run, then `sched_from` moves to now and the job is set for the next time. So a time missed while the app was closed
runs once when it is back, never once per missed time. Saving the automation evaluates from the moment of the save.

## The repository watcher

No webhooks, as for PRs ([autonomy](autonomy.md)): one `automation-watch` job reads, every minute, each repository an active automation
watches, as the GitHub CLI's login. It asks only for what its triggers need, with conditional requests (a 304 is free against the rate
limit): the repository (to learn whether it is public), `pulls?state=all&sort=updated` (opens, pushes, merges), `issues?sort=created`
(new issues) and `issues/comments?sort=created` (new comments). Cursors are GitHub's own timestamps, so the local clock never matters.

The first read of a list is its **baseline**: nothing that happened before an automation watched it starts a run. Each event has a key
(`pr_pushed:12@<sha>`, `comment:<id>`); `automation_runs` has a unique `(automation_id, event_key)`, so an event starts at most one
run per automation. The watcher state per repository is `automation_watch` (ETags, cursors, open PRs' heads, reported merges, whether it
is public, and why it could not be read). A repository the login cannot see is shown on its automations.

## Guards

Automations act without the owner watching, so they are fenced:

- **Public repositories:** anyone can open an issue or comment there, and the agent reads that text. On a public repository (or one whose
  visibility is unknown) only events by listed `authors` start runs. The page says so on an automation that would otherwise listen to
  anyone.
- **Own comments:** sessions comment as the owner's GitHub login, so that login's comments never start a `comment` run.
- **Own pull requests:** a pull request on a branch one of the automation's own sessions works on never starts a run of it.
- **Own pushes:** a push to a pull request the automation ran on in the last 10 minutes, or whose session is still working, is skipped.
- **Hourly cap:** past 20 started runs in an hour, further automatic runs are recorded as skipped.
- Untrusted text (issue bodies, comments) is quoted to the agent, at most 2,000 characters, and labelled as not the owner's.

## Data model

Migration 16 (`apps/server/src/migrations.ts`): `automations` (`name` unique case-insensitively, `enabled`, `triggers` JSON, `instructions`,
`model`, `effort`, `build_id` → `builds` `ON DELETE SET NULL`, `sched_from`), `automation_runs` (`source`, `event_key`, `summary`,
`url`, `repo`, `number`, `dork_id`, `status` `started`/`failed`/`skipped`, `error`; the last 100 per automation are kept) and
`automation_watch`. Deleting an automation deletes its runs; the sessions they started stay.

Limits: 50 automations, 10 triggers each, 20 logins per trigger, 20,000 characters of instructions.

## UI and API

`/automations` lists automations (status, triggers, last run) and templates; `?automation=new[&template=<id>]` creates one;
`?automation=<id>` is its settings (status facts, name, Active, triggers as sentences with inline choices, instructions with the model
and machine sessions use, Delete) and `&tab=runs` its run history, each run linking to its session and to the PR, issue or comment.

| Method and path | Body | Result |
|---|---|---|
| `GET /api/automations` | | `AutomationView[]` by name |
| `POST /api/automations` | `AutomationInput`: `{name, enabled?, triggers, instructions, model?, effort?, buildId?}` | `{id}` |
| `GET /api/automations/:id` | | `AutomationView`: the definition, `nextRunAt`, `lastRun`, `recentRuns` (7 days), `problems`, `publicRepos` |
| `PATCH /api/automations/:id` | any of `AutomationInput`, merged over the saved one (`{enabled}` pauses or resumes) | `{}` |
| `DELETE /api/automations/:id` | | `{}` |
| `GET /api/automations/:id/runs` | | the last 50 `AutomationRunView`s, newest first, each with its session (`null` once deleted) |
| `POST /api/automations/:id/runs` | | `AutomationRunView`: Run now |

Live: `{"t":"automations"}` whenever an automation, a run or a watched repository's state changes; refetch what you show.

The mock server (`pnpm dev:mock`) keeps automations in memory and supports Run now; schedules and events need the real server.
