# Shipping

Status: **implemented**: watching and the Ship card (v1), the agent verifying and fixing (v2). v3 below is the plan, not built yet.

Code: `apps/server/src/services/ships.ts` (the tracker), `services/poller.ts` (runs it each pass), `services/githubIngest.ts`
(`onClosed` starts a ship), `apps/web/src/components/ShipCard.tsx` (the card). Wire types: `packages/shared/src/ship.ts`.

A merged pull request is not a shipped one. The build on the base branch can fail, a migration can break, a deploy can hang, and
before this nobody was looking: the PR subscription ended at the merge ([autonomy](autonomy.md)). A **ship** picks up where the
subscription stops. It follows the merge commit until what it set off has finished, and the chat shows it as one card under
`PR #N merged`.

## What is watched (v1)

When the poller sees a session's PR merge into the repository's **default branch** (`pr_closed` with `merge_commit_sha`; a stacked
PR merging into its parent's branch is not a release), `startShip` inserts a `ships` row for that PR and session (once per PR per
session, linked to its subscription) and appends a `ship` event. The box is not involved: the server watches while the sandbox
sleeps, and wakes the agent only as "The agent" below says.

Every poll pass (10 s) for the first 10 minutes, then every 30 s (`shipDue`), for each open ship, with conditional requests (a 304 is free against the rate limit), as the GitHub CLI's login:

| Read | Becomes |
|---|---|
| `GET /repos/:r/actions/runs?head_sha=<merge>` | One `workflow` stage per run (at most 15), leaving out `pull_request*` runs: a rebase merge keeps the PR's commits, and their PR runs are not the merge's. A **cancelled** run (a newer push cancelled it, `concurrency: cancel-in-progress`) is followed to the first later run of the same workflow on the base whose commit contains the merge (`/actions/workflows/:id/runs`), shown as `with <sha>` |
| `GET /actions/runs/:id/jobs` per run, until every job is seen completed | A `migration` stage for each job whose name matches `/migrat/i`, else for each such step |
| `GET /commits/<merge>/check-runs` | A `check` stage per check run by name from any app other than GitHub Actions (Cloudflare Pages, Vercel, Netlify...) |
| `GET /commits/<merge>/status` | A `status` stage per commit status context |
| `GET /deployments?sha=<merge>` and `GET /deployments` (recent) | One `deployment` stage per environment: the newest deployment that **contains** the merge, remembered so it is still followed after newer deployments push it off the recent page. A later commit's deployment counts when `GET /compare/<merge>...<sha>` says `ahead` or `identical` (a deploy that batched several merges); it says `with <sha>`. A branch preview (`diverged`) never counts. Its latest status gives the state and `environment_url` |

Ancestry answers (`GET /compare/<merge>...<sha>`, at most 3 new ones a pass) are remembered per ship. A card lists at most 15
workflow runs, 15 other apps' checks and 15 commit statuses, dropping only finished ones (a run or check still running or failed is
always kept: it decides the ship), and keeps only http(s) links (a status's `javascript:` target is
dropped): the card and the agent open them. A read that fails (other than a
rate limit or a rejected token, which stop the pass like the PR poller) keeps what it showed last time. Bodies are kept with their ETags in `ships.poll`, so a 304 rebuilds the same stages.

### Status

`decide` in `ships.ts`, a pure function of the stages and the clock:

| Status | When | Watch ends |
|---|---|---|
| `watching` | Something is pending or running, or everything finished less than `SHIP_SETTLE_MS` (1 min) ago: a deploy workflow that CI starts appears in that gap | no |
| `shipped` | Everything finished, nothing failed, and the settle minute passed | yes |
| `failed` | A stage failed. Shown at once; the agent is woken (`ship_failed`) to fix forward or revert, so the session does not ask for the owner (`needsAttention`). A re-run on the same commit can still turn it to `shipped` | at `SHIP_MAX_MS` |
| `stalled` | Still running `SHIP_MAX_MS` (1 h) after the merge | yes |
| `quiet` | Nothing at all on the merge commit after `SHIP_QUIET_MS` (5 min) | yes |

Stage states: `pending` (queued, waiting for an environment's approval), `running`, `passed`, `failed` (failure, timed out,
startup failure, action required, a deployment's failure or error), `skipped` (cancelled or skipped: says nothing about the code).
An `inactive` deployment was replaced by a newer one, so it was live: `passed`.

### The card

Each change to what the card shows appends one `ship` event with the whole `ShipView`; clients keep the latest per `ship.id`
(`fold`, block kind `ship`). `ShipCard` (`apps/web/src/components/ShipCard.tsx`) is a minimal card on the surface fill: a small top line with the
headline (`Shipping #N`, `Shipped #N`, `#N failed to ship`, `#N still shipping after an hour`, `Nothing ran after merging #N`) and,
right, the merge commit, a passed deployment's host (its live URL) and how long it has run or took; then one row per stage with its
state icon at the left edge (line icons while waiting, running or skipped; a filled green check once passed, a filled red x once
failed), its name, a few words and its time, linking to the run, check or deployment log. The agent's verify note gets its own line
under its row.

**Merges that ship together share a card**: a PR that merges while the session's previous ship is still watched joins its card
(`shipGroups` in `ShipCard.tsx`, client side only; each merge is still its own ship on the server, with its own agent wake-ups).
The headline names every PR (`Shipping #7 and #8`; a failure names only the failed ones), the top line lists each merge commit, and
the card sits at the newest merge (the earlier merges' places show nothing). A stage two merges share (the same log: a deploy that
included both, a run that replaced a cancelled one) shows once; a row only some of them have says which PR it is (`CI #7`), and rows of
the same name sit together. Each PR's `Verify on production` stays its own row.

**Where it sits** (`ShipPin`): while a turn runs, the card stays where the merge happened in the thread. Once the turn ends, the
session's latest ship is pinned at the end of the chat, close under the last answer and above the status line (until the owner
writes again after it ended; a merge that started nothing is never pinned and is one line), and its place in the thread shrinks to one line
(nothing, when nothing follows it). Older ships stay in the thread as cards.

Archived sessions are still watched (people archive after merging); deleting a session drops its ships.

### Limits

- Migrations are found by name only. A migration that runs inside an unnamed step, or in a platform outside GitHub, is not a stage of
  its own (it is still inside its workflow's or deployment's state).
- Deploys that report nothing to GitHub (a `wrangler deploy` from a laptop, a Cloudflare Workers Build without the GitHub app) are
  invisible.
- Several sessions subscribed to one PR each watch it.

## The agent (v2)

Code: `involveAgent` and `shipOp` in `services/ships.ts`, the `ship_verify` MCP tool (`infra/bridge/src/mcp.ts`), the `deployed` and
`ship_failed` instructions in `lib/notifyRender.ts`.

The ship wakes the session's agent at most twice, through the same `<dorks-event>` notifications as CI and reviews (the PR's ended
subscription carries them, so they render as that PR's section):

- **`deployed`**, once per ship: the first time a deployment stage passes with a live URL while nothing has failed. The agent is told the
  URL and asked to verify **the change it made** there (the page or endpoint the PR changed, with a browser, Playwright or curl, a test
  login from [secure inputs](secure-inputs.md) when it needs one), never to deploy or touch production data, and to report with
  `ship_verify { pr, ok, note }` (the PR it checked: several merged PRs of one session can wait at once, and the server never
  guesses which). A `verify` stage (`Verify on production`) joins the card as pending, so the ship waits for it; the
  agent's note becomes its detail. A failed check fails the ship (and the tool's answer asks for a fix-forward or revert PR). With no
  answer after `SHIP_VERIFY_MS` (20 minutes) the stage is skipped (`Not verified in time`) and the ship settles without it; a watch
that ends (stalled) while it is still open closes it the same way.
- **`ship_failed`**, once per ship: the first time a stage from GitHub fails. The agent gets each failing stage with its log URL and the
  merge commit, and is asked to read the logs, find the cause and open a fix-forward PR, or a revert PR when the fix is not obvious or
  production is broken. The new PR is an ordinary subscribed PR: when it merges, it gets its own ship.

Nothing is sent for an archived session (or a ship whose subscription was purged): the card still shows the ship, and no verify stage
waits. Chat mode sessions are not offered `ship_verify` (it is one of the autonomy tools, docs/modes.md).

Guardrails: the agent never deploys, rolls back, merges, or changes production data; the instructions and the tool say so. A ship
fails or verifies once from the agent's side, so a flapping deploy cannot loop it.

Not yet: a **Revert** button on a failed card (GitHub's `revertPullRequest` GraphQL mutation) for the owner, a desktop notification on
`failed` and `stalled`, and read-only production credentials per repository for checks that need a login.

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
