# GitHub and the owner token

Dorks uses **one GitHub token**. There is no GitHub App, no webhook and no OAuth flow. The token is stored encrypted in the server's settings and does two jobs:

1. It goes to each sandbox (over the authenticated bridge socket, in `configure`), so the agent can clone, push and run `gh`.
2. The server's poller uses it to watch the PRs a dork is subscribed to ([autonomy](autonomy.md)).

The dork acts as whoever owns the token. Commits, PRs and comments carry that account's name.

## Getting a token

**Option 1: your `gh` CLI (desktop app).** In the app, choose "Use my gh CLI" during setup. A native dialog asks for consent, then the app runs `gh auth token` and stores the result with `PUT /api/settings {"githubToken": ...}`. Zero typing, but that token is whatever `gh` holds, usually an OAuth token with broad `repo` and `workflow` scopes, and it will live inside cloud sandboxes. Read [what a sandbox can read](../SECURITY.md#what-a-sandbox-can-read) first.

**Option 2: a fine-grained personal access token (recommended).** Create one at github.com/settings/personal-access-tokens, limited to the repositories you want dorks to touch, and paste it into Settings. Repository permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | clone and push |
| Pull requests | Read and write | open PRs, read reviews and mergeability |
| Issues | Read and write | PR conversation comments |
| Workflows | Read and write | the agent may fix CI configuration (see autonomy decision 6) |
| Checks | Read | CI results |
| Actions | Read | `gh run view --log-failed` |
| Commit statuses | Read | CI that reports through statuses |
| Metadata | Read | required by GitHub |

A classic token with the `repo` and `workflow` scopes also works.

The server checks the token with `GET /user` when you save it, rejects it if GitHub answers 401 or 403, and stores the login it belongs to (shown in Settings).

## Identity

Events authored by the token's own login are ignored, because they are the agent's own pushes and comments. Consequences:

- If you use your personal token, your own comments on a PR will not wake the dork. Talk to it in the chat instead.
- If you want PR comments from you to wake it, give the dork a dedicated bot account and use that account's token.

`commentPolicy` (Settings) filters other people's comments: `all` (default) or an allowlist of logins (bots by login, for example `coderabbitai[bot]`).

## Rate limits and failures

The poller runs every 30 s while any subscription is active and sends conditional requests (`If-None-Match`), so unchanged PRs cost nothing against the rate limit. On a rate limit it waits until GitHub's reset time. If GitHub rejects the token (401, 403) it backs off for 5 minutes and tries again, so replacing a bad token takes effect without a restart. A PR the token cannot see ends its subscription.

## The owner token

Separate from GitHub: the **owner token** protects the UI API on `127.0.0.1`.

- The server generates it on first run into `<data dir>/secrets.json` (mode 600), or takes `DORKS_OWNER_TOKEN` from the environment.
- The desktop app generates its own, passes it to the server and gives it to the UI as `window.__DORKS__.ownerToken`. You never type it.
- Running the server by hand: open the web UI, and on the connect screen enter the server address (`http://127.0.0.1:4747`) and the `ownerToken` value from `secrets.json`.
- Every UI request sends `Authorization: Bearer <token>` (the live stream accepts `?access_token=` because `EventSource` cannot set headers). A wrong token gets `forbidden` (HTTP 401).

There are no accounts, sign-in codes or email. Whoever holds the owner token and can reach the UI port is the owner, and the UI port only listens on loopback.
