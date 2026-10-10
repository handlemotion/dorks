# Billing: Upstash Box cost + 15%, metered through Stripe

Customers pay for what their sandboxes cost us at Upstash, plus a 15% markup, on a monthly Stripe subscription with no fixed fee. Test mode only until a human says otherwise (see "Going live").

Code: `core/billing.ts` (pricing and webhook math), `core/stripe.ts` (Stripe REST client), `core/stripeSetup.ts` (creates the Stripe objects), `convex/billing.ts` (checkout, webhook, metering), `convex/http.ts` (`POST /stripe/webhook`), `convex/crons.ts` (metering every 10 minutes). Tests: `test/billing.test.ts`.

## How the 15% works

- Upstash's box API returns a running total for every box: `total_compute_cost_usd` (what Upstash bills us for that box's CPU, see `GET /v2/box/{id}` in [upstash-box.md](upstash-box.md)). It only grows.
- Every 10 minutes a cron (`billing.meterAll`) reads it for every box, works out how much it grew since the last time, and sends that to a **Stripe Billing Meter** (a Stripe object that adds up usage events per customer) as a whole number of **micro-dollars** (1 unit = $0.000001 of Upstash cost).
- The Stripe **price** charges `0.000115` cents per unit. That is 0.0001 cents (one micro-dollar) times 1.15, so the invoice line is exactly Upstash cost + 15%, and the invoice shows the raw cost as the line's quantity. Stripe rounds each invoice line to a whole cent.
- The markup lives in the Stripe price. Changing it means a new price (`MARKUP_BPS` in `core/billing.ts`, 1 bp = 0.01%, also changes the price lookup key, and `pnpm stripe:setup` refuses to reuse a price with a different amount).

## Never double counted, never lost

The ledger is the `boxUsage` table, one row per box: `costMicro` (last cost seen), `reportedMicro` (already sent), `inflightTo` (a window being sent). Before sending, the window `(reportedMicro, inflightTo]` is written down, and it is sent with the Stripe identifier `<boxId>:<from>-<to>`. Stripe ignores a repeated identifier, and a retry always reuses the stored window, so a crash between "sent" and "marked sent" can only repeat the same event. When a dork is deleted, its box is read one last time before the delete (`boxes.destroy`).

## Subscriptions

- `billing.checkout` (public action) creates the Stripe customer (one per user, idempotent) and a Checkout session for the metered price; returns the hosted page URL. `billing.portal` opens Stripe's customer portal (card, invoices, cancel). `billing.status` is the query for the settings screen.
- The webhook (`POST /stripe/webhook`, signature checked over the raw body, replay window 5 minutes) handles `customer.subscription.created/updated/deleted` and `checkout.session.completed`, and keeps `billing.status` in step. Duplicate deliveries are dropped by event id.
- Entitled = `active`, `trialing` or `past_due` (Stripe is still retrying the card). Anything else is not billed.
- **Product decisions I made (change freely):**
  1. Usage that accrues while a user has no entitled subscription is **forgiven**, not billed later (the ledger skips past it on the first pass after subscribing).
  2. `BILLING_REQUIRED=true` makes `dorks.create` refuse users without an entitled subscription. Default off, so nothing changes until you flip it.

## Set up (test mode)

1. Put a test-mode secret key in Doppler `dev` as `STRIPE_SECRET_KEY` (`sk_test_...`; a restricted key needs write access to Customers, Checkout Sessions, Subscriptions, Billing meters and meter events, Products, Prices, Customer portal, Webhook endpoints, Test clocks).
2. `pnpm stripe:setup` creates (or finds) the meter, product and price, and stores `STRIPE_PRICE_ID` in Doppler `dev`. Add `-- --webhook-url https://<deployment>.convex.site/stripe/webhook` once a deployed backend exists; it stores `STRIPE_WEBHOOK_SECRET` (Stripe shows it only once).
3. `pnpm dev:backend` pushes the env to the local Convex backend.

## End-to-end tests (real services, nothing mocked)

- `pnpm stripe:e2e` (`scripts/stripe-e2e.mjs`): creates a real Upstash box, burns both CPU cores, reads the box's own cost, deletes the box; puts a Stripe test customer on a **test clock** (Stripe's way of fast-forwarding time) with a test card and the metered subscription; sends the cost to the meter exactly like `billing.ts`; advances the clock; checks the invoice line is `round(cost x 1.15)` cents with the raw cost as quantity. Costs a few cents of Upstash compute. Both pass as of 2026-10-10 (10/10 checks in `billing:e2e`).
- `pnpm billing:e2e` (`scripts/billing-e2e.mjs`): drives our own Convex functions on the local backend against real Stripe: sign in, `billing.checkout` (real customer and Checkout session), subscription, webhook, metering through the real cron action, no double counting, nothing billed after cancel. The box's cost figure is set by hand there (the local backend uses the simulated box provider); the real figure is covered by `stripe:e2e`. Webhooks cannot reach a local backend, and the Stripe CLI cannot be installed in the cloud container, so the script forwards Stripe's real events to `/stripe/webhook` itself, signed with a throwaway secret. In cloud containers the Docker backend also has no internet route, so the script runs a small relay on the host and points the backend at it with `STRIPE_API_BASE_URL` (removed again at the end): the calls are still real Stripe calls.

## What the first real runs showed (2026-10-10, Stripe sandbox + a real Upstash Small box)

- `total_compute_cost_usd` is CPU only: 2 cores busy for 240s read $0.013282, which is exactly 480 core-seconds at $0.10 per core-hour. **Storage ($0.10 per GB-month, including snapshots) is not in it, so it is not billed to customers yet.** Decide whether to pass it through (it would need its own meter, since Upstash gives no per-box storage figure).
- A repeated meter-event identifier is rejected by Stripe with `HTTP 400: An event already exists with identifier ...`; `billing.ts` treats that as "already counted". The meter still read the original amount afterwards.
- The invoice line read `13282 x Dorks sandbox usage (at $0.00000115 / month)` for 2 cents: 1.328 cents x 1.15 = 1.527 cents, rounded by Stripe. Each invoice line rounds to a whole cent, so a customer with under half a cent of usage in a month is billed nothing.
- `total_token_cost_usd` is ignored on purpose: dorks runs the customer's own Claude token, not Upstash's built-in LLM.

## Going live

Not done, and it needs an explicit decision: a live key is refused by `core/stripe.ts` unless `STRIPE_ALLOW_LIVE=true`; create the live meter/product/price with `stripe:setup` under a `prd` key by hand, register the webhook endpoint at the production Convex site URL, set `STRIPE_*` in Doppler `prd`, then `pnpm push:convex-env`.
