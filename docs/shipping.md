# Shipping

Status: **v1 implemented** (watching and the Ship card). v2 and v3 below are the plan, not built yet.

Code: `apps/server/src/services/ships.ts` (the tracker), `services/poller.ts` (runs it each pass), `services/githubIngest.ts`
(`onClosed` starts a ship), `apps/web/src/components/ShipCard.tsx` (the card). Wire types: `packages/shared/src/ship.ts`.

A merged pull request is not a shipped one. The build on the base branch can fail, a migration can break, a deploy can hang, and
before this nobody was looking: the PR subscription ended at the merge ([autonomy](autonomy.md)). A **ship** picks up where the
subscription stops. It follows the merge commit until what it set off has finished, and the chat shows it as one card under
`PR #N merged`.

## What is watched (v1)

When the poller sees a session's PR merge into the repository's **default branch** (`pr_closed` with `merge_commit_sha`; a stacked
PR merging into its parent's branch is not a release), `startShip` inserts a `ships` row for that PR and session (once per PR per
session, linked to its subscription) and appends a `ship` event. The box is not involved and is not woken: the server watches
while the sandbox sleeps.

Every poll pass (10 s) for the first 10 minutes, then every 30 s (`shipDue`), for each open ship, with conditional requests (a 304 is free against the rate limit), as the GitHub CLI's login:

| Read | Becomes |
|---|---|
| `GET /repos/:r/actions/runs?head_sha=<merge>` | One `workflow` stage per run (at most 15), leaving out `pull_request*` runs: a rebase merge keeps the PR's commits, and their PR runs are not the merge's. A **cancelled** run (a newer push cancelled it, `concurrency: cancel-in-progress`) is followed to the first later run of the same workflow on the base whose commit contains the merge (`/actions/workflows/:id/runs`), shown as `with <sha>` |
| `GET /actions/runs/:id/jobs` per run, until every job is seen completed | A `migration` stage for each job whose name matches `/migrat/i`, else for each such step |
| `GET /commits/<merge>/check-runs` | A `check` stage per check run by name from any app other than GitHub Actions (Cloudflare Pages, Vercel, Netlify...) |
| `GET /commits/<merge>/status` | A `status` stage per commit status context |
| `GET /deployments?sha=<merge>` and `GET /deployments` (recent) | One `deployment` stage per environment: the newest deployment that **contains** the merge, remembered so it is still followed after newer deployments push it off the recent page. A later commit's deployment counts when `GET /compare/<merge>...<sha>` says `ahead` or `identical` (a deploy that batched several merges); it says `with <sha>`. A branch preview (`diverged`) never counts. Its latest status gives the state and `environment_url` |

Ancestry answers (`GET /compare/<merge>...<sha>`, at most 3 new ones a pass) are remembered per ship. A read that fails (other than a
rate limit or a rejected token, which stop the pass like the PR poller) keeps what it showed last time. Bodies are kept with their ETags in `ships.poll`, so a 304 rebuilds the same stages.

### Status

`decide` in `ships.ts`, a pure function of the stages and the clock:

| Status | When | Watch ends |
|---|---|---|
| `watching` | Something is pending or running, or everything finished less than `SHIP_SETTLE_MS` (1 min) ago: a deploy workflow that CI starts appears in that gap | no |
| `shipped` | Everything finished, nothing failed, and the settle minute passed | yes |
| `failed` | A stage failed. Shown at once; the session's row asks for the owner (`needsAttention`) while the ship is watched. A re-run on the same commit can still turn it to `shipped` | at `SHIP_MAX_MS` |
| `stalled` | Still running `SHIP_MAX_MS` (1 h) after the merge | yes |
| `quiet` | Nothing at all on the merge commit after `SHIP_QUIET_MS` (5 min) | yes |

Stage states: `pending` (queued, waiting for an environment's approval), `running`, `passed`, `failed` (failure, timed out,
startup failure, action required, a deployment's failure or error), `skipped` (cancelled or skipped: says nothing about the code).
An `inactive` deployment was replaced by a newer one, so it was live: `passed`.

### The card

Each change to what the card shows appends one `ship` event with the whole `ShipView`; clients keep the latest per `ship.id`
(`fold`, block kind `ship`). `ShipCard` (`apps/web/src/components/ShipCard.tsx`) is a card on the surface fill: the headline
(`Shipping #N to main`, `Shipped #N to main`, `#N failed to ship`, `#N was still shipping after an hour`, `Nothing ran after merging
#N`) with how long it has run or took, the PR's title, one 24px row per stage (state, name, a few words, its time, linking to the run,
check or deployment log), then `Open <host>` for a passed deployment's live URL or `See why <stage> failed`, and the merge commit.

**Where it sits** (`ShipPin`): while a turn runs, the card stays where the merge happened in the thread. Once the turn ends, the
session's latest ship is pinned at the end of the chat, above the status line, and its place in the thread shrinks to one line
(nothing, when nothing follows it). Older ships stay in the thread as cards.

Archived sessions are still watched (people archive after merging); deleting a session drops its ships.

### Limits

- Migrations are found by name only. A migration that runs inside an unnamed step, or in a platform outside GitHub, is not a stage of
  its own (it is still inside its workflow's or deployment's state).
- Deploys that report nothing to GitHub (a `wrangler deploy` from a laptop, a Cloudflare Workers Build without the GitHub app) are
  invisible.
- Several sessions subscribed to one PR each watch it.

## v2: the agent verifies and fixes (planned)

Wake the agent at the two moments that matter, through the same `<dorks-event>` notifications as CI and reviews
(`packages/shared/src/autonomy.ts`, new kinds):

- **`deployed`**: a deployment stage passed with an `environment_url`. The agent wakes with the URL and verifies **the change it
  made**, not generic health: it knows the PR's intent, so it opens the page or calls the endpoint the PR changed, with a browser
  (computer use), `curl`, and a test login from [secure inputs](secure-inputs.md). The result goes back onto the card as a
  `verify` stage with its evidence (a screenshot, a response). Reuse the Stop hook's live-verification gate ([services](services.md)):
  the turn cannot end without evidence. A new bridge op lets the agent report the verdict (`ship_verify { shipId, ok, note, image? }`).
- **`ship_failed`**: a stage failed (the build on the base, a migration, a deploy, the verification). The agent reads the logs
  (`gh run view --log-failed`, the deployment log URL), diagnoses, and opens a **fix-forward or a revert PR**, which is then an
  ordinary subscribed PR. A budget like `CI_FIX_MAX_ATTEMPTS` per ship, then it stops and asks the owner.
- **`ship_stalled`**: a stage pending past a per-kind timeout (a deploy queued for 20 minutes) is news, not silence.
- Guardrails: the agent never deploys, rolls back, or touches production data itself. It proposes; the card gets a **Revert** button
  that opens the revert PR for the owner to merge. Production checks use read-only credentials the owner gives once per repository.
- Also: a desktop notification on `failed` and `stalled`, since nobody is looking at a merged chat; match a cancelled workflow
  run to the newer run that replaced it (`/actions/workflows/:id/runs?branch=<base>` + compare), like deployments.

## v3: health after the deploy and per-repository setup (planned)

- **Error watch**: after the deploy passes, keep the ship open for a window (30 minutes by default) and read the error tracker for
  the release: Sentry's new issues first seen in the release (the merge SHA as the release name) and the error rate before and
  after. A spike is a `health` stage that fails and wakes the agent (`ship_failed`). The card shows `Watching errors · 18m left`.
- **Providers that do not report to GitHub**: the Cloudflare API (Workers deployments and versions, Pages deployments by commit
  hash), connected like an MCP server, as `deployment` stages.
- **`.dorks/ship.yml`** in the repository, for what auto-detection gets wrong: which workflows count, which environment is
  production, health URLs, the migration job's name, smoke steps in plain words, timeouts, the error-watch window. The agent drafts it
  after the first ship it watches and the owner approves it, like a build draft ([builds](builds.md)).
- **History**: ships listed per repository (what shipped, when, how long it took, what failed), so a session's PR history includes
  whether each merge reached production.
