# Autonomy

A dork doesn't stop at "task done". It opens PRs, subscribes to them, and keeps working on CI failures, review comments, merge conflicts and stack rebases until each PR is merged, closed or unsubscribed. One chat (one sandbox) can hold any number of PRs across repos and stacks.

Claude Code stays stock. Autonomy is built from the bridge, plus hooks, a `gh` shim and a small `dorks` CLI.

## Decisions

| # | Decision |
|---|---|
| 1 | **Repos:** any repo the GitHub token can reach. A starting repo is picked when the first message is sent (`POST /api/dorks {repo}`), and the agent may work in others. |
| 2 | **Comment authors:** a `commentPolicy` setting (`packages/shared/src/autonomy.ts`): `all` (the default) or an `allowlist` of GitHub logins (bots by login, for example `coderabbitai[bot]`). Events authored by the token's own login are always dropped. |
| 3 | **Identity:** the dork comments and pushes as the owner of the GitHub token ([GitHub](github.md)). |
| 4 | **Subscriptions:** several dorks may subscribe to one PR. A dork auto-subscribes to PRs it creates. The user can subscribe it to any other PR. At most 50 live subscriptions per dork. |
| 5 | **After green and approved:** the agent posts a short "on standby" note in the thread and goes idle (then sleeps). It never auto-merges. |
| 6 | **Workflows:** the token needs workflow write access, so the agent may fix CI configuration. |
| 7 | **CI fixes: at most `CI_FIX_MAX_ATTEMPTS = 2` in a row per PR.** A third consecutive failure stalls the subscription: no more CI notifications, one transcript event, and one PR comment (posted with the token) saying a human is needed. The counter resets on green CI, a person's comment that passes the policy, a user message to the dork, or a manual resubscribe. |
| 8 | **Validate locally before pushing.** The Stop hook and every CI-failure notification tell the agent to reproduce the failure and run the repo's checks locally before it pushes. |
| 9 | **Merge conflicts and restacks are fixed autonomously.** |

## Why the bridge is the channel

Claude Code's native push-into-session feature, Channels, can't be used: it is a research preview behind an allowlist, and its development flag is ignored in `-p` / SDK mode, which is how `dorks-bridge` runs Claude. We don't need it: the bridge owns Claude's stdin (`--input-format stream-json`), and the server already turns `commands` rows into user turns and wakes a sleeping sandbox to deliver them. A notification is one more command kind (`notify`) on that path.

Hooks do the parts only something inside Claude Code can do:

- gate "done";
- watch for PRs being created or merged;
- re-inject state after a resume or compaction.

## Architecture

```
GitHub ◀── conditional GETs every 30 s ── poller ──▶ pr_subscriptions ──▶ inbox (debounce, coalesce) ──▶ commands(notify)
                                              ▲                                                          │ wake if asleep
                                              │ subscribe_pr / unsubscribe_pr (bridge socket)            ▼
sandbox: gh shim / dorks CLI / hooks ──unix socket──▶ dorks-bridge ──stdin──▶ claude -p (stream-json, --settings <hooks>)
```

There are no webhooks, so nothing on the internet has to reach your machine for GitHub. Polling also catches up after the machine sleeps, which webhooks cannot.

## Contract

### Shared (`packages/shared`)

- `src/autonomy.ts` defines the wire types: `prRef`, `subscriptionView`, `notifyKind`, `commentPolicy`, `CI_FIX_MAX_ATTEMPTS` and `NOTIFY_TAG`.
- `src/bridge.ts` has the frame `{ t: "notify", id, text, kinds, prs }` in both `toBridge` and `commandFrame`.
  - It is delivered and acked like `user_message`: same dedupe by id, and an unacked notify counts as `queued`.
  - The bridge writes `text` to stdin verbatim as a user turn.
- `src/events.ts` has two client events: `notify` (the transcript card) and `subscription` (subscribed, ended, stalled).

### Server (`apps/server`)

Tables (`src/migrations.ts`):

- `pr_subscriptions`: one row per dork, repo and PR number, with url, title, head and base refs, head SHA, `source`, `status`, `ci`, `review`, `mergeable`, `ciFixAttempts`, and the poller's bookkeeping (ETags, review and comment cursors). It maps to `subscriptionView`. `repo` is stored lowercase.
  - A new subscription is hydrated by the poller on its first read (title, refs, SHA, state, mergeable). A PR the token cannot see (404) ends the subscription, and so does one that is already closed or merged.
  - Only a human (`source: "user"`) resubscribing resets `ciFixAttempts`; an agent reviving an ended subscription keeps the budget.
- `inbox`: the debounce buffer. `enqueueNotification` (`src/services/notify.ts`) inserts a row and arms the per-dork `notify` timer (45 s, from the first event, not sliding). When it fires, the pending rows are folded into one `notify` command and one `notify` transcript card (`src/lib/notifyRender.ts` renders the envelope). Delivered rows are swept after a day.
- `settings.comment_policy` and `settings.github_login` (looked up when the token is saved).
- `commands.kind` includes `notify`.

Lifecycle machine (`apps/server/src/core/machine.ts`), input `notify`, by state:

| State | Effect |
|---|---|
| `sleeping` / `error` | wake, the same as `user_message` |
| `idle` | deliver |
| `working` | hold, never delivered mid-turn |
| `creating` / `waking` | deliver on ready |

Other rules:

- `turn_idle` with a held notify delivers it. The dork stays `working`: the notify starts the next turn.
- Pending user messages are always delivered before notifications.
- An unacked notify counts as `queued`, so the dork neither idles nor sleeps under it, and a pause that lands wakes it again.
- A notify command is `released` or held. It is held if the dork is `working` or a user message is unacked when it is folded; sending a user message holds a released one again. The bridge sees a notify only if it is released (or the dork is idle), no user message is unacked, and the sandbox is deliverable (working or idle, no pause in flight). A turn boundary with no user message ahead releases the held ones.

Bridge-facing operations (`rpc` over the socket, see [architecture](architecture.md)):

| op | Purpose |
|---|---|
| `subscribe_pr { repo, number, source: "auto" \| "agent" }` | Idempotent. Appends a `subscription` event. |
| `unsubscribe_pr { repo, number }` | Sets `status: ended`. Appends an event. |
| `subscriptions` push | `SubscriptionView[]` for this dork's non-ended subscriptions, re-sent on change. The bridge caches it for hooks and the CLI. |
| `configure` / `gh_token` | Return the stored GitHub token (the same token for every repo it can reach). |

UI operations: `GET/POST/DELETE /api/dorks/:id/subscriptions`, `POST .../subscriptions/resume` (un-stall: resets `ciFixAttempts`), and the `commentPolicy` setting.

### Poller (`src/services/poller.ts`)

Every 30 s, while any subscription is active, for each subscribed PR it reads, with conditional requests (`If-None-Match`; a 304 is free against the rate limit):

- the PR (head, base, state, mergeability);
- reviews, and conversation and review comments since the last cursor;
- the check suites of the head.

It turns differences into PR events (`pr_closed`, `pr_synchronize`, `pr_base_changed`, `review`, `comment`, `check_suite`, `ci_green`, `mergeable`) and applies them in one transaction per subscription (`src/services/githubIngest.ts`):

- Drop comments and reviews authored by the token's own login or rejected by `commentPolicy`. The agent's own pushes and closes still update the subscription; they just wake nobody. CI results and base-branch pushes are not filtered by sender: they describe the code.
- Check suites are matched on the current head SHA, which also keeps a fork's same-named branch out.
- CI: a failing suite is handed to the agent while `ciFixAttempts < CI_FIX_MAX_ATTEMPTS`. A push after a delivered failure counts as an attempt. The failure after the last attempt stalls the subscription (transcript event, and one PR comment posted with the token), and nothing about CI is delivered while stalled. Attempts reset as in decision 7. A passing suite alone is not green: green means every check suite of the head passed. `ready` needs green CI and an approval, once per head SHA.
- A conflict is detected when a PR's mergeability turns false, or its base moves.
- Failures: rate limits wait until the reset time; a rejected token backs off 5 minutes; a PR the token cannot see ends its subscription.

Rendering is done by the server: one `<dorks-event>` envelope per notification, one section per PR, then instructions.

- CI failure: "fetch the failing logs with `gh run view --log-failed`, reproduce locally, fix, run the checks locally, then push. This is attempt n of 2."
- Review comments: "address each comment, reply to it with `gh`, validate locally, push."
- Conflict: "rebase or merge the base, resolve, validate locally, push (force-with-lease for rebases)."
- Ready: "post a short standby note; do not merge."

### Bridge (`infra/bridge`)

- **`notify` frames** are written to stdin like `user_message`, and deduped and journaled the same way.
- **Local RPC**: the credential socket is a small JSON-lines RPC (`<state>/cred/cred.sock` when Claude runs as a separate user, else `<state>/cred.sock`). Methods: `token`, `pr.sub`, `pr.unsub`, `pr.list`, `hook.stop`, `hook.postToolUse`, `hook.sessionStart`. `pr.*` call the server through the bridge socket; `pr.list` reads the cached subscription push. The bridge sets `DORKS_SOCK` (the socket path) in Claude's environment so the CLI, the shim and the hooks find it.
- **`dorks` CLI** (the same binary, run as `dorks`: the role is chosen by the name it is invoked as, see [infra/bridge/README.md](../infra/bridge/README.md)): `dorks pr sub <url|owner/name#n>`, `dorks pr unsub ...`, `dorks pr list [--json]`, `dorks hook <event>` (reads hook JSON on stdin, prints hook JSON on stdout).
- **MCP tools** (`dorks mcp`, `infra/bridge/src/mcp.ts`): the same operations as typed tools. The bridge writes `<state>/claude-mcp.json` and starts Claude with `--mcp-config`; Claude Code launches `dorks mcp` as a stdio MCP server that forwards to the bridge RPC. Tools: `mcp__dorks__pr_subscribe`, `mcp__dorks__pr_unsubscribe`, `mcp__dorks__pr_list` (all `source: "agent"`, so only a human resumes a stalled subscription).
- **`gh` shim** (installed ahead of the real `gh` on `PATH` in the snapshot; the real one is found through `DORKS_REAL_GH`):
  - It gets the token from the socket, sets `GH_TOKEN`, and execs the real `gh`, so everything works, including the `gh stack` extension.
  - After a successful `gh pr create`, it parses the PR URL from stdout and calls `pr.sub` with `source: "auto"`.
  - It never blocks or alters output.
- **Multi-repo**: `configure` names the starting repo. Any other `github.com` repo the agent clones uses the same credential helper, configured globally for the Claude user (`credential.https://github.com.helper`).
- **Hooks** are written to `<state>/claude-settings.json` and passed with `claude --settings <file>`. `--settings` sits above the user's and the project's settings and hooks from every source run, so a repo's own `.claude/settings.json` hooks still fire. All of them are command hooks running `dorks hook <stop|post-tool-use|session-start>` (through the bundle's absolute path, so they do not depend on `PATH`). The command reads the hook JSON on stdin, calls the matching method on `DORKS_SOCK` and prints the answer; **it fails open** (any error: exit 0, no output).

| Hook | Behaviour |
|---|---|
| `Stop` | Scans the repos under the workdir with local git reads. If a branch has commits its remote counterpart doesn't, or has commits beyond the default branch and was never pushed, or was pushed and has no PR (cached subscriptions first, then `gh pr list --head`; any PR state counts; unknown never blocks), it blocks with a reason. The reason asks the agent to validate locally (tests, typecheck, lint for what changed, using the repo's scripts), push, and open a PR with `gh pr create`, or to explain why it is intentionally not pushing. Otherwise it allows the stop. It cannot loop: `stop_hook_active` always allows, a condition is raised once per session (persisted, forgotten when it clears), and a turn answering a `ready` notification is not gated. |
| `PostToolUse` (Bash) | Detects `gh pr create` / `gh stack submit` URLs in the tool result (a backup for the shim; idempotent) and `gh pr merge` / `gh pr close` results, then subscribes (`auto`) or unsubscribes. Returns nothing. |
| `SessionStart` (`startup`, `resume`, `compact`) | Adds `additionalContext` listing the subscribed PRs (`repo#n`, title, CI, review, mergeable, attempts n/2, stalled) and a reminder of how autonomy works. |

## Open checks (need real accounts)

1. Pushes made with the token trigger Actions and appear as check suites on the PR head.
2. `gh run view --log-failed` works with the Actions read permission.
3. Time from a CI failure to the agent's first token with a real Boat sandbox that was asleep (target under 60 s, plus up to one 30 s poll and the 45 s debounce).
4. `gh stack` behaviour through the shim, and what a restack looks like to the poller.
5. Check suites created by other apps (GitHub Actions) are returned by the head's check-suites read. CI that reports only through commit statuses is not covered yet.
