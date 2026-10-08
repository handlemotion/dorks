# Autonomy

A dork doesn't stop at "task done". It opens PRs, subscribes to them, and keeps working on CI failures, review comments,
merge conflicts and stack rebases until each PR is merged, closed or unsubscribed. One chat (one box) can hold any number of
PRs across repos and stacks. This follows Devin's model, not Conductor's one-PR-per-workspace model.

Claude Code stays stock. Autonomy is built from the bridge we already have, plus hooks, a `gh` shim and a small `dorks` CLI.

## Product decisions (2026-10-08)

| # | Decision |
|---|---|
| 1 | **Repos:** any repo the user's GitHub App installation can reach. A starting repo is picked when the first message is sent (`dorks.create { repo }`), and the agent may work in others. |
| 2 | **Comment authors:** a per-user `commentPolicy` (`packages/shared/src/autonomy.ts`). It is either `all` (the default, valid config) or `allowlist` of GitHub logins (bots by login, e.g. `coderabbitai[bot]`). The App's own events are always dropped. |
| 3 | **Identity:** the dork comments and pushes as the App (`<slug>[bot]`). |
| 4 | **Subscriptions:** several dorks may subscribe to one PR. A dork auto-subscribes to PRs it creates. The user can subscribe it to any other PR. |
| 5 | **After green + approved:** the agent posts a short "on standby" note in the thread and goes idle (then sleeps). It never auto-merges. |
| 6 | **Workflows:** the token includes `workflows: write`, so the agent may fix CI config. |
| 7 | **CI fixes: at most `CI_FIX_MAX_ATTEMPTS = 2` in a row per PR.** A third consecutive failure stalls the subscription: no more CI notifications, one transcript event, and one PR comment from the App saying a human is needed. The counter resets on green CI, a human comment or message, or a manual resubscribe. No other budgets in v1. |
| 8 | **Validate locally before pushing.** The Stop hook and every CI-failure notification tell the agent to reproduce the failure and run the repo's checks locally before it pushes. |
| 9 | **Merge conflicts and restacks are fixed autonomously.** |

## Why the bridge is the channel

Claude Code's native push-into-session feature, Channels, can't be used. It is a research preview behind an allowlist, and the
development flag is ignored in `-p` / SDK mode, which is how `dorks-bridge` runs Claude. We don't need it: the bridge owns
Claude's stdin (`--input-format stream-json`), and the backend already turns `commands` rows into user turns and wakes a
sleeping box to deliver them. A notification is one more command kind (`notify`) on that path.

Hooks do the parts only something inside Claude Code can do:

- gate "done";
- watch for PRs being created or merged;
- re-inject state after a resume or compaction.

## Architecture

```
GitHub ──webhook──▶ Convex /github/webhook ──▶ prSubscriptions ──▶ inbox (debounce, coalesce) ──▶ commands(notify)
                                                     ▲                                                │ wake if asleep
                                                     │ bridge.subscribe / unsubscribe                 ▼
box: gh shim / dorks CLI / hooks ──unix socket──▶ dorks-bridge ──stdin──▶ claude -p (stream-json, --settings <hooks>)
```

## Contract

### Shared (`packages/shared`)

- `src/autonomy.ts` defines the wire types: `prRef`, `subscriptionView`, `notifyKind`, `commentPolicy`, `CI_FIX_MAX_ATTEMPTS`
  and `NOTIFY_TAG`.
- `src/bridge.ts` adds the frame `{ t: "notify", id, text, kinds, prs }` to both `toBridge` and `commandFrame`.
  - It is delivered and acked like `user_message`: same dedupe by id, and an unacked notify counts as `queued`.
  - The bridge writes `text` to stdin verbatim as a user turn.
- `src/events.ts` adds two client events:
  - `notify` is the transcript card;
  - `subscription` covers subscribed, ended and stalled.

### Backend (`apps/convex`)

Tables:

- `prSubscriptions { dorkId, userId, repo, number, url, title?, headRef?, baseRef?, headSha?, source, status, ci, review,
  mergeable, ciFixAttempts, state, lastEventAt }` plus webhook bookkeeping that is not part of the wire view (`ciFailing`, `ciNotified`, `readySha`, `conflictSha`).
  - Indexes: `by_repo_number`, `by_repo_head` (check events carry a SHA or branch, not a PR number), `by_repo_base` (a push to a base branch), `by_dork` (`dorkId, repo, number`).
  - It maps 1:1 to `subscriptionView` (`lib/subscriptions.ts toView`). `repo` is stored lowercase; the lookups
    (`subscriptionsForPr`, `subscriptionsForHead`) lowercase their argument and skip `ended` rows.
  - A new subscription is filled in by an action (`subscriptions.hydrate`: title, refs, sha, state, mergeable) with a
    `pull_requests: read` installation token of the owner. A PR the installation cannot see (404) ends the subscription, and so does
    one that is already closed or merged. The ingress must also check that an event's `installation.id` is the one the owner linked
    before it routes the event to that owner's dorks.
  - At most 50 live subscriptions per dork. Only a human (`source: "user"`) resubscribing resets `ciFixAttempts`; an agent
    reviving an ended subscription keeps the budget.
- `inbox { dorkId, subscriptionId, kind, summary, deliveryId?, createdAt, delivered }` is the debounce buffer.
  `enqueueNotification(ctx, dorkId, subscriptionId, kind, summary, deliveryId?)` (`lib/notify.ts`) inserts a row and arms the per-dork
  `notify` timer (45 s, from the first event, not sliding). When it fires, the pending rows are folded into one `notify` command
  and one `notify` transcript card (`lib/notifyRender.ts` renders the envelope). Delivered rows are swept after a day.
- `githubDeliveries { deliveryId, receivedAt }` dedupes `X-GitHub-Delivery`. It is pruned by cron.
- `userSettings.commentPolicy` (optional, default `all`) and `userSettings.githubLogin` (stored at install-link time).
- `commands.kind` gains `"notify"` (fields: `text`, `meta` holding kinds and prs, and `released`).
- `settings.setCommentPolicy` stores the policy; `commentAllowed(policy, login, appBotLogin)` (`lib/subscriptions.ts`) is the check.

Lifecycle machine (`apps/api/src/lifecycle/machine.ts`) input `notify`, by state:

| State | Effect |
|---|---|
| `sleeping` / `error` | wake, the same as `user_message` |
| `idle` | deliver |
| `working` | hold, never delivered mid-turn |
| `creating` / `waking` | deliver on ready |

Other rules:

- `turn_idle` with a held notify delivers it (`release_notify`, `deliver_outbox`). The dork stays `working`: the notify starts the next turn.
- Pending user messages are always delivered before notifications (`bridge.commands` orders them first and withholds notify while a user message is unacked).
- An unacked notify counts as `queued`, so the dork neither idles nor sleeps under it, and a pause that lands wakes it again.
- Mechanics: a notify command is `released` or held. It is held if the dork is `working` or a user message is unacked when it is
  folded; sending a user message holds a released one again. `bridge.commands` emits a notify only if it is released (or the dork is idle) and no user
  message is unacked, and only while the box is deliverable (working/idle, no pause in flight). `release_notify` (a turn boundary
  with no user message ahead, or a fresh agent on `agent_ready`) releases the held ones. The machine learns about them through
  `Ctx.notifyHeld`. Control-row clearing on pause/resume keeps notify rows, like user messages.

Bridge-facing functions (all take `{ dorkId, secret }`):

| Function | Kind | Purpose |
|---|---|---|
| `bridge.subscribe { repo, number, source: "auto" \| "agent" }` | mutation | Idempotent. Hydrates PR metadata through a scheduled action (App token). Appends a `subscription` event. |
| `bridge.unsubscribe { repo, number }` | mutation | Sets `status: ended`. Appends an event. |
| `bridge.subscriptions` | query (reactive) | `SubscriptionView[]` for this dork's non-ended subscriptions. The bridge caches it for hooks and the CLI. |
| `bridge.configure` / `bridge.ghToken` | (unchanged) | The token becomes installation-wide (no `repositories` filter). Permissions: `contents, pull_requests, issues, workflows: write`; `checks, actions, statuses: read`. The old "can't access <repo>" error goes away with the filter (nothing reports a repo-level problem when the token is minted); a 422 now means permissions out of date. |

User-facing functions (signed-in user; no UI in this slice):

- `subscriptions.list { dorkId }`;
- `subscriptions.subscribe { dorkId, repo, number }` and `subscriptions.unsubscribe`;
- `subscriptions.resume { dorkId, repo, number }` (un-stall: resets `ciFixAttempts`);
- `settings.setCommentPolicy { policy }`.

Webhook (`http.ts` route `POST /github/webhook`):

- Verify `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`, then dedupe on the delivery id.
- Events handled: `pull_request` (closed/merged → end the subscription; synchronize → count a CI fix attempt if one was pending, and
  update `headSha`; edited base → `base_changed`), `pull_request_review`, `pull_request_review_comment`, `issue_comment` (PR
  only), `check_suite` (completed only), `push` (to a subscribed PR's base → re-check mergeability → `conflict`).
- Drop events whose sender is the App's bot user (`<GITHUB_APP_SLUG>[bot]`), and comments and reviews rejected by the owner's `commentPolicy`
  (the owner's own `githubLogin` always passes). The bot's own pushes and closes still update the subscription, they just wake nobody. CI results and
  pushes to a base branch are not filtered by sender: all dorks share the one bot identity, and they describe the code.
- Route an event to a user's dorks only if `payload.installation.id` is that user's linked `githubInstallationId`. Check suites are matched by
  repo + head branch **and** the current head SHA, which also keeps a fork's same-named branch out.
- CI: a failing suite is handed to the agent while `ciFixAttempts < CI_FIX_MAX_ATTEMPTS`. A push after a delivered failure is an attempt. The failure
  after the last attempt stalls the subscription (transcript event + one PR comment from the App via an action), and nothing about CI is
  delivered while stalled. Attempts reset on green CI, a comment from a person that passes the policy, a user message to the dork
  (`dorks.sendMessage`) and `subscriptions.resume`. `ready` needs green CI and an approval, once per head SHA.
- Code: `lib/githubEvents.ts` (pure parsing + the self-filter test), `lib/githubIngest.ts` (routing and state changes, one mutation per delivery),
  `github.ts` (`ingest`, the mergeability poll, the stall comment).
- Coalesce per dork with a 45 s debounce. Hold CI digests until the suite completes.
- Rendering is done by the backend: one `<dorks-event>` envelope per delivery, one section per PR, then instructions.
  - CI failure: "fetch the failing logs with `gh run view --log-failed`, reproduce locally, fix, run the checks locally, then push. This is attempt n of 2."
  - Review comments: "address each comment, reply to it with `gh`, validate locally, push."
  - Conflict: "rebase or merge the base, resolve, validate locally, push (force-with-lease for rebases)."
  - Ready: "post a short standby note; do not merge."

### Bridge (`infra/bridge`)

- **`notify` frames** are written to stdin like `user_message`, and deduped and journaled the same way.
- **Local RPC**: the existing credential socket grows into a small JSON-lines RPC (`<state>/cred/cred.sock`, owned by the Claude
  user). Methods: `token`, `pr.sub`, `pr.unsub`, `pr.list`, `hook.stop`, `hook.postToolUse`, `hook.sessionStart`.
  `pr.*` call the Convex functions above. `pr.list` reads the cached reactive `bridge.subscriptions`.
- **`dorks` CLI** (the same binary): `dorks pr sub <url|owner/name#n>`, `dorks pr unsub …`, `dorks pr list [--json]`,
  `dorks hook <event>` (reads hook JSON on stdin, prints hook JSON on stdout).
- **`gh` shim** (installed ahead of the real `gh` on `PATH` in the snapshot; the real one is found through `DORKS_REAL_GH`):
  - It gets the token from the socket, sets `GH_TOKEN`, and execs the real `gh`, so everything works, including the `gh stack` extension.
  - After a successful `gh pr create`, it parses the PR URL from stdout and calls `pr.sub` with `source: "auto"`.
  - It never blocks or alters output.
- **Multi-repo**: `configure` still names the starting repo. Any other `github.com` repo the agent clones uses the same
  credential helper, configured globally for the Claude user (`credential.https://github.com.helper`).
- **Hooks** are written by the bridge to `<state>/claude-settings.json` and passed with `claude --settings <file>`, which merges
  with the repo's own settings. All of them run `dorks hook <event>`.

| Hook | Behaviour |
|---|---|
| `Stop` | If any repo under the workdir has commits that aren't pushed, or a pushed branch with no open PR, block once per condition (`stop_hook_active`) with a reason. The reason asks the agent to validate locally (tests, typecheck, lint for what it changed), push, and open a PR with `gh pr create`, or to explain why not. Otherwise allow the stop. |
| `PostToolUse` (Bash) | Detects `gh pr create` URLs (a backup for the shim) and `gh pr merge` / `gh pr close`, then subscribes or unsubscribes. |
| `SessionStart` (`resume`, `compact`, `startup`) | Adds `additionalContext` listing the subscribed PRs (repo#n, CI, review, mergeable, attempts) and a reminder of how autonomy works. |

## Slices

| PR | Where | Content |
|---|---|---|
| A | this branch | This doc + the shared contract (`packages/shared`). |
| B1 | backend workspace, chat 1 (stacked on A) | Tables, `notify` machine input and delivery ordering, bridge- and user-facing subscription functions, installation-wide token, `commentPolicy` setting. convex-test coverage. |
| B2 | backend workspace, chat 2 (stacked on B1) | The `/github/webhook` ingress: verify, dedupe, routing, comment policy, self-filter, debounce digests, CI attempt counting and stall plus escalation comment, conflict detection, ready/standby, auto-end on close/merge. Fixture-driven tests. |
| C1 | bridge workspace, chat 1 (stacked on A) | `notify` delivery, local RPC, `dorks` CLI, `gh` shim with auto-subscribe, global credential helper for multi-repo, snapshot updates (`gh`, `gh stack`, shim). |
| C2 | bridge workspace, chat 2 (stacked on C1) | Hooks: the settings file + `--settings`, the `dorks hook` handlers (Stop gate with local validation, PostToolUse, SessionStart). A live check that hooks fire under `-p --input-format stream-json` when a Claude token is available. |

C1 and C2 call the B1 functions through the bridge transport. Their tests use the fake transport, so they don't wait on B1.

## Open checks (need real accounts)

1. Pushes made with an App installation token trigger Actions and `check_suite` webhooks to the App.
2. `gh run view --log-failed` works with `actions: read`.
3. Webhook → wake → first token latency with real Upstash boxes (target < 60 s).
4. `gh stack` behaviour through the shim, and the webhooks a restack produces.
5. The App receives `check_suite.completed` for suites created by other apps (GitHub Actions). GitHub's docs do not say so explicitly; the fallback is `check_run` / `workflow_run` (docs/github-app.md, section 4).
