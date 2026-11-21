# GitHub and the owner token

Dorks acts on GitHub as **your GitHub CLI login**. There is no GitHub App, no webhook, no OAuth flow of its own and no token to paste: `gh` is the one source of truth. The token it yields does two jobs:

1. It goes to each sandbox (over the authenticated bridge socket, in `configure`), so the agent can clone, push and run `gh`.
2. The server uses it to list your organizations and repositories (the owner switcher and the repository picker) and to watch the PRs a dork is subscribed to ([autonomy](autonomy.md)).

The dork acts as whoever `gh` is signed in as. Commits, PRs and comments carry that account's name.

## Why the GitHub CLI, not a GitHub App

Dorks runs on your Mac with no hosted backend and no accounts. A GitHub App would need a service holding its private key (or client secret) to mint and refresh tokens, and an admin to install it on every organization. Your `gh` login already reaches every organization you belong to, is the identity the sandboxes push as, and needs nothing hosted. So it is the only path; the pasted personal access token is gone (a fine-grained token belongs to a single owner, which hid every organization but one).

## Connecting

1. Sign in once in a terminal, with the scopes Dorks uses:

   ```sh
   gh auth login --scopes read:org,workflow
   ```

   `repo` (on by default) clones and pushes, `read:org` lists your organizations, `workflow` lets the agent push changes to `.github/workflows` (autonomy decision 6). Already signed in without them: `gh auth refresh --hostname github.com --scopes read:org,workflow`.
2. In Dorks, onboarding's GitHub step (or Settings, GitHub) has **Connect**. That click is the consent: the server stores only `github_connected`, never the token.

The server reads the token the way `gh` itself resolves it (`apps/server/src/lib/ghCli.ts`): `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com` (the keychain or gh's config). It finds `gh` on `PATH` and in `/opt/homebrew/bin`, `/usr/local/bin` (a Finder-launched app has a minimal `PATH`). The token is cached in memory for a minute, so `gh auth login`, `gh auth refresh` and `gh auth switch` take effect without restarting anything; **Check again** in Settings reads it at once. Connecting checks it with `GET /user` and refuses with a plain reason when `gh` is missing, signed out, or rejected.

`GH_TOKEN` in the server's environment is for development and the e2e only (the desktop app never passes it).

## Organizations and repositories

`GET /api/github/repos` lists `/user/orgs`, your 300 most recently pushed repositories (`/user/repos`), and one page of each organization's (`/orgs/{org}/repos`), and reports `auth`: the connection state and any of `repo`, `read:org`, `workflow` the token lacks (from `X-OAuth-Scopes`). The owner switcher shows your user, every organization, and the owners of those repositories.

An organization can restrict OAuth apps. Until it approves the GitHub CLI, its private repositories are invisible to your `gh` token, in Dorks as in `gh` itself. **Grant access** in Settings, GitHub opens [the GitHub CLI's page in your GitHub settings](https://github.com/settings/connections/applications/178c6fc778ccc68e1d6a), where you grant or request access per organization; then choose **Check again**.

The token reaches everything your `gh` login can, and it lives inside cloud sandboxes while they run. Read [what a sandbox can read](../SECURITY.md#what-a-sandbox-can-read). To narrow it, sign `gh` in as a dedicated account that only has the repositories dorks should touch.

## Identity

Events authored by the token's own login are ignored, because they are the agent's own pushes and comments. Consequences:

- Signed in as yourself, your own comments on a PR will not wake the dork. Talk to it in the chat instead.
- If you want PR comments from you to wake it, sign `gh` in as a dedicated bot account.

`commentPolicy` (Settings) filters other people's comments: `all` (default) or an allowlist of logins (bots by login, for example `coderabbitai[bot]`).

## Rate limits and failures

The poller runs every 10 s while any subscription is active and sends conditional requests (`If-None-Match`), so unchanged PRs cost nothing against the rate limit. On a rate limit it waits until GitHub's reset time. If GitHub rejects the token (401, 403) it backs off for 5 minutes and tries again, so signing `gh` in again takes effect without a restart. A PR the token cannot see ends its subscription.

## The owner token

Separate from GitHub: the **owner token** protects the UI API on `127.0.0.1`.

- The server generates it on first run into `<data dir>/secrets.json` (mode 600), or takes `DORKS_OWNER_TOKEN` from the environment.
- The desktop app generates its own, passes it to the server and gives it to the UI as `window.__DORKS__.ownerToken`. You never type it.
- Running the server by hand: open the web UI, and on the connect screen enter the server address (`http://127.0.0.1:4747`) and the `ownerToken` value from `secrets.json`.
- Every UI request sends `Authorization: Bearer <token>` (the live stream accepts `?access_token=` because `EventSource` cannot set headers). A wrong token gets `forbidden` (HTTP 401).

There are no accounts, sign-in codes or email. Whoever holds the owner token and can reach the UI port is the owner, and the UI port only listens on loopback.
