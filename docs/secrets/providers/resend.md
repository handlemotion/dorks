# Resend (sign-in code email)

Provides: `RESEND_API_KEY` (`shared`, secret). Mail goes out as `dorks <auth@dorks.build>` (hard-coded in `apps/convex/convex/mail.ts`).

Official docs (checked 2026-10-07): [API keys](https://www.resend.com/docs/create-an-api-key), [Add a domain](https://www.resend.com/docs/add-a-domain).

## Dev vs prod

Resend has no test/live key split. Use two keys in one team (or two teams): name them `dorks-dev` and `dorks-prod`, so each can be revoked alone. In dev you can skip Resend entirely: point the Convex dev deployment at the local mock (`RESEND_API_URL=http://127.0.0.1:8899/emails`, `apps/convex/scripts/mock-resend.mjs`) and keep the dummy key. The legacy api logs the OTP to its console when `RESEND_API_KEY` is empty, but a `REPLACE_ME__*` dummy is not empty, so it will try to send and fail.

## 1. Verify the sender domain (once, prod key needs it)

The sender domain is `dorks.build` itself, because the code sends from `auth@dorks.build`. Resend recommends a subdomain; if you want one, change the `from` in `mail.ts`.

1. Resend dashboard -> **Domains** (https://resend.com/domains) -> **Add Domain**.
2. Enter the domain, pick the region closest to recipients, optionally set a custom Return-Path subdomain (defaults to `send`).
3. Copy the DKIM and SPF records from the **Records** tab into the DNS provider, exactly as shown. If the DNS host proxies records (Cloudflare orange cloud), set the record to **DNS only**, otherwise verification never completes.
4. Wait for **Verified** (often ~15 min, up to 72 h; **Restart verification** after that). Add a DMARC record afterwards.

## 2. Create the API key

1. Dashboard -> **API Keys** (https://resend.com/api-keys) -> create a new key.
2. Name: `dorks-prod` (or `dorks-dev`), max 50 chars.
3. Permission: **Sending access** (the app only sends mail). Do not use Full access.
4. Domain: restrict to the verified domain.
5. Copy the key now; Resend shows it once.

## 3. Insert

In the Doppler dashboard: project `dorks` -> `prd` -> `RESEND_API_KEY` -> paste -> Save. Repeat in `dev` if you want real mail in dev (or ask an agent to run `doppler secrets set RESEND_API_KEY -p dorks -c dev` after you paste the value into the prompt yourself). Then push it to the Convex production deployment ([Convex guide, step 4](convex.md)).
