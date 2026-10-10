# Secrets inventory

Scanned 2026-10-07 across `apps/*`, `infra/`, `docs/`, wrangler/Convex/Expo config. There is no CI, Dockerfile or `.github/` yet. Env and naming rules: [README](README.md).

**Status** is what was seeded into the Doppler `dev` / `prd` configs of project `dorks` (2026-10-08): `filled` = a real generated/configured value, `dummy` = `REPLACE_ME__<PROVIDER>` that a human must replace (guide linked), `config` = non-secret value with a sensible default, `-` = deliberately not created in that env. The **Unit** column is the owning app.

Backend: **convex** (spike verdict GO, [convex-spike.md](../convex-spike.md)); the old Worker API was removed. `shared` marks values read by more than one unit.

## Runtime variables

| Name | Unit | Envs | Secret? | Used by (code) | Source | dev status | prod status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | `shared` | dev, prod | yes | convex `convex/auth.ts:21` | generated (32 random bytes, base64) | filled | filled |
| `ENCRYPTION_KEY` | `shared` | dev, prod | yes | convex `convex/bridge.ts:156`, `convex/settings.ts:9`. AES-GCM key, **must decode to 32 bytes** | generated (32 random bytes, base64) | filled | filled |
| `RESEND_API_KEY` | `shared` | dev, prod | yes | convex `convex/mail.ts:3` (required, throws if unset) | external: [Resend](providers/resend.md) | dummy | dummy |
| `BOX_PROVIDER` | `shared` | dev, prod | no | convex `lib/box.ts:10`, `bridge.ts:160`, `settings.ts:61`, `simbox.ts:35` | config: `sim` (dev), `upstash` (prod; any non-`sim` value means real provider, which is not implemented yet) | config | config |
| `BASE_SNAPSHOT_ID` | `shared` | dev, prod | no | convex `lifecycle.ts` `boxInfo`. Box snapshot new dorks start from for non-Upstash providers (Upstash users build their own image, `workstation.provision`) | dev: `sim-snapshot`; prod external: [Upstash Box](providers/upstash-box.md) | config | dummy |
| `GITHUB_APP_ID` | `shared` | dev, prod | no (identifier) | convex `bridge.ts:161` | external: [GitHub App](providers/github-app.md) | dummy (unused while `BOX_PROVIDER=sim`) | dummy |
| `GITHUB_APP_PRIVATE_KEY` | `shared` | dev, prod | yes | convex `bridge.ts:161`. **Must be PKCS#8 PEM**, not GitHub's downloaded PKCS#1 | external: [GitHub App](providers/github-app.md) | dummy | dummy |
| `GITHUB_WEBHOOK_SECRET` | `shared` | dev, prod | yes | convex `convex/http.ts` (`POST /github/webhook`, verified with `verifyWebhook` from `convex/core/github.ts`; the route answers 503 while it is unset) | generated (32 random bytes, hex); **you paste it into the GitHub App's webhook settings** ([GitHub App](providers/github-app.md)) | filled | filled |
| `UPSTASH_BOX_API_KEY` | `shared` | dev | no | **not read by the backend any more** (bring your own key: each user stores theirs, encrypted, via `settings.setUpstashKey`). Doppler `dev` keeps one only as a stand-in customer key for `pnpm byok:e2e` and the other real-Upstash e2e scripts | external: [Upstash Box](providers/upstash-box.md) | dummy | dummy |
| `EXPO_ACCESS_TOKEN` | `shared` | dev, prod | yes | not read yet (push sending is planned in convex) | external: [Expo](providers/expo-push.md) (optional feature) | dummy | dummy |
| `BRIDGE_SECRET_KEY` | `convex` | dev, prod | yes | convex `lib/bridgeAuth.ts:7`; HMAC key deriving each box bridge's secret. Rotating it invalidates running boxes' bridge secrets | generated (32 random bytes, hex) | filled | filled |
| `GITHUB_APP_CLIENT_ID` | `convex` | dev, prod | no (identifier) | convex `settings.ts:63` (install-ownership check) | external: [GitHub App](providers/github-app.md) | dummy | dummy |
| `GITHUB_APP_CLIENT_SECRET` | `convex` | dev, prod | yes | convex `settings.ts:64` | external: [GitHub App](providers/github-app.md) | dummy | dummy |
| `GITHUB_APP_SLUG` | `convex` | dev, prod | no (identifier) | convex `convex/http.ts` and `lib/githubEvents.ts`: the App's bot user is `<slug>[bot]`, whose events the webhook drops (the dork never reacts to itself); the webhook answers 503 while it is unset. The same `<slug>` as `VITE_GITHUB_APP_SLUG` | the `<slug>` in `https://github.com/apps/<slug>`: [GitHub App](providers/github-app.md) | dummy | dummy |
| `SITE_URL` | `convex` | dev, prod | no | convex `auth.ts:23,43` (trusted origin + cross-domain site; the **web origin**) | config: `http://localhost:3000` (dev); prod = `https://dorks.build` (once the app is deployed there) | config | dummy (`REPLACE_ME__WEB_ORIGIN`) |
| `STRIPE_SECRET_KEY` | `convex` | dev, prod | yes | convex `convex/billing.ts`, `core/stripe.ts`. **Test-mode key only** (`sk_test_`/`rk_test_`): live keys are refused unless `STRIPE_ALLOW_LIVE=true`. Unset = billing off | external: Stripe ([billing](../billing.md)) | missing: create in `dev` | missing |
| `STRIPE_WEBHOOK_SECRET` | `convex` | dev, prod | yes | convex `convex/http.ts` (`POST /stripe/webhook`; answers 503 while unset) | Stripe webhook endpoint signing secret (`pnpm stripe:setup -- --webhook-url ...` stores it; the e2e sets a throwaway one locally) | missing | missing |
| `STRIPE_PRICE_ID` | `convex` | dev, prod | no (identifier) | convex `convex/billing.ts` (Checkout line item: the $10/month app-access price) | printed and stored in `dev` by `pnpm stripe:setup` | missing | missing |
| `BILLING_REQUIRED` | `convex` | dev, prod | no | convex `convex/billing.ts`: `true` = creating a dork needs an active subscription | config, default off | - | - |
| `STRIPE_API_BASE_URL` | `convex` | dev | no | convex `convex/billing.ts`: redirects Stripe calls (local e2e relay only; `billing:e2e` sets and removes it on the deployment) | config, never set in Doppler | - | - |
| `STRIPE_ALLOW_LIVE` | `convex` | dev, prod | no | convex `convex/billing.ts`: `true` lets a live key through. Never set by agents | config, leave unset | - | - |
| `SIM_HOST_KEY` | `convex` | dev only | yes (dev) | convex `simbox.ts:35`, `scripts/e2e.mjs`, `infra/bridge-sim/host.mjs`. Only honoured when `BOX_PROVIDER=sim` | generated (32 random bytes, hex) | filled | `-` |
| `VITE_CONVEX_URL` | `web` | dev, prod | no (ships to browsers) | web `src/lib/convex.ts:6` | config: `http://127.0.0.1:3210` (local Convex); prod = `https://<deployment>.convex.cloud` ([Convex](providers/convex.md)) | config | dummy |
| `VITE_CONVEX_SITE_URL` | `web` | dev, prod | no (ships to browsers) | web `src/lib/convex.ts:10` | config: `http://127.0.0.1:3211`; prod = `https://<deployment>.convex.site` | config | dummy |
| `VITE_GITHUB_APP_SLUG` | `web` | dev, prod | no (ships to browsers) | web `src/routes/settings.tsx:12` (builds the "Install GitHub App" link; without it the Settings page shows an error) | the `<slug>` in `https://github.com/apps/<slug>`: [GitHub App](providers/github-app.md) | dummy | dummy |
| `EXPO_PUBLIC_CONVEX_URL` | `ios` | dev, prod | no (ships in bundle) | ios `src/lib/convex.ts:9` | as `VITE_CONVEX_URL` (a physical device needs a LAN IP in dev) | config | dummy |
| `EXPO_PUBLIC_CONVEX_SITE_URL` | `ios` | dev, prod | no (ships in bundle) | ios `src/lib/convex.ts:14` | as `VITE_CONVEX_SITE_URL` | config | dummy |

## Deploy-time credentials (not read by app code)

| Name | Unit | Envs | Secret? | Used by | Source | dev | prod |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CONVEX_DEPLOY_KEY` | `convex` | prod only | yes | `npx convex deploy` from CI / a release machine. **Not created in dev on purpose**: a deploy key in the environment overrides the CLI's deployment selection | external: [Convex](providers/convex.md) | `-` | dummy |
| `CLOUDFLARE_API_TOKEN` | `shared` | prod only | yes | `wrangler deploy` for `apps/web` (no CI yet) | external: [Cloudflare](providers/cloudflare.md) | `-` | dummy |
| `CLOUDFLARE_ACCOUNT_ID` | `shared` | prod only | no (identifier) | same | external: [Cloudflare](providers/cloudflare.md) | `-` | dummy |
| `CENTRAL_LICENSE_KEY` | `shared` | dev, prod | yes | install time: the `preinstall` license check of `@central-icons-react/*` (`apps/web`) reads it, and `pnpm install` fails without it. Needed wherever dependencies are installed (dev machines, deploy builds, and CI, where it comes from the Doppler `ci` environment, a reference to `prd`, synced to the GitHub Actions repository secret `CENTRAL_LICENSE_KEY`) | external: Central Icons license (centralicons.com) | dummy (`REPLACE_ME__CENTRAL_ICONS`) | missing: create in `prd` |

## Not in Doppler (and why)

| Name | Why |
| --- | --- |
| `CONVEX_CLOUD_URL`, `CONVEX_SITE_URL` | Built into every Convex deployment; never set by hand. |
| `CONVEX_DEPLOYMENT` (dev), `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY` | Per-developer deployment selection written by `convex dev` into the gitignored `apps/convex/.env.local`. A dummy here would override that. Add real values (dev) only once a shared dev deployment exists. |
| `UPSTASH_BOX_BASE_URL`, `UPSTASH_BOX_START_MODE` (`init`\|`exec`), `UPSTASH_BOX_NETWORK_POLICY` (`dorks`) | Optional Upstash Box tuning read by convex `lib/box.ts`; defaults are fine. Details in [docs/upstash-box.md](../upstash-box.md). Create in Doppler only when you change them. |
| `OTP_SEND_PER_EMAIL` (5), `OTP_SEND_PER_IP` (30), `OTP_SEND_GLOBAL` (100), `OTP_WINDOW_MS` (1h) | Optional sign-in-code rate limits (convex `auth.ts`); defaults in parentheses. Set on the Convex deployment only to change them. |
| `E2E_CLAUDE_TOKEN` (**in Doppler `dev`**, placeholder `REPLACE_ME__CLAUDE`) | A human puts a real token here (`claude setup-token`) so agents can run the real Claude CLI end to end: e2e takes it as the user's Claude token, and `CLAUDE_CODE_OAUTH_TOKEN=$E2E_CLAUDE_TOKEN pnpm --filter @dorks/bridge test live` runs the bridge live test. Deliberately not named `CLAUDE_CODE_OAUTH_TOKEN`, so it does not authenticate every `doppler run` process. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | Only read by tests (`infra/bridge`). The user's Claude token is a per-user value stored encrypted in the database, not a deploy secret. |
| `BRIDGE_*`, `DORKS_*`, `CLAUDE_*`, `FAKE_CLAUDE_*`, `GIT_*`, `CF_TOKEN`, `WEB_URL`, `CHROME_PATH` | Set inside the box by the bridge or by test/CI scripts. CI (`.github/workflows/ci.yml`) uses inline env only, no repo secrets. |
| `EXTRA_TRUSTED_ORIGINS` | Optional comma list of extra auth origins (convex `auth.ts:23`). Create in `convex` only when needed. |
| `RESEND_API_URL` | Dev/e2e override pointing Resend calls at the local mock (`apps/convex/scripts/mock-resend.mjs`). Set on the dev deployment only. |
| `SHOTS`, `SECRETS_OUT`, `DELTA_BATCH_MS`, `HEARTBEAT_MS`, `SIM_DELTAS`, `SIM_DELTA_GAP_MS`, `DORK_ID`, `BRIDGE_URL`, `BRIDGE_SECRET`, `CONVEX_URL` (scripts) | Test/sim script knobs and values derived at run time (e.g. `BRIDGE_SECRET` is `HMAC(BRIDGE_SECRET_KEY, dorkId)` handed to a box at creation). |
| `EXPO_OS` | Set by Expo itself. |
| EAS / App Store credentials | No `eas.json` or store config in the repo yet. Add a `ios` guide when iOS builds are set up. |
| `staging` environment | Not needed, see [README](README.md). |

## Gaps worth knowing

- `EXPO_ACCESS_TOKEN` is not consumed by any running code path yet (the push sender is planned). It is in the inventory so the shape is ready. `GITHUB_WEBHOOK_SECRET` is now consumed by the Convex webhook route. `UPSTASH_BOX_API_KEY` is no longer read by Convex (each user brings their own Upstash key).
