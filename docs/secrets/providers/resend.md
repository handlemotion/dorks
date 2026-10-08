# Resend (sign-in code email)

Provides: `RESEND_API_KEY` (`shared`, secret). Related config: `ALLOWED_EMAIL_DOMAIN` (`shared`), which is also the sender domain: mail goes out as `dorks <auth@<ALLOWED_EMAIL_DOMAIN>>` (`apps/convex/convex/mail.ts`).

Official docs (checked 2026-10-07): [API keys](https://www.resend.com/docs/create-an-api-key), [Add a domain](https://www.resend.com/docs/add-a-domain).

## Dev vs prod

Resend has no test/live key split. Use two keys in one team (or two teams): name them `dorks-dev` and `dorks-prod`, so each can be revoked alone. In dev you can skip Resend entirely: point the Convex dev deployment at the local mock (`RESEND_API_URL=http://127.0.0.1:8899/emails`, `apps/convex/scripts/mock-resend.mjs`) and keep the dummy key. The legacy api logs the OTP to its console when `RESEND_API_KEY` is empty, but a `REPLACE_ME__*` dummy is not empty, so it will try to send and fail.

## 1. Verify the sender domain (once, prod key needs it)

The sender domain is the root of `ALLOWED_EMAIL_DOMAIN` (`jaantonio.com`), because the code sends from `auth@jaantonio.com`. Resend recommends a subdomain; if you want one, change the code's `from` and the domain config together.

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

```sh
scripts/set-secret.sh prod RESEND_API_KEY   # prompts silently; commit secrets/.env.prod
```

Repeat with `dev` and the dev key if you want real mail in dev. Then set it on the Convex production deployment too ([Convex guide, step 4](convex.md)).
