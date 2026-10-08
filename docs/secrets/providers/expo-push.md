# Expo push notifications

Provides: `EXPO_ACCESS_TOKEN` (`shared`, secret). **Optional and not used by running code yet**: push sending is planned (a Convex push action is planned).

Official docs (checked 2026-10-07): [Sending notifications / enhanced push security](https://docs.expo.dev/push-notifications/sending-notifications/), [Programmatic access (tokens)](https://docs.expo.dev/accounts/programmatic-access).

## What it does

If you enable **enhanced push security**, the push API rejects any request without a valid access token (`UNAUTHORIZED`). With it off, the token is not needed. Use it from `expo-server-sdk-node` >= 3.6.0 (`accessToken` option) or as `Authorization: Bearer <token>`.

## Dev vs prod

Expo accounts are not split into test/live. Use one token per environment (`dorks-dev`, `dorks-prod`) so you can revoke independently; note that **enabling enhanced security applies to the Expo project's push traffic**, so turn it on only once every sender has a token.

## Steps

1. Sign in at https://expo.dev, open https://expo.dev/settings/access-tokens, create an access token (prefer a robot/organization token over a personal one so it outlives people).
2. Enable enhanced push security from the EAS dashboard (the docs link to the access-tokens page for this; the exact toggle label was not confirmed).
3. Insert:
   In the Doppler dashboard, `dorks` -> `prd`: set `EXPO_ACCESS_TOKEN`.
