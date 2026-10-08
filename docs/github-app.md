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
4. When a box asks for secrets, `bridge.configure` / `bridge.ghToken` mint an installation token **scoped to that dork's repository
   with `contents: write` + `pull_requests: write` only**. The box runs untrusted agent code, so the token never covers the
   installation's other repos or permissions. GitHub reports which `owner/name` repos the token covers; a token for a same-named repo under
   a different owner is refused. Tokens last 1 hour and are refreshed every 45 minutes. A refresh that fails on a 5xx, rate limit or network
   error is retried with backoff (2, 4, 8, then every 10 minutes). Other failures (installation removed, repo deselected, bad key) are not
   retried early. After 3 consecutive failures (immediately for a permanent one) one error event is added to the dork's transcript.

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
| Webhook → Active | **unchecked for now.** The PR webhook is a later change. When it lands: check Active, URL `https://<convex site>/github/webhook` (placeholder, the route does not exist yet), set a webhook secret, and subscribe to **Pull request** events |
| Where can this App be installed? | **Any account** if people install it from accounts other than the App owner's; otherwise **Only on this account** |

**Repository permissions** (everything else: *No access*):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | `git push` of the agent branch |
| Pull requests | Read and write | open the PR (and receive `pull_request` webhooks later) |
| Metadata | Read-only | mandatory, granted automatically |

No account or organization permissions. Do **not** grant *Workflows*: with it a prompt-injected agent could push CI changes that
run with repo secrets, and pushes that touch `.github/workflows/**` will be rejected (this is intended).

The token request asks for exactly `contents: write` and `pull_requests: write` (`AGENT_TOKEN_PERMISSIONS` in
`apps/api/src/lib/github.ts`). GitHub answers **422** if the request asks for more than the App itself has, so the two
permissions above must be granted on the App. If you change the set, change both places. Installations created before a permission
change must accept the new permissions on GitHub before tokens work.

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
| `GitHub App can't access <owner/name>; add it to the installation` | GitHub answered 404/422: the installation is set to "Only select repositories" and this repo is not selected, or the App was removed from it. Add the repo to the installation on GitHub. |
| `GitHub App is not installed on the owner of <owner/name>; install it there` | the linked installation belongs to a different account than the repo's owner |
| `GitHub access is failing…` | token refreshes keep failing; pushes stop working when the current token expires |

A 422 can also mean the App itself lacks one of the two permissions above, but a repo that is not part of the installation is the more
common cause.

## What needs a human

- Registering the App (a GitHub account/org owner), including picking the name/slug.
- Generating the client secret and the private key (both only shown/downloaded once), converting the key, and setting the four
  Convex variables on each deployment.
- Adding the prod web host to the App's callback URLs and setting `VITE_GITHUB_APP_SLUG` in the prod web build.
- Each user installing the App on the repositories they want dorks to work in (and an org owner approving, for org-owned repos).
- Later: the webhook URL + secret once the PR webhook change lands.
