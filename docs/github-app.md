# GitHub App

The dork box pushes an `agent/*` branch and opens a PR through a GitHub App installation token. Users link the App to their
account on the web Settings page. This doc is everything needed to register the App and wire it in.

How it fits together:

1. The user opens `/settings` and follows **Install GitHub App** to `https://github.com/apps/<slug>/installations/new`.
   The link carries a random `state` that Settings also keeps in `sessionStorage`.
2. GitHub installs the App, then (because OAuth-during-install is on) redirects the browser to the **callback URL** with
   `?code=…&installation_id=…&state=…&setup_action=install`.
3. `/github/callback` (web) calls the Convex action `settings.linkGithubInstallation`. It exchanges `code` for a user token
   with the App's client id/secret and only stores the installation if `GET /user/installations` lists that id. A bare
   `installation_id` is never trusted (otherwise anyone could claim another org's installation).
   That check proves the *code's owner* can see the installation, not that the signed-in user asked for it: an attacker could
   install the App on their own org and send a victim the resulting callback URL. So the page links automatically only when
   `state` matches this tab's `sessionStorage` **and** nothing is linked yet; otherwise it asks the user to confirm "Link
   installation N" (and says it will replace the existing one). The `code` is removed from the address bar as soon as the page loads.
4. When a box asks for secrets, `bridge.configure` / `bridge.ghToken` mint an **installation-wide** token (no `repositories` filter:
   the agent may work in any repo the installation reaches, see `docs/autonomy.md`) with `contents`, `pull_requests`, `issues` and
   `workflows` **write** and `checks`, `actions` and `statuses` **read** only. The box runs untrusted agent code, so the token never
   carries more than these permissions. Tokens last 1 hour and are refreshed every 45 minutes. A refresh that fails on a 5xx, rate limit or network
   error is retried with backoff (2, 4, 8, then every 10 minutes). Other failures (installation removed, permissions not accepted, bad key) are not
   retried early. After 3 consecutive failures (immediately for a permanent one) one error event is added to the dork's transcript.
   Separately, subscribing a dork to a PR makes the backend read that PR with a short-lived `pull_requests: read` token of the
   owner's installation (it never reaches a box). A PR the installation cannot see ends the subscription.

## 1. Register the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App** (use the org's settings instead if the App should be
owned by an org).

| Setting | Value |
|---|---|
| GitHub App name | anything unique, e.g. `dorks`. The **slug** is derived from it (`github.com/apps/<slug>`) |
| Homepage URL | the prod web URL |
| **Identifying and authorizing users** → Callback URL | `http://localhost:3000/github/callback` **and** `https://<prod web host>/github/callback` (GitHub accepts several; add both) |
| **Request user authorization (OAuth) during installation** | **checked.** Required: without it GitHub sends no `code`, ownership cannot be verified, and linking fails |
| Expire user authorization tokens | leave on (default); the token is used once and discarded |
| Setup URL | not used (disabled while OAuth-during-install is on) |
| Webhook → Active | **unchecked for now.** The PR webhook is a later change. When it lands: check Active, URL `https://<convex site>/github/webhook` (placeholder, the route does not exist yet), set a webhook secret, and subscribe to **Pull request**, **Pull request review**, **Pull request review comment**, **Issue comment**, **Check suite** and **Push** events (the autonomy slice B2 consumes them) |
| Where can this App be installed? | **Any account** if people install it from accounts other than the App owner's; otherwise **Only on this account** |

**Repository permissions** (everything else: *No access*):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | `git push` of the agent branch |
| Pull requests | Read and write | open the PR, comment on and reply in review threads (and receive `pull_request` webhooks later) |
| Issues | Read and write | PR conversation comments are issue comments (`gh pr comment`, and `issue_comment` webhooks later) |
| Workflows | Read and write | the agent may fix CI config (`.github/workflows/**`) when a run fails |
| Checks | Read-only | CI results (`check_suite` webhooks later) |
| Actions | Read-only | `gh run view --log-failed` |
| Commit statuses | Read-only | CI results reported as statuses |
| Metadata | Read-only | mandatory, granted automatically |

No account or organization permissions. Granting *Workflows* is a deliberate trade-off (docs/autonomy.md decision 6): a
prompt-injected agent can push CI changes that run with repo secrets, so keep branch protection and required reviews on repos
the App can reach.

The token request asks for exactly these permissions (`AGENT_TOKEN_PERMISSIONS` in `apps/api/src/lib/github.ts`). GitHub answers
**422** if the request asks for more than the App itself has, so all of them must be granted on the App. If you change the set,
change both places. **Installations must accept new permissions:** when you add permissions to an App that is already installed,
GitHub emails the account owner and keeps the old permission set until they approve the update (App settings -> Install App ->
the installation's *Review request*, or `https://github.com/settings/installations/<id>`). Until then token requests fail with
422 and dorks show `GitHub App permissions are out of date; accept the new permissions on the installation`.

After creating the App:

- Note the numeric **App ID** (top of the App's settings page) → `GITHUB_APP_ID`.
- Note the **Client ID** (`Iv…`) → `GITHUB_APP_CLIENT_ID`.
- **Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET` (shown once).
- **Generate a private key** (downloads a `.pem`) → see below.

## 2. Convert the private key to PKCS#8

GitHub gives a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`). The Convex runtime signs the App JWT with WebCrypto, which only
imports PKCS#8 (`-----BEGIN PRIVATE KEY-----`):

```sh
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

Use the converted file. A PKCS#1 key fails with `GitHub App key is PKCS#1; convert to PKCS#8`. Delete both files after storing the
key; never commit them.

## 3. Set the environment

Convex (per deployment; add `--prod` or `CONVEX_DEPLOYMENT` for prod). Quote the multi-line key; `--` stops the CLI reading the
PEM header as a flag:

```sh
cd apps/convex
npx convex env set GITHUB_APP_ID 123456
npx convex env set GITHUB_APP_CLIENT_ID Iv23xxxxxxxxxxxxxxxx
npx convex env set GITHUB_APP_CLIENT_SECRET <client secret>
npx convex env set GITHUB_APP_PRIVATE_KEY -- "$(cat app.pkcs8.pem)"
```

Web (read at build time by Vite, so it must be present when `vite build` / `vite dev` runs, not just at runtime):

```sh
VITE_GITHUB_APP_SLUG=dorks   # the <slug> in https://github.com/apps/<slug>
```

Without `VITE_GITHUB_APP_SLUG` the Settings page shows an error instead of the install link.

## 4. Local development without a real App

With `BOX_PROVIDER=sim` on the Convex deployment, `settings.linkGithubInstallation` accepts `code=sim` without calling GitHub and
`bridge.ghToken` returns a fake token. Open `http://localhost:3000/github/callback?installation_id=1&code=sim` after signing in.
`apps/convex/scripts/settings-e2e.mjs` drives the whole onboarding this way (see the header of that script for how to run it).
To exercise the real flow locally, register a second App whose callback URL is the `localhost` one above.

## 5. Errors on the callback page

| Code | Meaning |
|---|---|
| `forbidden` | the installation is not visible to the signed-in user's GitHub account (installed by someone else, or the user lacks access) |
| `github_error` | GitHub rejected the code exchange or the installations lookup (expired/reused `code`: codes are single use and short-lived), or GitHub is down |
| `not_configured` | `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` not set on the Convex deployment |
| `invalid` | malformed `installation_id` |

Token minting problems at box time show up in the Convex logs as `configure failed` / `gh token refresh failed` (never the token or
GitHub's response body). The dork shows:

| Message | Cause |
|---|---|
| `GitHub App permissions are out of date; accept the new permissions on the installation` | GitHub answered 422: the App has not been granted every permission in `AGENT_TOKEN_PERMISSIONS`, or the installation owner has not accepted the update yet |
| `GitHub App installation not found; install the App again` | GitHub answered 404: the installation was removed |
| `GitHub access is failing…` | token refreshes keep failing; pushes stop working when the current token expires |

The token is installation-wide, so a repo the installation does not cover is no longer caught when the token is minted: it shows up
when the bridge clones it (or when the agent tries to push to it).

## What needs a human

- Registering the App (a GitHub account/org owner), including picking the name/slug.
- Generating the client secret and the private key (both only shown/downloaded once), converting the key, and setting the four
  Convex variables on each deployment.
- Adding the prod web host to the App's callback URLs and setting `VITE_GITHUB_APP_SLUG` in the prod web build.
- Each user installing the App on the repositories they want dorks to work in (and an org owner approving, for org-owned repos).
- Later: the webhook URL + secret once the PR webhook change lands.
