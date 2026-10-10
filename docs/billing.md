# Billing: one flat $10/month for app access

Dorks charges a single flat subscription, $10 per month, for access to the app (a "hop in" fee). There is no metering and no compute in the price: users bring their own Claude token and (next layer) their own Upstash account, so the machines are billed to them directly by those providers. Test mode only until a human says otherwise (see "Going live").

Code: `core/billing.ts` (plan constants, webhook signature check, event parsing), `core/stripe.ts` (Stripe REST client), `core/stripeSetup.ts` (creates the Stripe product and price), `convex/billing.ts` (checkout, portal, status, webhook handling, gate), `convex/http.ts` (`POST /stripe/webhook`), `convex/crons.ts` (daily cleanup of old webhook event ids). Tests: `test/billing.test.ts`.

## How it works

- Stripe holds one **product** (tagged `dorks_key=dorks-app-access`) and one **price**: $10.00 USD, monthly, flat. The price has a **lookup key** (a stable label) that includes the amount, `dorks_app_monthly_1000`, so changing the price means a new key and `pnpm stripe:setup` refuses to silently reuse a price with a different amount. The amount is `APP_PRICE_CENTS` in `core/billing.ts`.
- `billing.checkout` (public action) creates the Stripe customer (one per user, idempotent) and a **Checkout** session (Stripe's hosted payment page) in subscription mode; it returns the page URL. After payment Stripe sends the user back to `SITE_URL/settings?billing=success` (or `=cancel`).
- `billing.portal` opens Stripe's **customer portal** (hosted page to change the card, see invoices, cancel).
- `billing.status` is the query for the settings screen: `configured`, `required`, `status`, `entitled`, `currentPeriodEnd`, `cancelAtPeriodEnd`. It carries no Stripe ids.
- The **webhook** (`POST /stripe/webhook`: Stripe calls our server when something changes) checks the signature over the raw body (5-minute replay window) and handles `customer.subscription.created/updated/deleted` and `checkout.session.completed`. Duplicate deliveries are dropped by event id, and an event about an older subscription than the one on file is ignored.
- **Entitled** = `active`, `trialing` or `past_due` (Stripe is still retrying the card). Anything else (`canceled`, `unpaid`, `incomplete`, ...) is not.
- **Gate:** `BILLING_REQUIRED=true` makes `dorks.create` fail with `onboarding_incomplete` ("subscribe to start a dork") for anyone not entitled. Default off, so nothing changes until you flip it. Existing dorks are not touched when a subscription ends.

## Set up (test mode)

1. Put a test-mode secret key in Doppler `dev` as `STRIPE_SECRET_KEY` (`sk_test_...`; a restricted key needs write access to Customers, Checkout Sessions, Subscriptions, Products, Prices, Customer portal, Webhook endpoints). Create the Customer portal settings once in the Stripe dashboard (test mode) if `billing.portal` complains.
2. `pnpm stripe:setup` creates (or finds) the product and price and stores `STRIPE_PRICE_ID` in Doppler `dev`. Add `-- --webhook-url https://<deployment>.convex.site/stripe/webhook` once a deployed backend exists; it stores `STRIPE_WEBHOOK_SECRET` (Stripe shows it only once).
3. `pnpm dev:backend` pushes the env to the local Convex backend.

## End-to-end test (real Stripe, nothing mocked)

`pnpm billing:e2e` (`scripts/billing-e2e.mjs`) drives our own Convex functions on the local backend against the real Stripe sandbox:

1. checks the price Stripe holds is $10.00 USD per month;
2. with `BILLING_REQUIRED=true`: `dorks.create` is refused before subscribing;
3. `billing.checkout` returns a real Checkout URL, the session is a $10 subscription, a real customer exists;
4. starts the subscription with a test card, Stripe charges the first invoice $10 (paid);
5. Stripe's real events reach `/stripe/webhook` and the user becomes entitled; `dorks.create` now works; `billing.portal` returns a real portal URL;
6. cancels the subscription: the user stops being entitled and `dorks.create` is refused again.

Webhooks cannot reach a local backend and the Stripe CLI cannot be installed in the cloud container, so the script forwards Stripe's real events to `/stripe/webhook` itself, signed with a throwaway secret (Stripe's own signing is covered by the unit tests). In cloud containers the Docker backend also has no internet route, so the script runs a small relay on the host and points the backend at it with `STRIPE_API_BASE_URL` (removed again at the end): the calls are still real Stripe calls. It cleans up its customer, env vars and dork. 13/13 pass as of 2026-10-10.

## History

The first version of this PR metered Upstash Box cost plus 15% through a Stripe Billing Meter. It worked end to end on real Stripe and real Upstash (a 240 s burn read $0.013282 and invoiced as 13282 units for 2 cents), but it was replaced by the flat plan: simpler, predictable for users, and no compute resale. That code is in git history (commits `dea9981`, `7b4bb61`).

## Going live

Not done, and it needs an explicit decision: a live key is refused by `core/stripe.ts` unless `STRIPE_ALLOW_LIVE=true`. To go live: create the live product and price with `stripe:setup` under a live key by hand, register the webhook endpoint at the production Convex site URL, set `STRIPE_*` in Doppler `prd`, then `pnpm push:convex-env`.
