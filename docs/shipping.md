# Shipping

Status: **v1 implemented** (watching and the Ship card). v2 and v3 below are the plan, not built yet.

Code: `apps/server/src/services/ships.ts` (the tracker), `services/poller.ts` (runs it each pass), `services/githubIngest.ts`
(`onClosed` starts a ship), `apps/web/src/components/ShipCard.tsx` (the card). Wire types: `packages/shared/src/ship.ts`.

A merged pull request is not a shipped one. The build on the base branch can fail, a migration can break, a deploy can hang, and
before this nobody was looking: the PR subscription ended at the merge ([autonomy](autonomy.md)). A **ship** picks up where the
subscription stops. It follows the merge commit until what it set off has finished, and the chat shows it as one card under
`PR #N merged`.

## What is watched (v1)

When the poller sees a session's PR merge (`pr_closed` with `merge_commit_sha`), `startShip` inserts a `ships` row for that PR
and session (once per PR per session) and appends a `ship` event. The box is not involved and is not woken: the server watches
while the sandbox sleeps.

Every poll pass (10 s), for each open ship, with conditional requests (a 304 is free against the rate limit), as the GitHub CLI's login:

| Read | Becomes |
|---|---|
| `GET /repos/:r/actions/runs?head_sha=<merge>` | One `workflow` stage per run (at most 15), leaving out `pull_request*` runs: a rebase merge keeps the PR's commits, and their PR runs are not the merge's |
| `GET /actions/runs/:id/jobs` per run, until its jobs are read once after it completes | A `migration` stage for each job whose name matches `/migrat/i`, else for each such step |
| `GET /commits/<merge>/check-runs` | A `check` stage per check run by name from any app other than GitHub Actions (Cloudflare Pages, Vercel, Netlify...) |
| `GET /commits/<merge>/status` | A `status` stage per commit status context |
| `GET /deployments?sha=<merge>` and `GET /deployments` (recent) | One `deployment` stage per environment: the newest deployment that **contains** the merge. A later commit's deployment counts when `GET /compare/<merge>...<sha>` says `ahead` or `identical` (a deploy that batched several merges); it says `with <sha>`. A branch preview (`diverged`) never counts. Its latest status gives the state and `environment_url` |

A read that fails (other than a rate limit or a rejected token, which stop the pass like the PR poller) keeps what it showed last
time. Bodies are kept with their ETags in `ships.poll`, so a 304 rebuilds the same stages.

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

Each change to what the card shows appends one `ship` event with the whole `ShipView`; clients keep the latest per `ship.id` in
the place of the first (`fold`, block kind `ship`). It is one line, `Shipping #N to main` / `Shipped #N to main in 6m 40s` /
`#N failed to ship` / `#N was still shipping after an hour` / `Nothing ran after merging #N`, that opens on its stages: one 24px row
each, with its state, name, a few words and how long it took, linking to the run, check or deployment log. It is open while it
watches or failed and folds away once shipped. A passed deployment's live URL sits under it. Archived sessions are still watched
(people archive after merging); deleting a session drops its ships.

### Limits

- A deploy workflow whose run on the merge commit is cancelled by a newer push (`concurrency: cancel-in-progress`) shows as skipped,
  even when the newer run deployed this change. Deployments are matched by ancestry; workflow runs are not yet.
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
