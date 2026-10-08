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
| Webhook → Active | **checked** (see [section 4](#4-the-webhook)). URL `https://<deployment>.convex.site/github/webhook` (the Convex *site* URL, the same host as `VITE_CONVEX_SITE_URL`), secret = `GITHUB_WEBHOOK_SECRET`, SSL verification on, content type `application/json`. Subscribe to exactly these events: **Pull request**, **Pull request review**, **Pull request review comment**, **Issue comment**, **Check suite**, **Push** |
| Where can this App be installed? | **Any account** if people install it from accounts other than the App owner's; otherwise **Only on this account** |

**Repository permissions** (everything else: *No access*):

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | `git push` of the agent branch |
| Pull requests | Read and write | open the PR, comment on and reply in review threads; receive the `pull_request`, `pull_request_review` and `pull_request_review_comment` webhooks |
| Issues | Read and write | PR conversation comments are issue comments (`gh pr comment`, the stalled-CI comment, and the `issue_comment` webhook) |
| Workflows | Read and write | the agent may fix CI config (`.github/workflows/**`) when a run fails |
| Checks | Read-only | CI results: the `check_suite` webhook (read access is enough to subscribe to it) |
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
- Note the **slug** (`github.com/apps/<slug>`) → `GITHUB_APP_SLUG`.
- The **webhook secret** is generated by us (`GITHUB_WEBHOOK_SECRET` in `secrets/`); paste the same value into the App's webhook settings.

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
npx convex env set GITHUB_APP_SLUG dorks            # the <slug> of the App: its bot user is `dorks[bot]`
npx convex env set GITHUB_WEBHOOK_SECRET <the secret you pasted into the App's webhook settings>
```

Web (read at build time by Vite, so it must be present when `vite build` / `vite dev` runs, not just at runtime):

```sh
VITE_GITHUB_APP_SLUG=dorks   # the <slug> in https://github.com/apps/<slug>
```

Without `VITE_GITHUB_APP_SLUG` the Settings page shows an error instead of the install link.

## 4. The webhook

`POST https://<deployment>.convex.site/github/webhook` (`apps/convex/convex/http.ts`):

1. **Not configured → 503.** While `GITHUB_WEBHOOK_SECRET` or `GITHUB_APP_SLUG` is unset the route refuses every delivery without reading (or logging) the
   body. The slug is required because the App's own comments must be recognised, or the dork would answer itself.
2. **Signature.** `X-Hub-Signature-256` is checked over the raw body (`verifyWebhook`); a missing or wrong one is 401.
3. **Parse.** `lib/githubEvents.ts` turns the payload into a small typed event or `null`. `null` (events and actions we do not act on, including
   `ping`, `installation` and `installation_repositories`) is acknowledged with 200 and not recorded.
4. **Route** in one mutation (`github.ingest`): the delivery id (`X-GitHub-Delivery`) is recorded in `githubDeliveries` (a redelivery is a no-op; a cron prunes ids
   after a week), then the event goes to the subscriptions of that PR. A subscription only receives an event if `payload.installation.id` is the installation its
   owner linked, so another account's installation cannot feed events to your dorks.

| Event | Handling |
|---|---|
| `pull_request` closed | the subscriptions end (`merged` / `closed` in the transcript); the dork is told unless it closed the PR itself |
| `pull_request` synchronize | head SHA updated, CI back to pending; counts as a CI fix attempt if a `ci_failed` had been handed to the agent |
| `pull_request` edited, base changed | `base_changed` |
| `pull_request_review` submitted | `review`; approval / change request tracked for `ready` |
| `pull_request_review_comment`, `issue_comment` (PRs only) created | `comment`, gated by the owner's comment policy |
| `check_suite` completed | `ci_failed`, or CI green; matched by head branch **and** the current head SHA |
| `push` to a branch a subscribed PR targets | schedules a mergeability re-read, poll with backoff while GitHub has not computed it; `conflict` once per base SHA |

**Self-filter.** Events whose sender is `<slug>[bot]` never wake the dork: its own comments and reviews are dropped. Its pushes still update the head SHA and
reset CI (that is how an attempt is counted), and a PR it closes still ends. CI results and pushes to a base branch are not filtered: they describe the
code, and every dork of every user shares the one bot identity, so "sent by the App" does not mean "caused by this dork".

**CI policy.** Up to two fix attempts per PR (`CI_FIX_MAX_ATTEMPTS`). After the second push, the next failure *stalls* the subscription: no more CI
notifications, a `stalled` transcript event, and one PR comment from the App ("a human needs to look", linking the failing run). The counter resets, and a stalled PR
resumes, on green CI, on a comment from a person that passes the comment policy (a bot's comment does not), on a message to the dork, and on resubscribing.
`ready` (CI green and the PR approved) is delivered once per head SHA. A PR nobody reviewed is never `ready`: whether a repo requires reviews is not knowable
without admin permissions.

**Which CI the App sees.** Each workflow run of GitHub Actions is its own check suite, created by the `github-actions` app, not by ours. GitHub's webhook reference (checked 2026-10-08) says
an App needs only *Checks: read* to subscribe to `check_suite` (and `check_run`) and that repository-level deliveries carry the `completed` action, but it does not state whether
`check_suite.completed` is sent to an App for suites another app created. We rely on it (it is how other Apps observe Actions) and it is the first thing to verify against a real
installation (docs/autonomy.md, open check 5). If it turns out not to hold, subscribe the App to **Check run** and **Workflow run** as well and map `check_run.completed` /
`workflow_run.completed` the same way; no new permission is needed (*Actions: read*, already granted, covers `workflow_run`). CI that reports only through the commit *statuses* API
(no check runs) sends `status` events, which are not handled.
Known limits: a PR with several workflows turns green as soon as no *known* suite is red, so a slow workflow can still fail afterwards (that failure is then handled normally); suites for a commit
other than the PR's current head, and cancelled / `action_required` / stale suites, are ignored.

Debugging: the App's **Advanced** tab lists recent deliveries with their status codes and lets you redeliver one (the same delivery id: a redelivery of a handled one is ignored by design;
use a fresh event to test).

## 5. Local development without a real App

With `BOX_PROVIDER=sim` on the Convex deployment, `settings.linkGithubInstallation` accepts `code=sim` without calling GitHub and
`bridge.ghToken` returns a fake token. Open `http://localhost:3000/github/callback?installation_id=1&code=sim` after signing in.
`apps/convex/scripts/settings-e2e.mjs` drives the whole onboarding this way (see the header of that script for how to run it).
To exercise the real flow locally, register a second App whose callback URL is the `localhost` one above.

## 6. Errors on the callback page

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
- Pasting the webhook URL and `GITHUB_WEBHOOK_SECRET` into the App, subscribing to the six events, and setting `GITHUB_APP_SLUG` on every Convex deployment.
