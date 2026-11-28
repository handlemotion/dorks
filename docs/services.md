# Services and live verification

Status: **accepted and implemented**. Code: `packages/shared/src/builds.ts` (`buildService`), `apps/server/src/services/builds.ts` and
`buildRuns.ts` (spec, build-time check), `infra/bridge/src/services.ts` (on-demand start), `infra/bridge/src/mcp.ts` (`service_*` tools),
`infra/bridge/src/verify.ts` and `hooks.ts` (the verify gate), `apps/web/src/components/builds/Services.tsx`.

An agent should test a change against the real running software (the dev server, the API, the database), not only with unit tests or
mocks. Two things make that fast and expected:

1. **Services**: a build names its dev servers and backing services. The build starts each once, checks it and warms its caches, so the
   image holds everything a start needs. Nothing starts at boot; the agent starts one with `service_start` when it needs it, and it is up in
   seconds.
2. **Live verification**: a Stop-hook gate. When a turn changed code, Haiku judges from the turn's tool calls whether the agent
   exercised the change against running software. If not, the agent is sent back once with what to start and what to exercise.

## What Boat offers (researched 2026-11)

From the Boat docs ([snapshots](https://docs.boat.dev/snapshots), [long-running tasks](https://docs.boat.dev/long-running-tasks),
[setup](https://docs.boat.dev/setup), [hosting](https://docs.boat.dev/hosting)):

| Boat primitive | What it gives | Used here |
|---|---|---|
| Saved snapshot ("template sandbox") | Files, installed packages, system setup. **Not running processes or memory.** Deploys in seconds whatever the template holds | **Yes**: the build's image holds installed deps, compiled caches and Docker images |
| Resume / restore | Behaves like a reboot: **enabled systemd units start again**, processes started by hand do not | No autostart (asked for): units are not used. The agent starts services itself |
| Docker | Images and named volumes are kept; containers are recreated; **the build cache (`/var/lib/docker`) is not captured** | A `docker compose up db` service works; `docker pull` in the setup script lands in the image |
| Playbook warming (`.ascii/playbook.json`) | Files opened while a sandbox *starts from a snapshot* are fetched first next time | Not used: a build sandbox starts from the base snapshot and runs for minutes, so it would record the setup, not a service start |
| Repository setup scripts | Run at **every sandbox start**, before or beside it being ready | Not used: Dorks clones itself and runs setup once at build time (docs/builds.md) |
| `host <port>` | A stable HTTPS URL for a listening port | Already used by `preview_show` |

So there is no way to snapshot a running dev server. What can be prebuilt is everything up to the process: dependencies, compiled
output, bundler caches (Vite's `node_modules/.vite`, Next.js' `.next/cache`), pulled images, migrated databases on disk. A
service's start in a session is then a warm start.

## Services

A build's spec gains `services`: at most 10 of `{name, command, cwd?, port?, preview?}` (`cwd` under `~/work`, `preview` needs a port).
They are part of the spec hash, so the owner approves them like the setup script; a build with none keeps the hash it had before
services existed (no image goes stale on upgrade). Agents propose them with `machine_draft` `services`; the owner edits them on
the build's page (Services) and reviews an agent's change on the draft review.

**At build time** (`buildRuns.ts`, after the setup and repo scripts, same run script, same build-time variables): each service runs
through `service-check`: started in its own process group from its directory, waited on until its port listens (`ss`, any address)
or, without a port, until it has run for 5 s; its first page is requested (`curl localhost:<port>/`, which is when dev servers
compile), then the whole group is stopped. Up to 300 s per service. A service that exits or never listens fails the run with its last
30 lines of output, so a broken dev server is caught at build time, not in a session.

**In a session** (`infra/bridge/src/services.ts`): `configure` carries the build's services. The `service_*` MCP tools reach the bridge's
`service` RPC:

| Tool | What it does |
|---|---|
| `service_list` | The build's services (and ad hoc ones) with state, port, log path |
| `service_start` | Starts one by name and waits (default 120 s) until its port accepts connections on 127.0.0.1 or ::1; a `preview` service then opens in the owner's Artifacts (`preview_show`). Already running: returns at once (`restart: true` restarts). A new name with `command`/`port`/`cwd` starts any other server the same way. Refused when another process already holds the port |
| `service_logs` | The end of its log |
| `service_stop` | Stops its whole process group |

A service runs as the agent's user (`CLAUDE_RUN_AS`) with the agent's environment, detached in its own process group. Its shell
writes its own log to `/tmp/dorks-services/<name>.log`, as that user: the bridge (root under privilege separation) never opens a
file there for writing, and reads one only with `O_NOFOLLOW` when that user owns it. Services die with the box when it sleeps; the
next `service_start` starts them again from the warm disk.

The SessionStart context lists the build's services ("installed and warmed but not running") and asks for a live test of every change.

## Live verification (the verify gate)

Part of the Stop hook (docs/autonomy.md). Claude sessions only (the provider tested live); not for a crew coordinator.

- **What it sees.** The bridge reads every tool call on Claude's stream (`TurnActivity`, `verify.ts`) and the services it started,
  plus the turn's request. A Stop hook's own input carries only the final message, which is why the bridge collects this itself.
- **When it runs.** At Stop, if the turn changed code: a working tree differs from when the last turn ended (HEAD, status and diff
  hashed per repo), or an edit tool ran. A question, a review or a plan changes nothing and costs nothing.
- **The judge.** Haiku, beside the agent and outside its session (`claude -p --model haiku`, no tools, settings, MCP or transcript, as the
  dork's title is made), gets the request, the numbered tool calls, the changed files, the services and the final message, and answers
  `not_applicable` (docs, config, tests, types, no code change), `verified` (after the last edit the agent ran the program and exercised
  the change: requests to the endpoints, the page in a browser or a screenshot, the CLI on real input; or it states a concrete reason it
  cannot run here), or `needs_live_test` with one sentence of what to start and exercise. Unit tests, typecheck, mocks, jsdom and Vitest
  or Jest runs alone are not verification. Typical answer: 2 to 4 s; capped at 40 s inside the hook's 60 s.
- **The block.** `needs_live_test` blocks the stop with that sentence and how to do it here (`service_start` for this build's services,
  `preview_show` and `screenshot_share` for UI, curl for a backend, say what is missing if it cannot run). Together with the ship
  gate's reason when both apply: test first, then ship. Once per turn: the continuation (`stop_hook_active`) is never blocked again.
- **Fallback.** No usable answer from the judge: a live-looking step after the last edit (a `service_*`/preview/screenshot/browser tool,
  or curl and the like against localhost) lets it stop, otherwise it blocks once.

Measured with the real Claude CLI and Haiku: a unit-test-only fix, a UI screenshotted before its last edit, a curl-verified API fix and
a README edit were judged `needs_live_test`, `needs_live_test`, `verified` and `not_applicable`. In whole-stack sessions (real bridge, real
Claude) the SessionStart line alone already had agents start the build's service or the server and curl the changed endpoint before
stopping; the gate is the backstop.

## Twin Engine: A/B on the box (Dorks Teams)

The **Validation Engine** is the testing above: the agent starts the build's services and exercises its change before it stops. The
**Twin Engine** (dorks-cloud docs/prod-like-testing.md) adds production's shape: a database branch of scrubbed production as
`DATABASE_URL`, and per-box traces (`SENTRY_DSN`, `SENTRY_ENVIRONMENT=box-<session id>`, `SENTRY_TRACES_SAMPLE_RATE`,
`TWIN_ENGINE_SPAN_BUDGET` from configure). On top of those, two agent tools in the bridge:

- `telemetry_query` (`dorks telemetry`): this box's own errors, spans, per-route p95 and span usage, read by the server from Sentry under
  the box's environment only.
- `prodlike_run` (`dorks prodlike run`; `infra/bridge/src/prodlike.ts`): checks out the PR's base and head as worktrees, starts each
  in turn on the same port, box and branch, replays the repository's load scripts, and reports both halves to the server. The server
  compares them and posts the `Dorks / Twin Engine` check on the head commit. The repository describes the run in
  `.dorks/prodlike.json` (`service`, `setup`, `seed`, `migrate`, `load`, `rounds`, `requests`, `concurrency`), and the load in
  `.dorks/load/*.mjs` (a weighted request list or a function). Only GET and HEAD are sent unless the team allows writes.

Dorks Teams includes a monthly allowance for these prod-like checks ([cloud](cloud.md), "Plans"): 1,000,000 spans and 1,000 error
events sent to Dorks' Sentry, and, when Dorks hosts the org's Neon data, 2 GB and 20 compute hours. Past a limit that part pauses
until the 1st of next month (UTC), and nothing is billed extra; the setup and traces views carry the month's usage as `allowance`.
