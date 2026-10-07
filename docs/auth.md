# Auth setup (Convex backend)

Sign-in is email OTP via `@convex-dev/better-auth` (`apps/convex/convex/auth.ts`). Only addresses on `ALLOWED_EMAIL_DOMAIN` (default `jaantonio.com`) can request a code or create an account.

## Required Convex env

`createAuth` throws on the first auth request if either is missing, so a misconfigured deployment fails loudly instead of limping along.

| Variable | Why |
|---|---|
| `SITE_URL` | Web origin (e.g. `https://dorks.example.com`). Becomes a trusted origin and the cross-domain redirect target. Unset, it used to be silently dropped and web sign-in just failed. |
| `BETTER_AUTH_SECRET` | Signs sessions. Random hex. |
| `RESEND_API_KEY` | Mails the codes (`convex/mail.ts`). |
| `EXTRA_TRUSTED_ORIGINS` | Optional, comma separated. See below. |

## Resend sending domain

Codes are sent `from: dorks <auth@${ALLOWED_EMAIL_DOMAIN}>` (`convex/mail.ts`). Resend refuses to send unless that domain is verified in the Resend account (SPF/DKIM DNS records), so for `jaantonio.com` the domain `jaantonio.com` itself must be verified, not just any domain. A send from an unverified domain fails with a Resend 4xx and the user never gets a code.

## Expo Go on a device

The native app is trusted via the `dorks://` scheme. Expo Go instead runs under `exp://<lan-ip>:8081`, which better-auth rejects as an untrusted origin. For on-device dev, add it on the Convex deployment:

```
npx convex env set EXTRA_TRUSTED_ORIGINS "http://localhost:8081,exp://192.168.1.23:8081"
```

Use the address Metro prints. better-auth also matches wildcards, so `exp://192.168.*.*:*` should cover any LAN address (not tested here). Set this only on dev deployments: it widens the trusted origins, so never on production.

## Rate limits

Counters live in the `rateLimits` table (`convex/rateLimit.ts`; stale rows swept by `convex/crons.ts`), enforced in `hooks.before`. Better-auth's built-in limiter is memory-per-isolate and production-only, so it does nothing on Convex. Over the limit the response is `429` (`TOO_MANY_REQUESTS`).

| Budget (per hour) | Default | Env override |
|---|---|---|
| code sends per mailbox | 5 | `OTP_SEND_PER_EMAIL` |
| code sends per IP | 30 | `OTP_SEND_PER_IP` |
| code checks per mailbox | 10 | `OTP_VERIFY_PER_EMAIL` |
| window length (ms) | 3600000 | `OTP_WINDOW_MS` |

- A mailbox is the lowercased address with any `+tag` removed, so `a+1@` and `A+2@` share a budget with `a@`.
- Covered routes: `send-verification-otp`, `request-password-reset`, `/forget-password/email-otp` (these all mail a code) and `sign-in/email-otp`, `check-verification-otp`, `verify-email`, `reset-password` (these check one).
- The IP is the last hop of `x-forwarded-for`. Self-hosted Convex passes the header through unchanged and adds none, so the IP limit only works behind a proxy that sets it; Convex Cloud's behaviour has not been verified. The per-mailbox limits do not depend on it.
- `scripts/e2e.mjs` uses a fresh address per run and reads the caps from the same env names (set them in both places if you change them).
