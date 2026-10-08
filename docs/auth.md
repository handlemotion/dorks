# Auth setup (Convex backend)

Sign-in is email OTP via `@convex-dev/better-auth` (`apps/convex/convex/auth.ts`). Only addresses on `ALLOWED_EMAIL_DOMAIN` (default `jaantonio.com`) can request a code or create an account.

## Required Convex env

`http.ts` builds the auth when the module loads, so a missing `SITE_URL` or `BETTER_AUTH_SECRET` fails the **deploy** (`Failed to analyze http.js: SITE_URL is not set…`), including the first `convex dev` on a fresh project and preview deployments: set both before pushing. `createAuth` repeats the check per request as a backstop.

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

Counters live in the `rateLimits` table (`convex/rateLimit.ts`; stale rows swept by `convex/crons.ts`), enforced in `hooks.before`. Better-auth's built-in limiter is memory-per-isolate and production-only, so it does nothing on Convex. Over the limit the response is `429` (`TOO_MANY_REQUESTS`). Only code **sends** are limited:

| Send budget (per window) | Default | Env override |
|---|---|---|
| per mailbox | 5 / hour | `OTP_SEND_PER_EMAIL` |
| per IP (best effort) | 30 / hour | `OTP_SEND_PER_IP` |
| global, all callers | 100 / hour | `OTP_SEND_GLOBAL` |
| window length (ms, max 24 h) | 3600000 | `OTP_WINDOW_MS` |

- **Global** is the only budget a caller cannot dodge: it bounds Resend volume even when someone mails `rand-N@jaantonio.com` in a loop with spoofed or missing IP headers. Trade-off: that same caller can use the whole budget up and block everyone's sign-in until the window ends. Raise it if the team grows.
- **Per mailbox** is a mailbox, not a string: lowercased, `+tag` removed, so `a+1@` and `A+2@` share a budget with `a@`. Trade-off: anyone can spend a colleague's 5 sends and lock that colleague out of sign-in for up to an hour.
- **Per IP** is best effort. The IP is the last hop of `x-forwarded-for`. Self-hosted Convex passes the header through unchanged and adds none, so a caller controls it there; **Convex Cloud's behaviour has not been verified** (it may add nothing, or append one shared proxy address, which would put every user in one budget). Do not rely on it.
- **Code checks are not rate limited.** Better-auth voids a code after 3 wrong guesses and each new code needs a (limited) send, so guessing is already bounded; a check cap would only enable lockouts.
- Covered send routes: `send-verification-otp`, `request-password-reset`, `/forget-password/email-otp` (password-reset routes mail a code to any existing user too). All code routes, including checks, also get the allowed-domain check.

### Tests and CI

`scripts/run-e2e.sh` clears the counters (`npx convex run rateLimit:reset`, an internal function) before it starts, and `e2e.mjs` / `web-e2e.mjs` use a fresh address per run, so reruns on one backend do not hit a cap. One `e2e.mjs` run spends about 40 of the 100 global sends; calling it directly more than twice an hour without the reset can hit `OTP_SEND_GLOBAL`. If you change a cap, set the same env name on the deployment and in the shell running the e2e.
